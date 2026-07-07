import { StepHero, StepHeader } from "@shared/components/onboarding/StepHero";
import { LangToggle } from "@shared/components/onboarding/LangToggle";
import { useT } from "@/lib/i18n";
import logoUrl from "@shared/assets/xpair-logo.png";

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
