"""
Stem Splitter - Backend local
---------------------------------
Servidor FastAPI que envuelve Demucs para separar canciones en pistas.

Seguridad:
- Escucha SOLO en 127.0.0.1 (tu propia PC). Nadie en tu red ni en internet puede acceder.
- CORS limitado al frontend local (localhost:3000).
- Valida extension y tamano del archivo; los guarda con nombres aleatorios (UUID),
  nunca con el nombre original, para evitar rutas maliciosas.
- Las pistas solo se sirven desde nombres validados (no se aceptan rutas arbitrarias).
- Procesa una cancion a la vez para no saturar la GPU.
"""

import re
import shutil
import threading
import uuid
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Literal

import torch
import uvicorn
from demucs.api import Separator, save_audio
from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse

# ---------------------------------------------------------------------------
# Configuracion
# ---------------------------------------------------------------------------
BASE_DIR = Path(__file__).resolve().parent
UPLOAD_DIR = BASE_DIR / "data" / "uploads"
OUTPUT_DIR = BASE_DIR / "data" / "output"
UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

ALLOWED_EXTENSIONS = {".mp3", ".wav", ".flac", ".m4a", ".ogg"}
MAX_FILE_SIZE = 200 * 1024 * 1024  # 200 MB
CHUNK_SIZE = 1024 * 1024  # 1 MB

MODELS: dict[str, list[str]] = {
    "htdemucs_6s": ["vocals", "drums", "bass", "guitar", "piano", "other", "instrumental"],
    "htdemucs": ["vocals", "drums", "bass", "other", "instrumental"],
}

# Nombres en espanol para los archivos descargados
STEM_NAMES_ES = {
    "vocals": "Voz",
    "drums": "Batería",
    "bass": "Bajo",
    "guitar": "Guitarra",
    "piano": "Piano",
    "other": "Otros",
    "instrumental": "Instrumental",
}

DEVICE = "cuda" if torch.cuda.is_available() else "cpu"

HOST = "127.0.0.1"  # NO cambiar a 0.0.0.0: eso expondria el servidor a tu red
PORT = 8000

# ---------------------------------------------------------------------------
# App
# ---------------------------------------------------------------------------
app = FastAPI(title="Stem Splitter API", version="0.1.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3000", "http://127.0.0.1:3000"],
    allow_methods=["GET", "POST", "DELETE"],
    allow_headers=["*"],
)

# Trabajos en memoria (se pierden al reiniciar el servidor; suficiente para el MVP)
jobs: dict[str, dict] = {}
jobs_lock = threading.Lock()

# Un solo worker: una separacion a la vez en la GPU
executor = ThreadPoolExecutor(max_workers=1)


# ---------------------------------------------------------------------------
# Utilidades
# ---------------------------------------------------------------------------
def update_job(job_id: str, **fields) -> None:
    with jobs_lock:
        if job_id in jobs:
            jobs[job_id].update(fields)


def get_job_or_404(job_id: str) -> dict:
    try:
        uuid.UUID(job_id)
    except ValueError:
        raise HTTPException(status_code=404, detail="Trabajo no encontrado")
    with jobs_lock:
        job = jobs.get(job_id)
        if job is None:
            raise HTTPException(status_code=404, detail="Trabajo no encontrado")
        return dict(job)


def safe_song_name(filename: str | None) -> str:
    """Nombre de la cancion sin extension, sin caracteres prohibidos en Windows."""
    name = Path(filename or "").stem
    name = re.sub(r'[<>:"/\\|?*\x00-\x1f]', "", name).strip(" .")
    return name[:150] or "cancion"


def make_progress_callback(job_id: str):
    def callback(info: dict) -> None:
        length = info.get("audio_length") or 0
        offset = info.get("segment_offset") or 0
        if length:
            update_job(job_id, progress=min(99, int(offset / length * 100)))

    return callback


