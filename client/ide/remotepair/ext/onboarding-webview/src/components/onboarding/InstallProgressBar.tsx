import { Check } from "lucide-react";

type Props = { label: string; percent: number; indeterminate?: boolean };

export function InstallProgressBar({ label, percent, indeterminate }: Props) {
  const done = !indeterminate && percent >= 100;
  return (
    <div className="flex min-w-0 flex-col items-center gap-1 px-2">
      <div className="flex w-full items-center justify-between gap-3 text-[10px] text-muted-foreground/80">
        <span className="truncate">{label}</span>
        <span className="tabular-nums">
          {indeterminate ? "…" : done ? <Check className="h-3 w-3 text-primary" /> : `${Math.round(percent)}%`}
        </span>
      </div>
      <div className="relative h-[3px] w-full overflow-hidden rounded-full bg-border/60">
        {indeterminate ? (
          <div className="shimmer-bar" />
        ) : (
          <div
            className="h-full rounded-full bg-primary/60 transition-[width] duration-500 ease-out"
            style={{ width: `${percent}%` }}
          />
        )}
      </div>
    </div>
  );
}
