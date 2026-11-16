/**
 * Comunicación con la parte de escritorio (Rust/Tauri) que gestiona el motor.
 * Solo funciona dentro de la app de escritorio.
 */

export type EngineVariant = "gpu" | "cpu";

export type InstalledEngine = { variant: EngineVariant; version: string };

export type EngineInfo = {
  /** Motor elegido para usar */
  installed: InstalledEngine | null;
  /** Todos los motores instalados */
  available: InstalledEngine[];
  expectedVersion: string;
  running: boolean;
  gpu: string | null;
  logPath: string;
};

export type EngineEntry = {
  version: string;
  file: string;
  size: number;
  sha256: string;
  unpacked_size: number;
  parts: { name: string; size: number; sha256: string }[];
};

export type EngineManifest = { engines: Partial<Record<EngineVariant, EngineEntry>> };

export type EngineProgress =
  | { stage: "downloading"; part: number; parts: number; downloaded: number; total: number }
  | { stage: "verifying" }
  | { stage: "extracting"; done: number; total: number }
  | { stage: "finishing" };

async function call<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const { invoke } = await import("@tauri-apps/api/core");
  try {
    return await invoke<T>(cmd, args);
  } catch (err) {
    // Los errores de Rust llegan como texto
    throw new Error(typeof err === "string" ? err : err instanceof Error ? err.message : "Error desconocido");
  }
}

export const getEngineInfo = () => call<EngineInfo>("engine_info");
export const getEngineManifest = () => call<EngineManifest>("engine_manifest");
export const installEngine = (variant: EngineVariant) =>
  call<InstalledEngine>("install_engine", { variant });
/** Elige un motor ya instalado, sin descargar nada. */
export const selectEngine = (variant: EngineVariant) =>
  call<InstalledEngine>("select_engine", { variant });
/** Borra un motor instalado para liberar espacio. */
export const removeEngine = (variant: EngineVariant) => call<void>("remove_engine", { variant });
export const startEngine = () => call<void>("start_engine");
export const stopEngine = () => call<void>("stop_engine");

/** Escucha el progreso de la instalación. Devuelve una función para dejar de escuchar. */
export async function onEngineProgress(cb: (p: EngineProgress) => void): Promise<() => void> {
  const { listen } = await import("@tauri-apps/api/event");
  return listen<EngineProgress>("engine-progress", (e) => cb(e.payload));
}

export function formatBytes(bytes: number): string {
  const gb = bytes / 1024 ** 3;
  if (gb >= 1) return `${gb.toFixed(1).replace(".", ",")} GB`;
  return `${Math.round(bytes / 1024 ** 2)} MB`;
}
