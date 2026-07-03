import type { ComponentType, ReactNode } from "react";
import { Check } from "lucide-react";

type Props = {
  icon?: ComponentType<{ className?: string }>;
  image?: string;
  tone?: "primary" | "success";
  badge?: "check" | "none";
  children?: ReactNode;
};

/**
 * Friendly hero visual used at the top of milestone steps
 * (welcome, done). Soft pulsing halo + tilted tile + white icon card
 * + optional check badge. When `image` is passed, the logo floats
 * on the halo without the tile/card scaffolding.
 */
export function StepHero({
  icon: Icon,
  image,
  tone = "primary",
  badge = "none",
}: Props) {
  const isSuccess = tone === "success";

  if (image) {
    return (
      <div className="relative mx-auto mb-6 flex h-32 w-32 items-center justify-center">
        <div
          aria-hidden
          className={
            "absolute -inset-6 rounded-[40px] blur-2xl opacity-60 " +
            (isSuccess ? "bg-emerald-200/50" : "bg-primary/20")
          }
        />
        <div className="relative z-10 flex h-28 w-28 items-center justify-center rounded-3xl border border-border/60 bg-card shadow-[0_10px_30px_-12px_rgba(0,0,0,0.15)]">
          <img src={image} alt="" className="h-full w-full rounded-3xl object-cover" />
        </div>
      </div>
    );
  }

  return (
    <div className="relative mx-auto mb-8 flex h-40 w-40 items-center justify-center">
      <div
        className={
          "absolute inset-0 rounded-full opacity-60 animate-pulse " +
          (isSuccess ? "bg-emerald-100" : "bg-primary/10")
        }
      />
      <div
        className={
          "absolute h-28 w-28 rotate-12 rounded-2xl " +
          (isSuccess ? "bg-emerald-200/60" : "bg-primary/15")
        }
      />
      <div className="relative z-10 flex h-20 w-20 items-center justify-center rounded-2xl border border-border/60 bg-card shadow-lg">
        {Icon && (
          <Icon
            className={
              "h-9 w-9 " + (isSuccess ? "text-emerald-600" : "text-primary")
            }
          />
        )}
      </div>
      {badge === "check" && (
        <div className="absolute -bottom-1 -right-1 z-20 flex h-10 w-10 items-center justify-center rounded-full bg-primary text-primary-foreground shadow-lg">
          <Check className="h-5 w-5" strokeWidth={3} />
        </div>
      )}
    </div>
  );
}


export function StepHeader({
  title,
  description,
  align = "center",
}: {
  title: ReactNode;
  description?: ReactNode;
  align?: "center" | "left";
}) {
  const isLeft = align === "left";
  return (
    <div className={isLeft ? "text-left" : "text-center"}>
      <h2 className="text-[26px] font-semibold tracking-tight text-foreground">
        {title}
      </h2>
      {description && (
        <p
          className={
            "mt-3 text-[15px] leading-relaxed text-muted-foreground " +
            (isLeft ? "max-w-[520px]" : "mx-auto max-w-[440px]")
          }
        >
          {description}
        </p>
      )}
    </div>
  );
}

