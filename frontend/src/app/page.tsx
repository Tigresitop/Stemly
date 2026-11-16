"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Download, RotateCcw, Upload } from "lucide-react";
import { toast } from "sonner";

import { Logo } from "@/components/logo";
import { EngineGate, useEngine } from "@/components/engine-gate";
import { ExternalLink } from "@/components/external-link";
import { StemMixer } from "@/components/stem-mixer";
import {
  ACCENT,
  FORMAT_OPTIONS,
  ALLOWED_EXTENSIONS,
  MAX_FILE_SIZE,
  STEM_COLORS,
  checkHealth,
  deleteJob,
  getStatus,
  STEM_FILE_NAMES,
  fetchStem,
  uploadSong,
  type Health,
  type JobStatus,
  type AudioFormat,
  type ModelName,
} from "@/lib/api";
import { cleanSongName } from "@/lib/download";
import { mono } from "@/lib/fonts";
import { saveAudio } from "@/lib/save";

const MODEL_OPTIONS: { value: ModelName; title: string; desc: string }[] = [
  { value: "htdemucs_6s", title: "6 pistas", desc: "Voz · batería · bajo · guitarra · piano · otros" },
  { value: "htdemucs", title: "4 pistas", desc: "Voz · batería · bajo · otros — más preciso" },
];

// Barras decorativas: alturas enteras calculadas una sola vez, para que
// el servidor y el navegador generen exactamente el mismo HTML.
const STEM_COLOR_LIST = Object.values(STEM_COLORS);
const DECOR_BARS = Array.from({ length: 48 }, (_, i) => ({
  height: Math.round(20 + Math.abs(Math.sin(i * 1.7)) * 80),
  color: STEM_COLOR_LIST[i % 6],
}));

