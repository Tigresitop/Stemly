/** Nombre de la canción sin extensión y sin caracteres prohibidos en Windows. */
export function cleanSongName(filename: string | null | undefined): string {
  const base = (filename ?? "").replace(/\.[^.]+$/, "");
  const clean = base.replace(/[<>:"/\\|?*\x00-\x1f]/g, "").replace(/^[\s.]+|[\s.]+$/g, "");
  return clean.slice(0, 150) || "cancion";
}

/** Descarga un Blob como archivo. */
export function downloadBlob(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
