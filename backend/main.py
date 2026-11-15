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

import os
import re
import shutil
import subprocess
import threading
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Literal

import torch
import uvicorn
from demucs.api import Separator, save_audio
from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field
from starlette.background import BackgroundTask

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

# Formatos de descarga (la conversion la hace FFmpeg)
AudioFormat = Literal["wav", "mp3", "flac"]
FORMATS: dict[str, dict] = {
    "wav": {"codec": ["-c:a", "pcm_s16le"], "media_type": "audio/wav"},
    "mp3": {"codec": ["-c:a", "libmp3lame", "-b:a", "320k"], "media_type": "audio/mpeg"},
    "flac": {"codec": ["-c:a", "flac"], "media_type": "audio/flac"},
}
FFMPEG = shutil.which("ffmpeg")
FFMPEG_TIMEOUT_SECONDS = 300

HOST = "127.0.0.1"  # NO cambiar a 0.0.0.0: eso expondria el servidor a tu red
PORT = 8000

# Limpieza automatica: un trabajo terminado se borra si nadie lo usa durante este tiempo.
# La interfaz avisa cada 5 minutos que sigue abierta, asi que solo se borran los abandonados.
JOB_TTL_SECONDS = 30 * 60  # 30 minutos sin uso
CLEANUP_INTERVAL_SECONDS = 5 * 60  # revisar cada 5 minutos


# ---------------------------------------------------------------------------
# Limpieza de disco
# ---------------------------------------------------------------------------
def wipe_data_dirs() -> None:
    """Al arrancar, borra todo lo que quedo de sesiones anteriores.

    Los trabajos viven en memoria, asi que tras reiniciar el servidor las carpetas
    viejas ya no pertenecen a ningun trabajo y solo ocupan espacio.
    """
    removed = 0
    for directory in (UPLOAD_DIR, OUTPUT_DIR):
        for item in directory.iterdir():
            if item.is_dir():
                shutil.rmtree(item, ignore_errors=True)
            else:
                item.unlink(missing_ok=True)
            removed += 1
    if removed:
        print(f"Limpieza inicial: {removed} elemento(s) de sesiones anteriores borrados")


def cleanup_expired_jobs() -> None:
    """Borra los trabajos terminados que llevan mas de JOB_TTL_SECONDS sin uso."""
    now = time.time()
    with jobs_lock:
        expired = [
            job_id
            for job_id, job in jobs.items()
            if job["status"] in ("done", "error") and now - job["last_access"] > JOB_TTL_SECONDS
        ]
        for job_id in expired:
            jobs.pop(job_id, None)
    for job_id in expired:
        shutil.rmtree(OUTPUT_DIR / job_id, ignore_errors=True)
    if expired:
        print(f"Limpieza automatica: {len(expired)} trabajo(s) sin uso borrados")


def cleanup_loop(stop: threading.Event) -> None:
    while not stop.wait(CLEANUP_INTERVAL_SECONDS):
        try:
            cleanup_expired_jobs()
        except Exception as exc:  # noqa: BLE001
            print(f"Error en la limpieza automatica: {exc}")


@asynccontextmanager
async def lifespan(_app: FastAPI):
    wipe_data_dirs()
    stop = threading.Event()
    threading.Thread(target=cleanup_loop, args=(stop,), daemon=True).start()
    yield
    stop.set()


# ---------------------------------------------------------------------------
# App
# ---------------------------------------------------------------------------
app = FastAPI(title="Stem Splitter API", version="0.1.0", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:3000",  # desarrollo (npm run dev)
        "http://127.0.0.1:3000",
        "http://tauri.localhost",  # app de escritorio en Windows
        "https://tauri.localhost",
        "tauri://localhost",  # app de escritorio en macOS/Linux
    ],
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
        job["last_access"] = time.time()  # cualquier consulta cuenta como "en uso"
        result = dict(job)
    result.pop("last_access", None)  # dato interno, no se envia a la interfaz
    return result


def safe_song_name(filename: str | None) -> str:
    """Nombre de la cancion sin extension, sin caracteres prohibidos en Windows."""
    name = Path(filename or "").stem
    name = re.sub(r'[<>:"/\\|?*\x00-\x1f]', "", name).strip(" .")
    return name[:150] or "cancion"


