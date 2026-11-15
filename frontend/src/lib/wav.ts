/**
 * Convierte un AudioBuffer en un archivo WAV (PCM 16 bits, estéreo).
 * Se usa para exportar la mezcla personalizada sin pasar por el backend.
 */
export function encodeWav(buffer: AudioBuffer): Blob {
  const channels = Math.min(2, buffer.numberOfChannels);
  const sampleRate = buffer.sampleRate;
  const frames = buffer.length;
  const bytesPerSample = 2;
  const dataSize = frames * channels * bytesPerSample;

  const arrayBuffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(arrayBuffer);
  const writeText = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
  };

  // Cabecera WAV
  writeText(0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeText(8, "WAVE");
  writeText(12, "fmt ");
  view.setUint32(16, 16, true); // tamaño del bloque fmt
  view.setUint16(20, 1, true); // formato PCM
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * channels * bytesPerSample, true);
  view.setUint16(32, channels * bytesPerSample, true);
  view.setUint16(34, 16, true); // bits por muestra
  writeText(36, "data");
  view.setUint32(40, dataSize, true);

  // Muestras intercaladas (L, R, L, R...), recortadas a [-1, 1] para evitar distorsión
  const data = Array.from({ length: channels }, (_, c) => buffer.getChannelData(c));
  let offset = 44;
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < channels; c++) {
      const s = Math.max(-1, Math.min(1, data[c][i]));
      view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
      offset += 2;
    }
  }

  return new Blob([arrayBuffer], { type: "audio/wav" });
}

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