# ---------------------------------------------------------------------------
# Procesamiento (corre en segundo plano)
# ---------------------------------------------------------------------------
def process_job(job_id: str, input_path: Path, model: str) -> None:
    update_job(job_id, status="processing", progress=0)
    try:
        separator = Separator(
            model=model,
            device=DEVICE,
            progress=False,
            callback=make_progress_callback(job_id),
        )
        _, separated = separator.separate_audio_file(input_path)

        out_dir = OUTPUT_DIR / job_id
        out_dir.mkdir(parents=True, exist_ok=True)
        for stem, tensor in separated.items():
            save_audio(tensor, str(out_dir / f"{stem}.wav"), samplerate=separator.samplerate)

        # Pista "instrumental": toda la cancion sin la voz (suma de las demas pistas)
        instrumental = sum(t for s, t in separated.items() if s != "vocals")
        save_audio(instrumental, str(out_dir / "instrumental.wav"), samplerate=separator.samplerate)

        stems = sorted(separated.keys()) + ["instrumental"]
        update_job(job_id, status="done", progress=100, stems=stems)
    except Exception as exc:  # noqa: BLE001
        update_job(job_id, status="error", error=str(exc))
    finally:
        input_path.unlink(missing_ok=True)  # borrar la cancion original subida
        if DEVICE == "cuda":
            torch.cuda.empty_cache()


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------
@app.get("/health")
def health():
    return {
        "status": "ok",
        "device": DEVICE,
        "gpu": torch.cuda.get_device_name(0) if DEVICE == "cuda" else None,
        "models": MODELS,
    }


@app.post("/separate")
async def separate(
    file: UploadFile = File(...),
    model: Literal["htdemucs_6s", "htdemucs"] = Form("htdemucs_6s"),
):
    ext = Path(file.filename or "").suffix.lower()
    if ext not in ALLOWED_EXTENSIONS:
        raise HTTPException(
            status_code=400,
            detail=f"Formato no permitido. Usa: {', '.join(sorted(ALLOWED_EXTENSIONS))}",
        )

    job_id = str(uuid.uuid4())
    input_path = UPLOAD_DIR / f"{job_id}{ext}"

    # Guardar por partes, cortando si supera el limite
    size = 0
    try:
        with input_path.open("wb") as f:
            while chunk := await file.read(CHUNK_SIZE):
                size += len(chunk)
                if size > MAX_FILE_SIZE:
                    raise HTTPException(status_code=413, detail="Archivo demasiado grande (max 200 MB)")
                f.write(chunk)
    except HTTPException:
        input_path.unlink(missing_ok=True)
        raise
    finally:
        await file.close()

    if size == 0:
        input_path.unlink(missing_ok=True)
        raise HTTPException(status_code=400, detail="El archivo esta vacio")

    with jobs_lock:
        jobs[job_id] = {
            "job_id": job_id,
            "filename": file.filename,
            "model": model,
            "status": "queued",
            "progress": 0,
            "stems": [],
            "error": None,
        }

    executor.submit(process_job, job_id, input_path, model)
    return {"job_id": job_id, "status": "queued"}


@app.get("/status/{job_id}")
def status(job_id: str):
    return get_job_or_404(job_id)


@app.get("/stems/{job_id}/{stem}")
def get_stem(job_id: str, stem: str):
    job = get_job_or_404(job_id)
    if job["status"] != "done":
        raise HTTPException(status_code=409, detail="El trabajo aun no termina")
    if stem not in job["stems"]:
        raise HTTPException(status_code=404, detail="Pista no encontrada")

    path = OUTPUT_DIR / job_id / f"{stem}.wav"
    if not path.is_file():
        raise HTTPException(status_code=404, detail="Archivo no encontrado")
    download_name = f"{safe_song_name(job['filename'])} ({STEM_NAMES_ES.get(stem, stem)}).wav"
    return FileResponse(path, media_type="audio/wav", filename=download_name)


@app.delete("/jobs/{job_id}")
def delete_job(job_id: str):
    job = get_job_or_404(job_id)
    if job["status"] in ("queued", "processing"):
        raise HTTPException(status_code=409, detail="No se puede borrar mientras se procesa")

    shutil.rmtree(OUTPUT_DIR / job_id, ignore_errors=True)
    with jobs_lock:
        jobs.pop(job_id, None)
    return {"deleted": job_id}


if __name__ == "__main__":
    print(f"Dispositivo: {DEVICE}")
    uvicorn.run(app, host=HOST, port=PORT)
