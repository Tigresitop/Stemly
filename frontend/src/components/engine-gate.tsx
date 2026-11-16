"use client";

import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { AlertTriangle, Check, Cpu, Loader2, Trash2, Zap } from "lucide-react";
import { toast } from "sonner";

import { Logo } from "@/components/logo";
import { ACCENT, checkHealth } from "@/lib/api";
import {
  formatBytes,
  getEngineInfo,
  getEngineManifest,
  installEngine,
  onEngineProgress,
  removeEngine,
  selectEngine,
  startEngine,
  type EngineInfo,
  type EngineManifest,
  type EngineProgress,
  type EngineVariant,
  type InstalledEngine,
} from "@/lib/engine";
import { mono } from "@/lib/fonts";
import { isDesktopApp } from "@/lib/save";

// ---------------------------------------------------------------------------
// Contexto: permite a la app mostrar el motor actual y pedir cambiarlo
// ---------------------------------------------------------------------------

type EngineContextValue = {
  desktop: boolean;
  variant: EngineVariant | null;
  openSetup: () => void;
};

const EngineContext = createContext<EngineContextValue>({
  desktop: false,
  variant: null,
  openSetup: () => {},
});

export const useEngine = () => useContext(EngineContext);

// ---------------------------------------------------------------------------

type SetupReason = "first" | "update" | "switch";

type Phase =
  | { kind: "checking" }
  | { kind: "starting"; variant: EngineVariant | null }
  | { kind: "setup"; reason: SetupReason }
  | { kind: "installing"; variant: EngineVariant }
  | { kind: "error"; message: string; logPath?: string }
  | { kind: "ready" };

const START_TIMEOUT_MS = 180_000;

