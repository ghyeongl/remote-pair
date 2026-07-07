import { StepHero, StepHeader } from "../StepHero";
import { LangToggle } from "../LangToggle";
import { useT } from "@/lib/i18n";
import logoUrl from "@/assets/xpair-logo.png";

export function StepWelcome() {
  const { t } = useT();
  return (
    <div>
      <StepHero image={logoUrl} />
      <StepHeader title={t("host.welcome.title")} description={t("host.welcome.desc")} />
      <LangToggle />
    </div>
  );
}