def run_ffmpeg(args: list[str], output: Path) -> None:
    """Ejecuta FFmpeg escribiendo a un archivo temporal y lo renombra al terminar.

    Asi nunca queda un archivo a medio escribir si algo falla o si dos pedidos
    convierten lo mismo a la vez.
    """
    if not FFMPEG:
        raise HTTPException(
            status_code=500,
            detail="FFmpeg no esta instalado. Instalalo con: winget install Gyan.FFmpeg",
        )
    tmp = output.with_name(f".tmp-{uuid.uuid4().hex}{output.suffix}")
    try:
        result = subprocess.run(
            [FFMPEG, "-y", "-hide_banner", "-loglevel", "error", *args, str(tmp)],
            capture_output=True,
            text=True,
            timeout=FFMPEG_TIMEOUT_SECONDS,
        )
        if result.returncode != 0:
            raise HTTPException(status_code=500, detail=f"Error al convertir: {result.stderr.strip()[:300]}")
        os.replace(tmp, output)
    except subprocess.TimeoutExpired:
        raise HTTPException(status_code=500, detail="La conversion tardo demasiado")
    finally:
        tmp.unlink(missing_ok=True)


def stem_file(job_id: str, stem: str, fmt: str) -> Path:
    """Devuelve la pista en el formato pedido, convirtiendola la primera vez (queda en cache)."""
    wav = OUTPUT_DIR / job_id / f"{stem}.wav"
    if not wav.is_file():
        raise HTTPException(status_code=404, detail="Archivo no encontrado")
    if fmt == "wav":
        return wav
    converted = OUTPUT_DIR / job_id / f"{stem}.{fmt}"
    if not converted.is_file():
        run_ffmpeg(["-i", str(wav), *FORMATS[fmt]["codec"]], converted)
    return converted


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
        "ffmpeg": FFMPEG is not None,
        "formats": list(FORMATS),
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
            "last_access": time.time(),
        }

    executor.submit(process_job, job_id, input_path, model)
    return {"job_id": job_id, "status": "queued"}


@app.get("/status/{job_id}")
def status(job_id: str):
    return get_job_or_404(job_id)


@app.get("/stems/{job_id}/{stem}")
def get_stem(job_id: str, stem: str, format: AudioFormat = "wav"):  # noqa: A002
    job = get_job_or_404(job_id)
    if job["status"] != "done":
        raise HTTPException(status_code=409, detail="El trabajo aun no termina")
    if stem not in job["stems"]:
        raise HTTPException(status_code=404, detail="Pista no encontrada")

    path = stem_file(job_id, stem, format)
    download_name = f"{safe_song_name(job['filename'])} ({STEM_NAMES_ES.get(stem, stem)}).{format}"
    return FileResponse(path, media_type=FORMATS[format]["media_type"], filename=download_name)


class MixRequest(BaseModel):
    gains: dict[str, float] = Field(description="Volumen de cada pista, de 0 a 1")
    format: AudioFormat = "wav"


@app.post("/mix/{job_id}")
def mix(job_id: str, body: MixRequest):
    """Mezcla las pistas con el volumen indicado y devuelve un solo archivo."""
    job = get_job_or_404(job_id)
    if job["status"] != "done":
        raise HTTPException(status_code=409, detail="El trabajo aun no termina")

    mixable = [s for s in job["stems"] if s != "instrumental"]
    for stem, gain in body.gains.items():
        if stem not in mixable:
            raise HTTPException(status_code=400, detail=f"Pista no valida: {stem}")
        if not 0 <= gain <= 1:
            raise HTTPException(status_code=400, detail="El volumen debe estar entre 0 y 1")

    active = [(s, g) for s, g in body.gains.items() if g > 0]
    if not active:
        raise HTTPException(status_code=400, detail="Todas las pistas estan en silencio")

    inputs: list[str] = []
    chains: list[str] = []
    for i, (stem, gain) in enumerate(active):
        wav = OUTPUT_DIR / job_id / f"{stem}.wav"
        if not wav.is_file():
            raise HTTPException(status_code=404, detail="Archivo no encontrado")
        inputs += ["-i", str(wav)]
        chains.append(f"[{i}:a]volume={gain:.4f}[a{i}]")
    labels = "".join(f"[a{i}]" for i in range(len(active)))
    # normalize=0: suma sin bajar el volumen; alimiter evita que sature al sumar
    graph = ";".join(chains) + (
        f";{labels}amix=inputs={len(active)}:normalize=0:duration=longest,"
        "alimiter=limit=0.98:level=0[out]"
    )

    output = OUTPUT_DIR / job_id / f"mix-{uuid.uuid4().hex}.{body.format}"
    run_ffmpeg([*inputs, "-filter_complex", graph, "-map", "[out]", *FORMATS[body.format]["codec"]], output)

    return FileResponse(
        output,
        media_type=FORMATS[body.format]["media_type"],
        filename=f"{safe_song_name(job['filename'])} (Mezcla).{body.format}",
        background=BackgroundTask(output.unlink, missing_ok=True),  # se borra tras enviarla
    )


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
