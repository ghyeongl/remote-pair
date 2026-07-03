type Props = { total: number; current: number };

export function StepProgress({ total, current }: Props) {
  return (
    <div
      className="flex gap-1.5"
      role="progressbar"
      aria-valuemin={1}
      aria-valuemax={total}
      aria-valuenow={current + 1}
    >
      {Array.from({ length: total }).map((_, i) => (
        <span
          key={i}
          className={
            "h-1.5 flex-1 rounded-full transition-colors duration-500 " +
            (i <= current ? "bg-primary" : "bg-muted")
          }
        />
      ))}
    </div>
  );
}
