export const API_URL =
  process.env.NEXT_PUBLIC_API_URL ?? "http://127.0.0.1:8000";

export type ModelName = "htdemucs_6s" | "htdemucs";
export type AudioFormat = "wav" | "mp3" | "flac";

export const FORMAT_OPTIONS: { value: AudioFormat; label: string; hint: string }[] = [
  { value: "wav", label: "WAV", hint: "Sin compresión · pesa más" },
  { value: "flac", label: "FLAC", hint: "Sin pérdida · ~40% más liviano" },
  { value: "mp3", label: "MP3", hint: "320 kbps · el más liviano" },
];

export type JobStatus = {
  job_id: string;
  filename: string | null;
  model: ModelName;
  status: "queued" | "processing" | "done" | "error";
  progress: number;
  stems: string[];
  error: string | null;
};

export type Health = {
  status: string;
  device: "cuda" | "cpu";
  gpu: string | null;
  models: Record<ModelName, string[]>;
  ffmpeg?: boolean;
  formats?: AudioFormat[];
};

export const STEM_LABELS: Record<string, string> = {
  vocals: "Voz",
  drums: "Batería",
  bass: "Bajo",
  guitar: "Guitarra",
  piano: "Piano",
  other: "Otros",
  instrumental: "Instrumental (sin voz)",
};

// Nombre de cada pista en los archivos guardados (igual que en el backend)
export const STEM_FILE_NAMES: Record<string, string> = {
  vocals: "Voz",
  drums: "Batería",
  bass: "Bajo",
  guitar: "Guitarra",
  piano: "Piano",
  other: "Otros",
  instrumental: "Instrumental",
};

// Color propio de cada pista (como las tiras de color de una consola)
export const STEM_COLORS: Record<string, string> = {
  vocals: "#FF6B9A",
  drums: "#FFB547",
  bass: "#9B7BFF",
  guitar: "#4ADE80",
  piano: "#5CC8FF",
  other: "#A1A1AA",
  instrumental: "#E8FF59",
};

export const ACCENT = "#E8FF59";

export const ALLOWED_EXTENSIONS = [".mp3", ".wav", ".flac", ".m4a", ".ogg"];
export const MAX_FILE_SIZE = 200 * 1024 * 1024; // 200 MB, igual que el backend

async function handle<T>(res: Response): Promise<T> {
  if (!res.ok) {
    let message = `Error ${res.status}`;
    try {
      const data = await res.json();
      if (typeof data?.detail === "string") message = data.detail;
    } catch {
      // respuesta sin JSON
    }
    throw new Error(message);
  }
  return res.json() as Promise<T>;
}

export async function checkHealth(): Promise<Health> {
  return handle<Health>(await fetch(`${API_URL}/health`));
}

export async function uploadSong(
  file: File,
  model: ModelName,
): Promise<{ job_id: string; status: string }> {
  const form = new FormData();
  form.append("file", file);
  form.append("model", model);
  return handle(await fetch(`${API_URL}/separate`, { method: "POST", body: form }));
}

export async function getStatus(jobId: string): Promise<JobStatus> {
  return handle<JobStatus>(
    await fetch(`${API_URL}/status/${encodeURIComponent(jobId)}`),
  );
}

export async function deleteJob(jobId: string): Promise<void> {
  await fetch(`${API_URL}/jobs/${encodeURIComponent(jobId)}`, { method: "DELETE" });
}

export function stemUrl(jobId: string, stem: string, format: AudioFormat = "wav"): string {
  return `${API_URL}/stems/${encodeURIComponent(jobId)}/${encodeURIComponent(stem)}?format=${format}`;
}

/** Descarga una pista del backend en el formato pedido. */
export async function fetchStem(jobId: string, stem: string, format: AudioFormat): Promise<Blob> {
  const res = await fetch(stemUrl(jobId, stem, format));
  if (!res.ok) {
    let message = `Error ${res.status}`;
    try {
      const data = await res.json();
      if (typeof data?.detail === "string") message = data.detail;
    } catch {
      // respuesta sin JSON
    }
    throw new Error(message);
  }
  return res.blob();
}

/** Pide al backend la mezcla con los volúmenes indicados y la devuelve como archivo. */
export async function requestMix(
  jobId: string,
  gains: Record<string, number>,
  format: AudioFormat,
): Promise<Blob> {
  const res = await fetch(`${API_URL}/mix/${encodeURIComponent(jobId)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ gains, format }),
  });
  if (!res.ok) {
    let message = `Error ${res.status}`;
    try {
      const data = await res.json();
      if (typeof data?.detail === "string") message = data.detail;
    } catch {
      // respuesta sin JSON
    }
    throw new Error(message);
  }
  return res.blob();
}
