import type { ReactNode } from "react";
import { ChevronLeft } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useT } from "@/lib/i18n";

type Props = {
  title?: string;
  subtitle?: string;
  step: number;
  totalSteps: number;
  onPrev?: () => void;
  onNext?: () => void;
  nextLabel?: string;
  nextDisabled?: boolean;
  hidePrev?: boolean;
  hideFooter?: boolean;
  footerSlot?: ReactNode;
  centerSlot?: ReactNode;
  statusBar?: ReactNode;
  children: ReactNode;
};

export function WizardShell({
  step,
  onPrev,
  onNext,
  nextLabel,
  nextDisabled,
  hidePrev,
  hideFooter,
  footerSlot,
  centerSlot,
  statusBar,
  children,
}: Props) {
  const { t } = useT();

  return (
    <div className="flex min-h-screen items-center justify-center bg-muted/40 px-4 py-10">
      <div className="w-[720px]">
        <div className="overflow-hidden rounded-3xl border border-border/60 bg-card shadow-[0_20px_50px_-12px_rgba(15,23,42,0.15)]">
          <div className="h-[440px] overflow-y-auto px-10 pb-8 pt-10">
            {children}
          </div>

          {!hideFooter && (
            <div className="grid grid-cols-[1fr_minmax(0,220px)_1fr] items-center gap-3 border-t border-border/60 bg-muted/30 px-8 py-5">
              <div className="justify-self-start">
                {!hidePrev && step > 0 && (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={onPrev}
                    className="text-muted-foreground hover:text-foreground"
                  >
                    <ChevronLeft className="mr-1 h-4 w-4" />
                    {t("shell.back")}
                  </Button>
                )}
              </div>
              <div className="min-w-0 justify-self-center">{centerSlot}</div>
              <div className="flex items-center justify-end gap-2">
                {footerSlot}
                {onNext && (
                  <Button
                    onClick={onNext}
                    disabled={nextDisabled}
                    className="rounded-xl px-6 shadow-[0_8px_20px_-6px_color-mix(in_oklab,var(--color-primary)_55%,transparent)] transition-transform hover:-translate-y-0.5"
                  >
                    {nextLabel ?? t("shell.next")}
                  </Button>
                )}
              </div>
            </div>
          )}

          {statusBar}
        </div>
      </div>
    </div>
  );
}
