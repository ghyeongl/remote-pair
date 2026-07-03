import { ShieldCheck, BarChart3 } from "lucide-react";
import { StepHeader } from "@/components/onboarding/StepHero";
import { useT } from "@/lib/i18n";

export type ConsentKind = "crash" | "analytics";

type Props = {
  kind: ConsentKind;
  value: boolean;
  onChange: (v: boolean) => void;
};

export function StepConsent({ kind, value, onChange }: Props) {
  const { t } = useT();
  const icon =
    kind === "crash" ? (
      <ShieldCheck className="h-6 w-6" />
    ) : (
      <BarChart3 className="h-6 w-6" />
    );
  const recommended = kind === "crash";
  const title = t(`consent.${kind}.title`);
  const desc = t(`consent.${kind}.desc`);
  const label = t(`consent.${kind}.label`);
  const sub = t(`consent.${kind}.sub`);

  return (
    <div>
      <StepHeader title={title} description={desc} align="left" />

      <button
        type="button"
        onClick={() => onChange(!value)}
        className="mt-8 flex w-full items-center gap-4 rounded-2xl border border-border bg-card p-5 text-left transition-colors hover:bg-accent/40"
      >
        <div
          className={
            "flex h-12 w-12 shrink-0 items-center justify-center rounded-xl transition-colors " +
            (value ? "bg-primary/10 text-primary" : "bg-muted text-muted-foreground")
          }
        >
          {icon}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <div className="text-base font-medium text-foreground">{label}</div>
            {recommended && (
              <span className="rounded-full bg-primary/10 px-2 py-0.5 text-[10px] font-medium text-primary">
                {t("consent.recommended")}
              </span>
            )}
          </div>
          <div className="mt-1 text-xs text-muted-foreground">{sub}</div>
        </div>
        <span
          role="switch"
          aria-checked={value}
          className={
            "relative inline-flex h-7 w-12 shrink-0 items-center rounded-full transition-colors " +
            (value ? "bg-primary" : "bg-muted-foreground/25")
          }
        >
          <span
            className={
              "inline-block h-6 w-6 transform rounded-full bg-white shadow transition-transform " +
              (value ? "translate-x-[22px]" : "translate-x-0.5")
            }
          />
        </span>
      </button>
    </div>
  );
}
