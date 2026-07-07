import type { LucideIcon } from "lucide-react";
import { AlertTriangle, ExternalLink } from "lucide-react";
import { Button } from "@/components/ui/button";

export type DeadEndAction = {
  label: string;
  onClick?: () => void;
  href?: string;
  variant?: "default" | "outline" | "ghost";
};

type Props = {
  icon?: LucideIcon;
  tone?: "warning" | "danger" | "neutral";
  title: string;
  description: string;
  detail?: string;
  actions?: DeadEndAction[];
};

const TONE = {
  warning: "bg-amber-500/10 text-amber-600",
  danger: "bg-rose-500/10 text-rose-600",
  neutral: "bg-muted text-muted-foreground",
} as const;

export function StepDeadEnd({
  icon: Icon = AlertTriangle,
  tone = "warning",
  title,
  description,
  detail,
  actions = [],
}: Props) {
  return (
    <div className="flex h-full flex-col items-center justify-center text-center">
      <div
        className={`mb-6 flex h-16 w-16 items-center justify-center rounded-2xl ${TONE[tone]}`}
      >
        <Icon className="h-7 w-7" />
      </div>
      <h2 className="text-xl font-semibold tracking-tight text-foreground">
        {title}
      </h2>
      <p className="mt-2 max-w-sm text-sm text-muted-foreground">
        {description}
      </p>
      {detail && (
        <div className="mt-5 w-full max-w-sm rounded-xl border border-border bg-muted/30 px-4 py-3 text-left font-mono text-xs text-muted-foreground">
          {detail}
        </div>
      )}
      {actions.length > 0 && (
        <div className="mt-6 flex flex-wrap items-center justify-center gap-2">
          {actions.map((a, i) =>
            a.href ? (
              <a
                key={i}
                href={a.href}
                target={a.href.startsWith("http") ? "_blank" : undefined}
                rel="noreferrer"
                className="inline-flex items-center gap-1.5 rounded-md border border-border bg-card px-3 py-1.5 text-sm text-foreground hover:bg-muted"
              >
                {a.label}
                {a.href.startsWith("http") && (
                  <ExternalLink className="h-3.5 w-3.5" />
                )}
              </a>
            ) : (
              <Button
                key={i}
                size="sm"
                variant={a.variant ?? (i === 0 ? "default" : "outline")}
                onClick={a.onClick}
              >
                {a.label}
              </Button>
            ),
          )}
        </div>
      )}
    </div>
  );
}
