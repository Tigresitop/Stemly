import { toast } from "sonner";

import { downloadBlob } from "@/lib/download";

/** true si la interfaz corre dentro de la app de escritorio (Tauri). */
export function isDesktopApp(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

type SaveOptions = {
  /** Nombre sugerido, con extensión (ej. "Canción (Voz).mp3") */
  name: string;
  /** Obtiene el archivo (se llama después de elegir dónde guardarlo) */
  getBlob: () => Promise<Blob>;
};

/**
 * Guarda un archivo de audio y avisa al terminar.
 * - App de escritorio: abre la ventana de Windows "Guardar como".
 * - Navegador: lo descarga a la carpeta de Descargas.
 * Devuelve true si se guardó, false si el usuario canceló o hubo un error.
 */
export async function saveAudio({ name, getBlob }: SaveOptions): Promise<boolean> {
  const ext = name.slice(name.lastIndexOf(".") + 1).toLowerCase();

  // ----- App de escritorio: elegir dónde guardar -----
  if (isDesktopApp()) {
    const { save } = await import("@tauri-apps/plugin-dialog");
    const { writeFile } = await import("@tauri-apps/plugin-fs");

    const path = await save({
      defaultPath: name,
      filters: [{ name: ext.toUpperCase(), extensions: [ext] }],
    });
    if (!path) return false; // el usuario cerró la ventana sin guardar

    const toastId = toast.loading("Guardando…");
    try {
      const blob = await getBlob();
      await writeFile(path, new Uint8Array(await blob.arrayBuffer()));
      toast.success("Archivo guardado", { id: toastId, description: path });
      return true;
    } catch (err) {
      toast.error("No se pudo guardar", { id: toastId, description: errorText(err) });
      return false;
    }
  }

  // ----- Navegador: descarga normal -----
  const toastId = toast.loading("Preparando descarga…");
  try {
    downloadBlob(await getBlob(), name);
    toast.success("Descarga lista", { id: toastId, description: `${name} · revisá tu carpeta de Descargas` });
    return true;
  } catch (err) {
    toast.error("No se pudo descargar", { id: toastId, description: errorText(err) });
    return false;
  }
}

function errorText(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  return "Error desconocido";
}
