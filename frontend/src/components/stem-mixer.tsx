"use client";

import { useEffect, useRef, useState } from "react";
import { Download, Pause, Play, Square } from "lucide-react";

import { Slider } from "@/components/ui/slider";
import { ACCENT, STEM_COLORS, STEM_LABELS, stemUrl } from "@/lib/api";
import { mono } from "@/lib/fonts";

type TrackState = { volume: number; muted: boolean; solo: boolean };
type Props = { jobId: string; stems: string[] };

const WAVE_BARS = 500;

function formatTime(seconds: number) {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

export function StemMixer({ jobId, stems }: Props) {
  const ctxRef = useRef<AudioContext | null>(null);
  const buffersRef = useRef<Record<string, AudioBuffer>>({});
  const gainsRef = useRef<Record<string, GainNode>>({});
  const analysersRef = useRef<Record<string, AnalyserNode>>({});
  const meterElsRef = useRef<Record<string, HTMLDivElement | null>>({});
  const sourcesRef = useRef<AudioBufferSourceNode[]>([]);
  const startedAtRef = useRef(0);
  const offsetRef = useRef(0);
  const durationRef = useRef(0);
  const rafRef = useRef<number | null>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const peaksRef = useRef<Float32Array | null>(null);
  const sampleBuf = useRef(new Float32Array(1024));

  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [playing, setPlaying] = useState(false);
  const [position, setPosition] = useState(0);
  const [duration, setDuration] = useState(0);
  const [tracks, setTracks] = useState<Record<string, TrackState>>(() =>
    Object.fromEntries(stems.map((s) => [s, { volume: 1, muted: false, solo: false }])),
  );

  // ---------- Dibujo de la forma de onda ----------
  const drawWave = (pos: number) => {
    const canvas = canvasRef.current;
    const peaks = peaksRef.current;
    if (!canvas || !peaks) return;
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
      canvas.width = w * dpr;
      canvas.height = h * dpr;
    }
    const c = canvas.getContext("2d");
    if (!c) return;
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    c.clearRect(0, 0, w, h);
    const barW = w / peaks.length;
    const played = durationRef.current ? (pos / durationRef.current) * w : 0;
    for (let i = 0; i < peaks.length; i++) {
      const x = i * barW;
      const bh = Math.max(2, peaks[i] * h);
      c.fillStyle = x < played ? ACCENT : "rgba(255,255,255,0.16)";
      c.fillRect(x, (h - bh) / 2, Math.max(1, barW - 1), bh);
    }
  };

  // ---------- Medidores de nivel (VU) ----------
  const updateMeters = () => {
    for (const [stem, analyser] of Object.entries(analysersRef.current)) {
      const el = meterElsRef.current[stem];
      if (!el) continue;
      const buf = sampleBuf.current;
      analyser.getFloatTimeDomainData(buf);
      let sum = 0;
      for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
      const level = Math.min(1, Math.sqrt(Math.sqrt(sum / buf.length)) * 1.5);
      el.style.transform = `scaleY(${level})`;
    }
  };

  const resetMeters = () => {
    Object.values(meterElsRef.current).forEach((el) => {
      if (el) el.style.transform = "scaleY(0)";
    });
  };

  // ---------- Carga de pistas ----------
  useEffect(() => {
    let cancelled = false;
    const ctx = new AudioContext();
    ctxRef.current = ctx;

    (async () => {
      try {
        const entries = await Promise.all(
          stems.map(async (stem) => {
            const res = await fetch(stemUrl(jobId, stem));
            if (!res.ok) throw new Error(`No se pudo cargar ${stem}`);
            return [stem, await ctx.decodeAudioData(await res.arrayBuffer())] as const;
          }),
        );
        if (cancelled) return;

        buffersRef.current = Object.fromEntries(entries);
        for (const [stem] of entries) {
          const gain = ctx.createGain();
          const analyser = ctx.createAnalyser();
          analyser.fftSize = 1024;
          gain.connect(analyser);
          analyser.connect(ctx.destination);
          gainsRef.current[stem] = gain;
          analysersRef.current[stem] = analyser;
        }

        // Picos de la mezcla completa para la forma de onda
        const len = Math.max(...entries.map(([, b]) => b.length));
        const step = Math.floor(len / WAVE_BARS);
        const peaks = new Float32Array(WAVE_BARS);
        for (let i = 0; i < WAVE_BARS; i++) {
          let max = 0;
          for (let j = i * step; j < (i + 1) * step; j += 32) {
            let s = 0;
            for (const [, b] of entries) s += b.getChannelData(0)[j] ?? 0;
            if (Math.abs(s) > max) max = Math.abs(s);
          }
          peaks[i] = max;
        }
        const top = Math.max(...peaks) || 1;
        peaksRef.current = peaks.map((p) => p / top);

        const dur = Math.max(...entries.map(([, b]) => b.duration));
        durationRef.current = dur;
        setDuration(dur);
        setLoading(false);
      } catch (err) {
        if (!cancelled) setLoadError(err instanceof Error ? err.message : "Error al cargar audio");
      }
    })();

    return () => {
      cancelled = true;
      sourcesRef.current.forEach((s) => {
        try {
          s.stop();
        } catch {}
      });
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      ctx.close();
    };
  }, [jobId, stems]);

  // Dibujar la onda al terminar de cargar y al cambiar el tamano de ventana
  useEffect(() => {
    if (loading) return;
    drawWave(offsetRef.current);
    const onResize = () => drawWave(offsetRef.current);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading]);

  // Aplicar volumen / mute / solo
  useEffect(() => {
    const anySolo = Object.values(tracks).some((t) => t.solo);
    for (const [stem, t] of Object.entries(tracks)) {
      const gain = gainsRef.current[stem];
      if (!gain) continue;
      gain.gain.value = (anySolo ? t.solo : !t.muted) ? t.volume : 0;
    }
  }, [tracks, loading]);

  // ---------- Transporte ----------
  const stopSources = () => {
    sourcesRef.current.forEach((s) => {
      s.onended = null;
      try {
        s.stop();
      } catch {}
    });
    sourcesRef.current = [];
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
  };

  const loop = () => {
    const ctx = ctxRef.current;
    if (!ctx) return;
    const pos = Math.min(
      offsetRef.current + (ctx.currentTime - startedAtRef.current),
      durationRef.current,
    );
    setPosition(pos);
    drawWave(pos);
    updateMeters();
    rafRef.current = requestAnimationFrame(loop);
  };

  const play = async (from = offsetRef.current) => {
    const ctx = ctxRef.current;
    if (!ctx) return;
    if (ctx.state === "suspended") await ctx.resume();
    stopSources();

    const start = ctx.currentTime + 0.05;
    sourcesRef.current = Object.entries(buffersRef.current).map(([stem, buffer]) => {
      const src = ctx.createBufferSource();
      src.buffer = buffer;
      src.connect(gainsRef.current[stem]);
      src.start(start, from);
      return src;
    });
    sourcesRef.current[0].onended = () => stop();

    offsetRef.current = from;
    startedAtRef.current = start;
    setPlaying(true);
    rafRef.current = requestAnimationFrame(loop);
  };

  const pause = () => {
    const ctx = ctxRef.current;
    if (!ctx) return;
    offsetRef.current += ctx.currentTime - startedAtRef.current;
    stopSources();
    resetMeters();
    setPlaying(false);
  };

  const stop = () => {
    stopSources();
    resetMeters();
    setPlaying(false);
    offsetRef.current = 0;
    setPosition(0);
    drawWave(0);
  };

  const seek = (value: number) => {
    offsetRef.current = value;
    setPosition(value);
    drawWave(value);
    if (playing) play(value);
  };

  const seekFromCanvas = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    seek(((e.clientX - rect.left) / rect.width) * durationRef.current);
  };

  const updateTrack = (stem: string, patch: Partial<TrackState>) =>
    setTracks((prev) => ({ ...prev, [stem]: { ...prev[stem], ...patch } }));

  if (loadError) return <p className="text-sm text-red-400">{loadError}</p>;

  if (loading) {
    return (
      <div className={`${mono.className} rounded-2xl border border-white/10 p-8 text-center text-sm text-zinc-500`}>
        Cargando pistas en el mezclador…
      </div>
    );
  }

  const anySolo = Object.values(tracks).some((t) => t.solo);

  return (
    <section className="overflow-hidden rounded-2xl border border-white/10 bg-[#111113]">
      {/* Transporte + forma de onda */}
      <div className="flex items-center gap-4 border-b border-white/10 p-4">
        <button
          onClick={() => (playing ? pause() : play())}
          aria-label={playing ? "Pausar" : "Reproducir"}
          className="grid size-12 shrink-0 place-items-center rounded-full text-black transition-transform active:scale-95"
          style={{ background: ACCENT }}
        >
          {playing ? <Pause className="size-5 fill-current" /> : <Play className="ml-0.5 size-5 fill-current" />}
        </button>
        <button
          onClick={stop}
          aria-label="Detener"
          className="grid size-9 shrink-0 place-items-center rounded-full border border-white/15 text-zinc-400 hover:text-white"
        >
          <Square className="size-3.5 fill-current" />
        </button>
        <canvas
          ref={canvasRef}
          onClick={seekFromCanvas}
          className="h-14 min-w-0 flex-1 cursor-pointer"
          aria-label="Forma de onda, clic para saltar"
        />
        <span className={`${mono.className} shrink-0 text-sm tabular-nums text-zinc-400`}>
          {formatTime(position)}
          <span className="text-zinc-600"> / {formatTime(duration)}</span>
        </span>
      </div>

      {/* Tiras de canal */}
      <div className="flex gap-px overflow-x-auto bg-white/5">
        {stems.map((stem) => {
          const t = tracks[stem];
          const color = STEM_COLORS[stem] ?? "#A1A1AA";
          const silenced = anySolo ? !t.solo : t.muted;
          return (
            <div
              key={stem}
              className={`flex min-w-24 flex-1 flex-col items-center gap-3 bg-[#111113] px-2 pb-4 pt-0 transition-opacity ${
                silenced ? "opacity-40" : ""
              }`}
            >
              <div className="h-1 w-full" style={{ background: color }} />
              <span className={`${mono.className} text-[11px] uppercase tracking-[0.15em] text-zinc-300`}>
                {STEM_LABELS[stem] ?? stem}
              </span>

              {/* Medidor + fader */}
              <div className="flex h-44 items-stretch gap-3">
                <div className="relative w-1.5 overflow-hidden rounded-full bg-white/10">
                  <div
                    ref={(el) => {
                      meterElsRef.current[stem] = el;
                    }}
                    className="absolute inset-0 origin-bottom transition-transform duration-75"
                    style={{ background: color, transform: "scaleY(0)" }}
                  />
                </div>
                <Slider
                  orientation="vertical"
                  className="h-full"
                  value={[t.volume * 100]}
                  max={100}
                  step={1}
                  onValueChange={([v]) => updateTrack(stem, { volume: v / 100 })}
                  aria-label={`Volumen ${STEM_LABELS[stem] ?? stem}`}
                />
              </div>
              <span className={`${mono.className} text-xs tabular-nums text-zinc-500`}>
                {Math.round(t.volume * 100)}
              </span>

              {/* Mute / Solo */}
              <div className="flex gap-1.5">
                <button
                  onClick={() => updateTrack(stem, { muted: !t.muted })}
                  className={`${mono.className} size-8 rounded-md border text-xs font-bold transition-colors ${
                    t.muted
                      ? "border-amber-400 bg-amber-400 text-black"
                      : "border-white/15 text-zinc-400 hover:text-white"
                  }`}
                  aria-pressed={t.muted}
                  title="Silenciar"
                >
                  M
                </button>
                <button
                  onClick={() => updateTrack(stem, { solo: !t.solo })}
                  className={`${mono.className} size-8 rounded-md border text-xs font-bold transition-colors ${
                    t.solo ? "text-black" : "border-white/15 text-zinc-400 hover:text-white"
                  }`}
                  style={t.solo ? { background: color, borderColor: color } : undefined}
                  aria-pressed={t.solo}
                  title="Solo"
                >
                  S
                </button>
              </div>

              <a
                href={stemUrl(jobId, stem)}
                download
                className="rounded-md p-1.5 text-zinc-500 transition-colors hover:bg-white/10 hover:text-white"
                aria-label={`Descargar ${STEM_LABELS[stem] ?? stem}`}
                title="Descargar pista"
              >
                <Download className="size-4" />
              </a>
            </div>
          );
        })}
      </div>
    </section>
  );
}
