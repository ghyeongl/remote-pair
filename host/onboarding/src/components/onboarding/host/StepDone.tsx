import { Sparkles, MenuSquare } from "lucide-react";
import { StepHero, StepHeader } from "../StepHero";
import { useT } from "@/lib/i18n";

export function StepDone() {
  const { t } = useT();
  return (
    <div>
      <StepHero icon={Sparkles} tone="success" />
      <StepHeader title={t("done.host.title")} description={t("done.host.desc")} />
      <div className="mx-auto mt-5 flex max-w-sm items-center gap-3 rounded-2xl border border-border/60 bg-muted/30 p-4">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">
          <MenuSquare className="h-5 w-5" />
        </div>
        <p className="text-sm text-muted-foreground">{t("done.host.menubar")}</p>
      </div>
    </div>
  );
}
