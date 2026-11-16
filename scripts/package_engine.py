"""
Empaqueta un motor de Stemly (backend compilado con PyInstaller) para publicarlo.

Uso (desde la raíz del repo):
    python scripts/package_engine.py --variant gpu --src backend/dist-gpu/stemly-backend --version 0.1.0
    python scripts/package_engine.py --variant cpu --src backend/dist-cpu/stemly-backend --version 0.1.0

Qué hace:
  1. Copia ffmpeg.exe y ffprobe.exe (del PATH) junto al motor.
  2. Comprime todo en stemly-engine-<variant>-<version>.zip
  3. Si el zip supera el tamaño máximo por archivo de GitHub, lo parte en .001, .002, ...
  4. Calcula el SHA-256 de cada parte y del zip completo.
  5. Actualiza release/engines.json, que la app lee para saber qué descargar.

Usa solo la biblioteca estándar de Python.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import shutil
import sys
import time
import zipfile
from pathlib import Path

DEFAULT_PART_SIZE = 1_900_000_000  # bajo el límite de 2 GiB por archivo de GitHub Releases
CHUNK = 8 * 1024 * 1024

FFMPEG_NOTICE = """\
Este motor incluye FFmpeg (ffmpeg.exe y ffprobe.exe).

FFmpeg es software libre: https://ffmpeg.org
El build incluido proviene de https://www.gyan.dev/ffmpeg/builds/ y se distribuye
bajo la licencia GNU GPL v3. El código fuente de FFmpeg está disponible en
https://ffmpeg.org/download.html y en https://github.com/FFmpeg/FFmpeg

Stemly no modifica FFmpeg; solo lo ejecuta como programa externo.
"""


def human(n: float) -> str:
    for unit in ("B", "KB", "MB", "GB"):
        if n < 1024 or unit == "GB":
            return f"{n:.1f} {unit}" if unit != "B" else f"{int(n)} B"
        n /= 1024
    return f"{n:.1f} GB"


def sha256_of(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        while block := f.read(CHUNK):
            h.update(block)
    return h.hexdigest()


def find_ffmpeg_tools() -> dict[str, Path]:
    tools = {}
    for name in ("ffmpeg", "ffprobe"):
        found = shutil.which(name)
        if not found:
            sys.exit(f"ERROR: no encontré {name} en el PATH. Instalalo con: winget install Gyan.FFmpeg")
        tools[name] = Path(found).resolve()  # resolve(): winget instala accesos directos
    return tools


def make_zip(src: Path, zip_path: Path, variant: str, version: str, tools: dict[str, Path]) -> int:
    files = [p for p in src.rglob("*") if p.is_file()]
    total = sum(p.stat().st_size for p in files) + sum(t.stat().st_size for t in tools.values())
    done = 0
    last_print = 0.0

    def progress(extra: int) -> None:
        nonlocal done, last_print
        done += extra
        now = time.time()
        if now - last_print > 1 or done == total:
            print(f"\r  Comprimiendo… {done / total * 100:5.1f}%  ({human(done)} de {human(total)})", end="", flush=True)
            last_print = now

    with zipfile.ZipFile(zip_path, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=6, allowZip64=True) as zf:
        for p in files:
            zf.write(p, p.relative_to(src).as_posix())
            progress(p.stat().st_size)
        for name, path in tools.items():
            zf.write(path, f"{name}.exe")
            progress(path.stat().st_size)
        zf.writestr("LICENSE-FFmpeg.txt", FFMPEG_NOTICE)
        zf.writestr(
            "engine.json",
            json.dumps({"name": "stemly-engine", "variant": variant, "version": version}, indent=2),
        )
    print()
    return total


def split(zip_path: Path, part_size: int) -> list[Path]:
    size = zip_path.stat().st_size
    if size <= part_size:
        return [zip_path]
    parts = []
    with zip_path.open("rb") as f:
        index = 1
        while True:
            part = zip_path.with_name(f"{zip_path.name}.{index:03d}")
            written = 0
            with part.open("wb") as out:
                while written < part_size and (block := f.read(min(CHUNK, part_size - written))):
                    out.write(block)
                    written += len(block)
            if written == 0:
                part.unlink()
                break
            parts.append(part)
            index += 1
    return parts


def main() -> None:
    parser = argparse.ArgumentParser(description="Empaqueta un motor de Stemly para publicarlo")
    parser.add_argument("--variant", required=True, choices=["gpu", "cpu"])
    parser.add_argument("--src", required=True, type=Path, help="Carpeta del motor (contiene stemly-backend.exe)")
    parser.add_argument("--version", required=True, help="Versión del motor, ej. 0.1.0")
    parser.add_argument("--out", type=Path, default=Path("release"))
    parser.add_argument("--part-size-mb", type=int, default=0, help="Tamaño máximo por parte (solo para pruebas)")
    args = parser.parse_args()

    src: Path = args.src
    if not (src / "stemly-backend.exe").is_file():
        sys.exit(f"ERROR: no encuentro stemly-backend.exe en {src}")
    part_size = args.part_size_mb * 1024 * 1024 if args.part_size_mb else DEFAULT_PART_SIZE

    out: Path = args.out
    out.mkdir(parents=True, exist_ok=True)
    base = f"stemly-engine-{args.variant}-{args.version}.zip"
    zip_path = out / base

    # Borrar restos de un empaquetado anterior de esta misma variante y versión
    for old in out.glob(f"{base}*"):
        old.unlink()

    print(f"Motor {args.variant.upper()} {args.version}")
    tools = find_ffmpeg_tools()
    print(f"  FFmpeg: {tools['ffmpeg']}")
    unpacked = make_zip(src, zip_path, args.variant, args.version, tools)

    print("  Calculando huella del zip completo…")
    zip_size = zip_path.stat().st_size
    zip_sha = sha256_of(zip_path)

    parts = split(zip_path, part_size)
    if parts != [zip_path]:
        zip_path.unlink()  # se publican solo las partes
    part_info = [{"name": p.name, "size": p.stat().st_size, "sha256": sha256_of(p)} for p in parts]

    manifest_path = out / "engines.json"
    manifest = json.loads(manifest_path.read_text("utf-8")) if manifest_path.is_file() else {}
    manifest.setdefault("engines", {})[args.variant] = {
        "version": args.version,
        "file": base,
        "size": zip_size,
        "sha256": zip_sha,
        "unpacked_size": unpacked,
        "parts": part_info,
    }
    manifest_path.write_text(json.dumps(manifest, indent=2, ensure_ascii=False) + "\n", "utf-8")

    print(f"\nListo: {human(unpacked)} → {human(zip_size)} comprimido, en {len(parts)} archivo(s):")
    for p in part_info:
        print(f"  {p['name']}  {human(p['size'])}")
    print(f"Manifiesto actualizado: {manifest_path}")


if __name__ == "__main__":
    main()