function formatSize(bytes: number) {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export default function Home() {
  // En la app de escritorio, EngineGate se asegura de que el motor esté instalado y encendido
  return (
    <EngineGate>
      <StemlyApp />
    </EngineGate>
  );
}

function StemlyApp() {
  const engine = useEngine();
  const [health, setHealth] = useState<Health | null>(null);
  const [backendDown, setBackendDown] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [model, setModel] = useState<ModelName>("htdemucs_6s");
  const [format, setFormat] = useState<AudioFormat>("wav");

  // Recordar el formato elegido entre visitas (solo en este navegador)
  useEffect(() => {
    try {
      const saved = localStorage.getItem("stemly-format");
      if (saved === "wav" || saved === "mp3" || saved === "flac") setFormat(saved);
    } catch {
      // almacenamiento no disponible: se usa WAV
    }
  }, []);

  const chooseFormat = (f: AudioFormat) => {
    setFormat(f);
    try {
      localStorage.setItem("stemly-format", f);
    } catch {
      // sin almacenamiento, no pasa nada
    }
  };
  const [dragging, setDragging] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [job, setJob] = useState<JobStatus | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    checkHealth()
      .then(setHealth)
      .catch(() => setBackendDown(true));
  }, []);

  useEffect(() => {
    if (!job || job.status === "done" || job.status === "error") return;
    const id = setInterval(async () => {
      try {
        const updated = await getStatus(job.job_id);
        setJob(updated);
        if (updated.status === "done") toast.success("¡Pistas listas!");
        if (updated.status === "error") toast.error(updated.error ?? "Error al separar");
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Error de conexión");
        clearInterval(id);
      }
    }, 1000);
    return () => clearInterval(id);
  }, [job]);

  // Mientras el resultado esta abierto, avisar al backend cada 5 minutos
  // para que la limpieza automatica no borre las pistas en uso.
  const doneJobId = job?.status === "done" ? job.job_id : null;
  useEffect(() => {
    if (!doneJobId) return;
    const id = setInterval(() => {
      getStatus(doneJobId).catch(() => {});
    }, 5 * 60 * 1000);
    return () => clearInterval(id);
  }, [doneJobId]);

  const pickFile = (f: File | undefined) => {
    if (!f) return;
    const ext = f.name.slice(f.name.lastIndexOf(".")).toLowerCase();
    if (!ALLOWED_EXTENSIONS.includes(ext)) {
      toast.error(`Formato no permitido. Usa: ${ALLOWED_EXTENSIONS.join(", ")}`);
      return;
    }
    if (f.size > MAX_FILE_SIZE) {
      toast.error("El archivo supera los 200 MB");
      return;
    }
    setFile(f);
    setJob(null);
  };

  const start = async () => {
    if (!file) return;
    setUploading(true);
    try {
      const { job_id } = await uploadSong(file, model);
      setJob({ job_id, filename: file.name, model, status: "queued", progress: 0, stems: [], error: null });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "No se pudo subir la canción");
    } finally {
      setUploading(false);
    }
  };

  const reset = () => {
    // Borrar del disco las pistas de la cancion anterior (si ya termino)
    if (job && (job.status === "done" || job.status === "error")) {
      deleteJob(job.job_id).catch(() => {});
    }
    setFile(null);
    setJob(null);
  };

  const busy = uploading || job?.status === "queued" || job?.status === "processing";
  // Misma lista mientras no cambien las pistas (evita que el mezclador se reinicie)
  const jobStems = job?.stems;
  const mixerStems = useMemo(
    () => jobStems?.filter((s) => s !== "instrumental") ?? [],
    [jobStems],
  );
  const gpuName = health?.gpu?.replace("NVIDIA GeForce ", "").replace(" Laptop GPU", "");

  return (
    <main className="mx-auto flex min-h-screen max-w-5xl flex-col gap-8 px-4 py-8 sm:px-6">
      {/* Encabezado */}
      <header className="flex flex-wrap items-center justify-between gap-3">
        <Logo />
        <div className="flex items-center gap-2">
          {health && (
            <div
              className={`${mono.className} flex items-center gap-2 rounded-full border border-white/10 px-3 py-1.5 text-[11px] uppercase tracking-wider text-zinc-400`}
            >
              <span
                className={`size-1.5 rounded-full ${health.device === "cuda" ? "bg-emerald-400 shadow-[0_0_8px] shadow-emerald-400" : "bg-amber-400"}`}
              />
              {health.device === "cuda" ? `GPU · ${gpuName}` : "CPU"}
            </div>
          )}
          {engine.desktop && (
            <button
              onClick={engine.openSetup}
              disabled={busy}
              title={busy ? "Esperá a que termine la separación" : "Cambiar entre motor GPU y CPU"}
              className={`${mono.className} rounded-full border border-white/10 px-3 py-1.5 text-[11px] uppercase tracking-wider text-zinc-500 transition-colors hover:text-white disabled:cursor-not-allowed disabled:opacity-40`}
            >
              Cambiar motor
            </button>
          )}
        </div>
      </header>

      {backendDown && (
        <div className="rounded-xl border border-red-500/40 bg-red-500/10 p-4 text-sm text-red-200">
          No se pudo conectar con el motor de separación. Abrí una terminal en <code>backend</code>,
          activá el entorno y corré <code>python main.py</code>; luego recargá la página.
        </div>
      )}

      {/* Paso 1: cargar */}
      {!job && (
        <section className="space-y-6">
          <div>
            <h1 className="max-w-xl text-4xl font-semibold leading-tight tracking-tight sm:text-5xl">
              Desarmá cualquier canción en sus pistas.
            </h1>
            <p className="mt-3 max-w-lg text-zinc-400">
              Voz, batería, bajo, guitarra y piano por separado. Todo se procesa en tu computadora:
              tu música nunca sale de ella.
            </p>
          </div>

          <div
            role="button"
            tabIndex={0}
            onClick={() => inputRef.current?.click()}
            onKeyDown={(e) => e.key === "Enter" && inputRef.current?.click()}
            onDragOver={(e) => {
              e.preventDefault();
              setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragging(false);
              pickFile(e.dataTransfer.files[0]);
            }}
            className={`group relative flex cursor-pointer flex-col items-center justify-center gap-3 overflow-hidden rounded-2xl border border-dashed px-12 pb-20 pt-12 text-center transition-colors ${
              dragging ? "border-[#E8FF59] bg-[#E8FF59]/5" : "border-white/15 hover:border-white/30"
            }`}
          >
            {/* Barras decorativas de fondo */}
            <div className="pointer-events-none absolute inset-x-0 bottom-0 flex h-12 items-end justify-center gap-1 opacity-15">
              {DECOR_BARS.map(({ height, color }, i) => (
                <span
                  key={i}
                  className="w-1 rounded-t-sm"
                  style={{ height: `${height}%`, backgroundColor: color }}
                />
              ))}
            </div>

            <div className="grid size-12 place-items-center rounded-full border border-white/15 transition-transform group-hover:-translate-y-0.5">
              <Upload className="size-5 text-zinc-300" />
            </div>
            {file ? (
              <>
                <p className="font-medium">{file.name}</p>
                <p className={`${mono.className} text-xs text-zinc-500`}>
                  {formatSize(file.size)} · clic para cambiar
                </p>
              </>
            ) : (
              <>
                <p className="font-medium">Soltá tu canción acá o hacé clic para buscarla</p>
                <p className={`${mono.className} text-xs uppercase tracking-wider text-zinc-500`}>
                  mp3 · wav · flac · m4a · ogg — máx. 200 mb
                </p>
              </>
            )}
            <input
              ref={inputRef}
              type="file"
              accept={ALLOWED_EXTENSIONS.join(",")}
              className="hidden"
              onChange={(e) => pickFile(e.target.files?.[0])}
            />
          </div>

          <div className="flex flex-col gap-4 sm:flex-row sm:items-stretch">
            <div className="grid flex-1 gap-3 sm:grid-cols-2">
              {MODEL_OPTIONS.map((opt) => {
                const active = model === opt.value;
                return (
                  <button
                    key={opt.value}
                    onClick={() => setModel(opt.value)}
                    aria-pressed={active}
                    className={`rounded-xl border p-4 text-left transition-colors ${
                      active ? "border-[#E8FF59] bg-[#E8FF59]/5" : "border-white/10 hover:border-white/25"
                    }`}
                  >
                    <p className="font-medium">{opt.title}</p>
                    <p className="mt-1 text-xs text-zinc-500">{opt.desc}</p>
                  </button>
                );
              })}
            </div>
            <button
              onClick={start}
              disabled={!file || busy || backendDown}
              className="rounded-xl px-8 py-4 font-semibold text-black transition-opacity disabled:cursor-not-allowed disabled:opacity-30"
              style={{ background: ACCENT }}
            >
              {uploading ? "Subiendo…" : "Separar pistas"}
            </button>
          </div>
        </section>
      )}

      {/* Paso 2: procesando */}
      {job && job.status !== "done" && (
        <section className="rounded-2xl border border-white/10 bg-[#111113] p-8">
          <p className="truncate text-zinc-400">{job.filename}</p>
          {job.status === "error" ? (
            <div className="mt-4 space-y-4">
              <p className="text-red-400">{job.error}</p>
              <button onClick={reset} className="rounded-lg border border-white/15 px-4 py-2 text-sm hover:bg-white/5">
                Intentar con otra canción
              </button>
            </div>
          ) : (
            <>
              <p className={`${mono.className} mt-2 text-6xl font-semibold tabular-nums`}>
                {job.progress}
                <span className="text-zinc-600">%</span>
              </p>
              <div className="mt-6 h-1 overflow-hidden rounded-full bg-white/10">
                <div
                  className="h-full transition-[width] duration-500"
                  style={{ width: `${job.progress}%`, background: ACCENT }}
                />
              </div>
              <p className={`${mono.className} mt-3 text-xs uppercase tracking-wider text-zinc-500`}>
                {job.status === "queued" ? "En cola" : "Separando pistas con IA"}
              </p>
            </>
          )}
        </section>
      )}

      {/* Paso 3: resultado */}
      {job?.status === "done" && (
        <section className="space-y-4">
          <div className="flex flex-wrap items-center gap-3">
            <div className="min-w-0 flex-1">
              <p className={`${mono.className} text-[11px] uppercase tracking-wider text-zinc-500`}>
                Separada en {mixerStems.length} pistas
              </p>
              <h2 className="truncate text-xl font-semibold">{job.filename}</h2>
            </div>
            <button
              onClick={() =>
                saveAudio({
                  name: `${cleanSongName(job.filename)} (${STEM_FILE_NAMES.instrumental}).${format}`,
                  getBlob: () => fetchStem(job.job_id, "instrumental", format),
                })
              }
              className="flex items-center gap-2 rounded-xl px-4 py-2.5 text-sm font-semibold text-black"
              style={{ background: ACCENT }}
            >
              <Download className="size-4" /> Descargar sin voz
            </button>
            <button
              onClick={reset}
              className="flex items-center gap-2 rounded-xl border border-white/15 px-4 py-2.5 text-sm hover:bg-white/5"
            >
              <RotateCcw className="size-4" /> Nueva canción
            </button>
          </div>
          {/* Formato de descarga: aplica a todas las descargas */}
          <div className="flex flex-wrap items-center gap-3">
            <span className={`${mono.className} text-[11px] uppercase tracking-wider text-zinc-500`}>
              Formato de descarga
            </span>
            <div className="flex rounded-xl border border-white/10 p-1" role="radiogroup" aria-label="Formato de descarga">
              {FORMAT_OPTIONS.map((opt) => {
                const active = format === opt.value;
                return (
                  <button
                    key={opt.value}
                    role="radio"
                    aria-checked={active}
                    onClick={() => chooseFormat(opt.value)}
                    title={opt.hint}
                    className={`${mono.className} rounded-lg px-3 py-1.5 text-xs font-semibold transition-colors ${
                      active ? "text-black" : "text-zinc-400 hover:text-white"
                    }`}
                    style={active ? { backgroundColor: ACCENT } : undefined}
                  >
                    {opt.label}
                  </button>
                );
              })}
            </div>
            <span className="text-xs text-zinc-500">
              {FORMAT_OPTIONS.find((o) => o.value === format)?.hint}
            </span>
            {health && health.ffmpeg === false && format !== "wav" && (
              <span className="text-xs text-red-400">
                FFmpeg no está instalado: solo funciona WAV
              </span>
            )}
          </div>

          <StemMixer
            jobId={job.job_id}
            stems={mixerStems}
            filename={job.filename}
            format={format}
          />
        </section>
      )}

      <footer
        className={`${mono.className} mt-auto flex flex-wrap items-center justify-center gap-x-2 gap-y-1 pt-8 text-[11px] uppercase tracking-wider text-zinc-600`}
      >
        <span>
          Hecho por{" "}
          <ExternalLink
            href="https://github.com/Tigresitop"
            className="text-zinc-400 transition-colors hover:text-[#E8FF59]"
          >
            John Tigre
          </ExternalLink>
        </span>
        <span aria-hidden>·</span>
        <ExternalLink
          href="https://github.com/Tigresitop/Stemly"
          className="transition-colors hover:text-zinc-300"
        >
          Código abierto en GitHub
        </ExternalLink>
        <span aria-hidden>·</span>
        <span>Separación con Demucs</span>
      </footer>
    </main>
  );
}
