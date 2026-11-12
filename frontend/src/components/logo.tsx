import { STEM_COLORS } from "@/lib/api";

const BARS: [string, number][] = [
  [STEM_COLORS.vocals, 14],
  [STEM_COLORS.drums, 22],
  [STEM_COLORS.bass, 10],
  [STEM_COLORS.guitar, 18],
  [STEM_COLORS.piano, 12],
];

export function Logo() {
  return (
    <div className="flex items-center gap-2.5">
      <svg width="26" height="24" viewBox="0 0 26 24" aria-hidden>
        {BARS.map(([color, h], i) => (
          <rect key={i} x={i * 5.5} y={(24 - h) / 2} width="3.5" height={h} rx="1.75" fill={color} />
        ))}
      </svg>
      <span className="text-2xl font-semibold tracking-tight">stemly</span>
    </div>
  );
}