async function isHealthy(): Promise<boolean> {
  try {
    await checkHealth();
    return true;
  } catch {
    return false;
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function EngineGate({ children }: { children: React.ReactNode }) {
  const [phase, setPhase] = useState<Phase>({ kind: "checking" });
  const [desktop, setDesktop] = useState(false);
  const [info, setInfo] = useState<EngineInfo | null>(null);
  const bootedRef = useRef(false);

  const refreshInfo = useCallback(async () => {
    const next = await getEngineInfo();
    setInfo(next);
    return next;
  }, []);

  /** Enciende el motor elegido y espera a que responda. */
  const startAndWait = useCallback(
    async (v: EngineVariant | null) => {
      setPhase({ kind: "starting", variant: v });
      try {
        await startEngine();
      } catch (err) {
        setPhase({ kind: "error", message: (err as Error).message });
        return;
      }
      const deadline = Date.now() + START_TIMEOUT_MS;
      let checks = 0;
      while (Date.now() < deadline) {
        if (await isHealthy()) {
          await refreshInfo().catch(() => null);
          setPhase({ kind: "ready" });
          return;
        }
        // Cada tanto, comprobar que el motor no se haya cerrado por un error
        if (++checks % 3 === 0) {
          const current = await getEngineInfo().catch(() => null);
          if (current && !current.running) {
            setPhase({ kind: "error", message: "El motor se cerró al arrancar.", logPath: current.logPath });
            return;
          }
        }
        await sleep(1000);
      }
      const current = await getEngineInfo().catch(() => null);
      setPhase({ kind: "error", message: "El motor tardó demasiado en arrancar.", logPath: current?.logPath });
    },
    [refreshInfo],
  );

  /** Decide qué mostrar al abrir la app. */
  const boot = useCallback(async () => {
    setPhase({ kind: "checking" });
    const inDesktop = isDesktopApp();
    setDesktop(inDesktop);

    // Ya hay un motor respondiendo (en desarrollo: el backend con python main.py)
    if (await isHealthy()) {
      if (inDesktop) await refreshInfo().catch(() => null);
      setPhase({ kind: "ready" });
      return;
    }

    // En el navegador no hay motor que gestionar: la página muestra su propio aviso
    if (!inDesktop) {
      setPhase({ kind: "ready" });
      return;
    }

    try {
      const current = await refreshInfo();
      if (!current.installed) {
        setPhase({ kind: "setup", reason: "first" });
      } else if (current.installed.version !== current.expectedVersion) {
        setPhase({ kind: "setup", reason: "update" });
      } else {
        await startAndWait(current.installed.variant);
      }
    } catch (err) {
      setPhase({ kind: "error", message: (err as Error).message });
    }
  }, [refreshInfo, startAndWait]);

  useEffect(() => {
    if (bootedRef.current) return;
    bootedRef.current = true;
    boot();
  }, [boot]);

  const install = async (v: EngineVariant) => {
    setPhase({ kind: "installing", variant: v });
    try {
      await installEngine(v);
      await startAndWait(v);
    } catch (err) {
      setPhase({ kind: "error", message: (err as Error).message });
    }
  };

  const select = async (v: EngineVariant) => {
    try {
      await selectEngine(v);
      await startAndWait(v);
    } catch (err) {
      setPhase({ kind: "error", message: (err as Error).message });
    }
  };

  const remove = async (v: EngineVariant) => {
    try {
      await removeEngine(v);
      await refreshInfo();
      toast.success(`Motor ${v.toUpperCase()} eliminado`);
    } catch (err) {
      toast.error("No se pudo eliminar el motor", { description: (err as Error).message });
    }
  };

  const openSetup = () => {
    refreshInfo()
      .catch(() => null)
      .finally(() => setPhase({ kind: "setup", reason: "switch" }));
  };

  const ctx: EngineContextValue = {
    desktop,
    variant: info?.installed?.variant ?? null,
    openSetup,
  };

  if (phase.kind === "ready") {
    return <EngineContext.Provider value={ctx}>{children}</EngineContext.Provider>;
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-3xl flex-col gap-8 px-4 py-8 sm:px-6">
      <header>
        <Logo />
      </header>
      <div className="flex flex-1 flex-col justify-center pb-16">
        {phase.kind === "checking" && <Status text="Abriendo Stemly…" />}
        {phase.kind === "starting" && (
          <Status
            text={`Encendiendo el motor${phase.variant ? ` ${phase.variant.toUpperCase()}` : ""}…`}
            hint="Puede tardar unos segundos mientras carga la IA."
          />
        )}
        {phase.kind === "setup" && (
          <EngineSetup
            reason={phase.reason}
            info={info}
            onInstall={install}
            onSelect={select}
            onRemove={remove}
            onCancel={phase.reason === "switch" ? () => setPhase({ kind: "ready" }) : undefined}
          />
        )}
        {phase.kind === "installing" && <Installing variant={phase.variant} />}
        {phase.kind === "error" && (
          <section className="space-y-5 rounded-2xl border border-red-500/30 bg-red-500/5 p-8">
            <div className="flex items-center gap-3 text-red-300">
              <AlertTriangle className="size-5 shrink-0" />
              <p className="font-medium">{phase.message}</p>
            </div>
            {phase.logPath && (
              <p className="text-sm text-zinc-400">
                Detalles del error en:{" "}
                <code className={`${mono.className} break-all text-xs text-zinc-300`}>{phase.logPath}</code>
              </p>
            )}
            <div className="flex flex-wrap gap-3">
              <button
                onClick={boot}
                className="rounded-xl px-5 py-2.5 text-sm font-semibold text-black"
                style={{ backgroundColor: ACCENT }}
              >
                Reintentar
              </button>
              <button
                onClick={() => {
                  refreshInfo()
                    .catch(() => null)
                    .finally(() => setPhase({ kind: "setup", reason: "first" }));
                }}
                className="rounded-xl border border-white/15 px-5 py-2.5 text-sm hover:bg-white/5"
              >
                Elegir otro motor
              </button>
            </div>
          </section>
        )}
      </div>
    </main>
  );
}

// ---------------------------------------------------------------------------

function Status({ text, hint }: { text: string; hint?: string }) {
  return (
    <div className="flex flex-col items-center gap-4 text-center">
      <Loader2 className="size-8 animate-spin" style={{ color: ACCENT }} />
      <p className="text-lg font-medium">{text}</p>
      {hint && <p className="max-w-sm text-sm text-zinc-500">{hint}</p>}
    </div>
  );
}

// ---------------------------------------------------------------------------

/** Estado de cada motor en la pantalla de selección */
type CardStatus = "current" | "installed" | "outdated" | "missing";

function EngineSetup({
  reason,
  info,
  onInstall,
  onSelect,
  onRemove,
  onCancel,
}: {
  reason: SetupReason;
  info: EngineInfo | null;
  onInstall: (v: EngineVariant) => void;
  onSelect: (v: EngineVariant) => void;
  onRemove: (v: EngineVariant) => Promise<void>;
  onCancel?: () => void;
}) {
  const [manifest, setManifest] = useState<EngineManifest | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState<EngineVariant | null>(null);
  const [removing, setRemoving] = useState<EngineVariant | null>(null);

  const gpuName = info?.gpu ?? null;
  const hasNvidia = Boolean(gpuName);
  const recommended: EngineVariant = hasNvidia ? "gpu" : "cpu";
  const current = reason === "switch" ? (info?.installed?.variant ?? null) : null;
  const available: InstalledEngine[] = info?.available ?? [];

  const statusOf = (v: EngineVariant): CardStatus => {
    const inst = available.find((e) => e.variant === v);
    if (!inst) return "missing";
    if (inst.version !== info?.expectedVersion) return "outdated";
    if (current === v) return "current";
    return "installed";
  };

  // Al cambiar de motor, preseleccionar el otro; si no, el recomendado
  const [choice, setChoice] = useState<EngineVariant>(() => {
    if (current) {
      const other: EngineVariant = current === "gpu" ? "cpu" : "gpu";
      return other === "gpu" && !hasNvidia ? current : other;
    }
    return recommended;
  });

  const load = useCallback(() => {
    setError(null);
    getEngineManifest()
      .then(setManifest)
      .catch((err: Error) => setError(err.message));
  }, []);

  useEffect(load, [load]);

  const title =
    reason === "update"
      ? "Hay una versión nueva del motor"
      : reason === "switch"
        ? "Motor de separación"
        : "Último paso: elegí el motor de separación";

  const options: { value: EngineVariant; icon: React.ReactNode; name: string; desc: string; disabled?: string }[] = [
    {
      value: "gpu",
      icon: <Zap className="size-4" />,
      name: "GPU · Rápido",
      desc: hasNvidia
        ? `Usa tu ${gpuName}. Una canción se separa en segundos.`
        : "Necesita una tarjeta gráfica NVIDIA.",
      disabled: hasNvidia ? undefined : "No se detectó una tarjeta NVIDIA",
    },
    {
      value: "cpu",
      icon: <Cpu className="size-4" />,
      name: "CPU · Compatible",
      desc: "Funciona en cualquier computadora. Una canción tarda algunos minutos.",
    },
  ];

  const choiceStatus = statusOf(choice);
  const choiceEntry = manifest?.engines[choice];
  const action =
    choiceStatus === "current"
      ? { label: "Ya estás usando este motor", disabled: true, run: () => {} }
      : choiceStatus === "installed"
        ? { label: `Usar motor ${choice.toUpperCase()}`, disabled: false, run: () => onSelect(choice) }
        : {
            label: choiceStatus === "outdated" ? "Actualizar motor" : "Descargar e instalar",
            disabled: !choiceEntry,
            run: () => onInstall(choice),
          };

  return (
    <section className="space-y-6">
      <div>
        <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">{title}</h1>
        <p className="mt-3 max-w-xl text-zinc-400">
          {reason === "switch"
            ? "Podés tener los dos motores instalados y cambiar entre ellos cuando quieras."
            : "La inteligencia artificial que separa las pistas se descarga una sola vez. Después Stemly funciona sin internet y nada sale de tu computadora."}
        </p>
      </div>

      <div className="grid gap-3 sm:grid-cols-2" role="radiogroup" aria-label="Motor de separación">
        {options.map((opt) => {
          const status = statusOf(opt.value);
          const entry = manifest?.engines[opt.value];
          const selectable = !opt.disabled || status !== "missing";
          const active = choice === opt.value && selectable;
          const pick = () => selectable && setChoice(opt.value);

          let meta: React.ReactNode;
          if (opt.disabled && status === "missing") meta = opt.disabled;
          else if (status === "current" || status === "installed")
            meta = entry ? `Instalado · ocupa ${formatBytes(entry.unpacked_size)}` : "Instalado · listo para usar";
          else if (entry)
            meta = `Descarga ${formatBytes(entry.size)} · necesita ~${formatBytes(entry.size + entry.unpacked_size)} libres`;
          else meta = error ? "Sin conexión para consultar el tamaño" : "Consultando tamaño…";

          return (
            <div
              key={opt.value}
              role="radio"
              aria-checked={active}
              aria-disabled={!selectable}
              tabIndex={selectable ? 0 : -1}
              onClick={pick}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  pick();
                }
              }}
              className={`flex flex-col gap-2 rounded-xl border p-5 text-left transition-colors ${
                !selectable
                  ? "cursor-not-allowed border-white/10 opacity-40"
                  : active
                    ? "cursor-pointer border-[#E8FF59] bg-[#E8FF59]/5"
                    : "cursor-pointer border-white/10 hover:border-white/25"
              }`}
            >
              <div className="flex items-center gap-2">
                {opt.icon}
                <span className="font-medium">{opt.name}</span>
                <span className="ml-auto">
                  <CardBadge status={status} recommended={opt.value === recommended} />
                </span>
              </div>
              <p className="text-sm text-zinc-400">{opt.desc}</p>
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <p className={`${mono.className} text-xs text-zinc-500`}>{meta}</p>

                {/* Eliminar: solo motores instalados que no estén en uso */}
                {(status === "installed" || status === "outdated") && (
                  <div className="ml-auto flex items-center gap-2 text-xs" onClick={(e) => e.stopPropagation()}>
                    {removing === opt.value ? (
                      <span className="flex items-center gap-1 text-zinc-500">
                        <Loader2 className="size-3 animate-spin" /> Eliminando…
                      </span>
                    ) : confirmRemove === opt.value ? (
                      <>
                        <span className="text-zinc-400">¿Eliminar?</span>
                        <button
                          className="font-semibold text-red-400 hover:text-red-300"
                          onClick={async () => {
                            setRemoving(opt.value);
                            setConfirmRemove(null);
                            await onRemove(opt.value);
                            setRemoving(null);
                          }}
                        >
                          Sí
                        </button>
                        <button className="text-zinc-400 hover:text-white" onClick={() => setConfirmRemove(null)}>
                          No
                        </button>
                      </>
                    ) : (
                      <button
                        className="flex items-center gap-1 text-zinc-500 hover:text-red-400"
                        onClick={() => setConfirmRemove(opt.value)}
                        title="Liberar espacio en disco"
                      >
                        <Trash2 className="size-3" /> Eliminar
                      </button>
                    )}
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {error && (choiceStatus === "missing" || choiceStatus === "outdated") && (
        <div className="flex flex-wrap items-center gap-3 rounded-xl border border-red-500/30 bg-red-500/5 p-4 text-sm text-red-300">
          <AlertTriangle className="size-4 shrink-0" />
          <span className="flex-1">{error} Revisá tu conexión a internet.</span>
          <button onClick={load} className="rounded-lg border border-white/15 px-3 py-1.5 text-zinc-200 hover:bg-white/5">
            Reintentar
          </button>
        </div>
      )}

      <div className="flex flex-wrap gap-3">
        <button
          onClick={action.run}
          disabled={action.disabled}
          className="rounded-xl px-8 py-3.5 font-semibold text-black transition-opacity disabled:cursor-not-allowed disabled:opacity-30"
          style={{ backgroundColor: ACCENT }}
        >
          {action.label}
        </button>
        {onCancel && (
          <button onClick={onCancel} className="rounded-xl border border-white/15 px-6 py-3.5 hover:bg-white/5">
            Volver
          </button>
        )}
      </div>
    </section>
  );
}

function CardBadge({ status, recommended }: { status: CardStatus; recommended: boolean }) {
  const base = `${mono.className} rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider`;
  if (status === "current")
    return (
      <span className={`${base} flex items-center gap-1 text-black`} style={{ backgroundColor: ACCENT }}>
        <Check className="size-3" /> En uso
      </span>
    );
  if (status === "installed") return <span className={`${base} border border-white/20 text-zinc-300`}>Instalado</span>;
  if (status === "outdated") return <span className={`${base} border border-amber-400/50 text-amber-300`}>Desactualizado</span>;
  if (recommended)
    return (
      <span className={`${base} text-black`} style={{ backgroundColor: ACCENT }}>
        Recomendado
      </span>
    );
  return null;
}

// ---------------------------------------------------------------------------

function Installing({ variant }: { variant: EngineVariant }) {
  const [progress, setProgress] = useState<EngineProgress | null>(null);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    onEngineProgress(setProgress).then((fn) => {
      if (cancelled) fn();
      else unlisten = fn;
    });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  let percent = 0;
  let label = "Preparando…";
  let detail = "";
  if (progress?.stage === "downloading") {
    percent = progress.total ? (progress.downloaded / progress.total) * 100 : 0;
    label = progress.parts > 1 ? `Descargando parte ${progress.part} de ${progress.parts}` : "Descargando";
    detail = `${formatBytes(progress.downloaded)} de ${formatBytes(progress.total)}`;
  } else if (progress?.stage === "verifying") {
    percent = 100;
    label = "Verificando que la descarga esté completa";
  } else if (progress?.stage === "extracting") {
    percent = progress.total ? (progress.done / progress.total) * 100 : 0;
    label = "Instalando";
  } else if (progress?.stage === "finishing") {
    percent = 100;
    label = "Terminando";
  }

  return (
    <section className="rounded-2xl border border-white/10 bg-[#111113] p-8">
      <p className={`${mono.className} text-[11px] uppercase tracking-wider text-zinc-500`}>
        Motor {variant.toUpperCase()}
      </p>
      <p className={`${mono.className} mt-2 text-6xl font-semibold tabular-nums`}>
        {Math.floor(percent)}
        <span className="text-zinc-600">%</span>
      </p>
      <div className="mt-6 h-1 overflow-hidden rounded-full bg-white/10">
        <div className="h-full transition-[width] duration-300" style={{ width: `${percent}%`, backgroundColor: ACCENT }} />
      </div>
      <div className="mt-3 flex flex-wrap justify-between gap-2 text-sm">
        <span className="text-zinc-300">{label}</span>
        {detail && <span className={`${mono.className} text-zinc-500`}>{detail}</span>}
      </div>
      <p className="mt-6 text-sm text-zinc-500">
        Podés dejar la app abierta mientras se descarga. Si se corta la conexión, vas a poder reintentar.
      </p>
    </section>
  );
}
