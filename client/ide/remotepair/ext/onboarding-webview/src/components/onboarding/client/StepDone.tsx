import { Check, Sparkles } from "lucide-react";
import type { Mapping } from "./StepMappings";
import type { DiscoveredHost } from "./StepDiscover";
import { StepHero, StepHeader } from "@/components/onboarding/StepHero";
import { useT } from "@/lib/i18n";

type Props = { host: DiscoveredHost | null; mappings: Mapping[] };

export function StepDone({ host, mappings }: Props) {
  const { t } = useT();
  return (
    <div>
      <StepHero icon={Sparkles} tone="success" />
      <StepHeader
        title={t("done.client.title")}
        description={
          <>
            {t("done.client.pairedWith")}{" "}
            <span className="font-mono text-foreground">
              {host?.name ?? t("done.client.yourHost")}
            </span>
            {t("done.client.workspaceReady")}
          </>
        }
      />

      <div className="mx-auto mt-5 max-w-sm rounded-2xl border border-border/60 bg-muted/30 p-4">
        <SummaryRow label={t("done.host")} value={host?.name ?? t("shell.notAvailable")} mono />
        <SummaryRow label={t("done.transport")} value={host?.transport ?? t("shell.notAvailable")} />
        <SummaryRow
          label={t("done.mappings")}
          value={`${mappings.length} ${
            mappings.length === 1 ? t("done.folder") : t("done.folders")
          }`}
        />
      </div>
    </div>
  );
}

function SummaryRow({
  label,
  value,
  mono,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div className="flex items-center justify-between py-1 text-sm">
      <span className="flex items-center gap-2 text-muted-foreground">
        <Check className="h-3.5 w-3.5 text-emerald-500" />
        {label}
      </span>
      <span className={mono ? "font-mono text-foreground" : "text-foreground"}>{value}</span>
    </div>
  );
}
