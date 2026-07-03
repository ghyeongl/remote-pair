import { StepHero, StepHeader } from "@/components/onboarding/StepHero";
import { LangToggle } from "@/components/onboarding/LangToggle";
import { useT } from "@/lib/i18n";
import logoUrl from "@/assets/xpair-logo.png";

export function StepWelcome() {
  const { t } = useT();
  return (
    <div>
      <StepHero image={logoUrl} />
      <StepHeader title={t("client.welcome.title")} description={t("client.welcome.desc")} />
      <LangToggle />
    </div>
  );
}
