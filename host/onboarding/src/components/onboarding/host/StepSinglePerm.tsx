import type { ComponentType } from "react";
import {
  Accessibility,
  Check,
  ExternalLink,
  HardDrive,
  Loader2,
  Monitor,
  Network,
  Terminal,
} from "lucide-react";
import { Button } from "@shared/components/ui/button";
import { StepHeader } from "@shared/components/onboarding/StepHero";
import { useT } from "@/lib/i18n";

export type PermKey = "login" | "ax" | "sr" | "fda" | "sharing";
export type PermStatus = "pending" | "opening" | "granted";
export type PermState = Record<PermKey, PermStatus>;

export const PERM_ORDER: PermKey[] = ["login", "ax", "sr", "fda", "sharing"];
// All five are required: ax/sr/login gate serving, and both Full Disk Access and File Sharing
// are needed for the SMB /Volumes mount path — allGranted() gates serving on the full set.
export const REQUIRED_PERMS: PermKey[] = ["login", "ax", "sr", "fda", "sharing"];

export function isRequiredPerm(k: PermKey | null): k is PermKey {
  return k !== null && REQUIRED_PERMS.includes(k);
}

export const ICONS: Record<PermKey, ComponentType<{ className?: string }>> = {
  login: Terminal,
  ax: Accessibility,
  sr: Monitor,
  fda: HardDrive,
  sharing: Network,
};

type Props = {
  permKey: PermKey;
  status: PermStatus;
  onOpen: () => void;
};

export function StepSinglePerm({ permKey, status, onOpen }: Props) {
  const { t } = useT();
  const Icon = ICONS[permKey];
  const granted = status === "granted";
  const opening = status === "opening";
  const stepNum = PERM_ORDER.indexOf(permKey) + 1;
  const required = isRequiredPerm(permKey);

  const name = t(`perm.${permKey}.name`);
  const desc = t(`perm.${permKey}.desc`);
  const pane = t(`perm.${permKey}.pane`);

  return (
    <div>
      <StepHeader title={name} description={desc} />

      <div className="mx-auto mt-8 max-w-[520px]">
        <div className="text-center text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
          {t("perm.of", { n: stepNum, total: PERM_ORDER.length })}
        </div>

        <div
          className={
            "mt-4 flex flex-col items-center rounded-2xl border p-6 text-center transition-colors " +
            (granted
              ? "border-emerald-300/60 bg-emerald-50/60"
              : "border-border bg-muted/20")
          }
        >
          <div
            className={
              "flex h-14 w-14 items-center justify-center rounded-2xl " +
              (granted ? "bg-emerald-500 text-white" : "bg-card text-primary shadow-sm")
            }
          >
            {granted ? (
              <Check className="h-6 w-6" strokeWidth={3} />
            ) : (
              <Icon className="h-6 w-6" />
            )}
          </div>

          <div className="mt-4 font-mono text-xs text-muted-foreground">{pane}</div>
          {!required && !granted ? (
            <div className="mt-2 text-xs font-medium text-muted-foreground">
              {t("perm.recommendedContinue")}
            </div>
          ) : null}

          <div className="mt-5">
            {granted ? (
              <div className="text-sm font-medium text-emerald-700">
                {t("perm.granted")}
              </div>
            ) : (
              <Button onClick={onOpen} disabled={opening} size="lg">
                {opening ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    {t("perm.waiting")}
                  </>
                ) : (
                  <>
                    <ExternalLink className="mr-2 h-4 w-4" />
                    {t("perm.openSettings")}
                  </>
                )}
              </Button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
