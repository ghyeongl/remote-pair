import { useState } from "react";
import { ArrowUpCircle, Check, Loader2, ShieldAlert } from "lucide-react";
import { Button } from "@shared/components/ui/button";
import { InstallProgressBar } from "@shared/components/onboarding/InstallProgressBar";
import { StepDeadEnd } from "@shared/components/onboarding/StepDeadEnd";
import { useT } from "@/lib/i18n";
import type { DiscoveredHost } from "./StepDiscover";

export type UpdateState = "idle" | "updating" | "done";

type Props = {
  host: DiscoveredHost | null;
  state: UpdateState;
  setState: (s: UpdateState) => void;
  pct: number;
  setPct: (n: number) => void;
  onBackToDiscover?: () => void;
  onRepairPairing?: () => void;
};

export function StepUpdate({
  host,
  state,
  setState,
  pct,
  setPct,
  onBackToDiscover,
  onRepairPairing,
}: Props) {
  const { t } = useT();
  const [error, setError] = useState("");
  const needsUpdate = !!host?.outdated && !host.majorMismatch;
  const majorMismatch = !!host?.majorMismatch;

  const runUpdate = async () => {
    if (!host) return;
    setError("");
    setPct(8);
    setState("updating");
    try {
      const target = host.sshTarget ?? host.address;
      const installed = await window.remotepair.installHost({ host: target, force: true });
      setPct(65);
      if (!installed.ok) {
        if (installed.action === "prompt_password") {
          setPct(0);
          setState("idle");
          onRepairPairing?.();
          return;
        }
        setError(installed.err || t("update.error"));
        setPct(0);
        setState("idle");
        return;
      }

      const status = await window.remotepair.hostAppStatus(target);
      setPct(90);
      if (status.compatible) {
        // `xpair install-host` normalizes a user-qualified target (user@addr) to a bare host and writes
        // REMOTE_HOST=<bare> — so an already-paired below-floor host loses its login user after the
        // update, and later heartbeat/launch/RD connect as the local username and fail. Re-save the
        // original account-qualified target (`config set host` preserves user@addr).
        const saved = await window.remotepair.setHost(target);
        if (saved && saved.code !== 0) {
          setError(saved.err || saved.out || t("update.error"));
          setPct(0);
          setState("idle");
          return;
        }
        setPct(100);
        setState("done");
        return;
      }
      setError(status.err || t("update.error"));
      setPct(0);
      setState("idle");
    } catch (e) {
      setError(String(e));
      setPct(0);
      setState("idle");
    }
  };

  if (majorMismatch) {
    return (
      <StepDeadEnd
        icon={ShieldAlert}
        tone="danger"
        title={t("update.tooNew.title")}
        description={t("update.tooNew.desc")}
        detail={`${host?.name} · v${host?.version}\n${t("update.clientSupports")}`}
        actions={[
          { label: t("update.checkClientUpdates"), href: "https://xpair.app/download" },
          { label: t("update.pickAnother"), variant: "outline", onClick: onBackToDiscover },
        ]}
      />
    );
  }

  if (!needsUpdate) {
    return (
      <div className="flex h-full flex-col items-center justify-center py-6 text-center">
        <div className="mb-4 flex h-14 w-14 items-center justify-center rounded-full bg-emerald-100 text-emerald-600">
          <Check className="h-6 w-6" strokeWidth={3} />
        </div>
        <p className="text-sm text-muted-foreground">
          <span className="font-mono text-foreground">{host?.name}</span> {t("update.upToDate")}
        </p>
      </div>
    );
  }

  return (
    <div>
      <div className="flex flex-col items-center text-center">
        <div className="mb-6 flex h-16 w-16 items-center justify-center rounded-2xl bg-amber-500/10 text-amber-600">
          <ArrowUpCircle className="h-7 w-7" />
        </div>
        <h2 className="text-xl font-semibold tracking-tight text-foreground">
          {t("update.title")}
        </h2>
        <p className="mt-2 max-w-sm text-sm text-muted-foreground">
          <span className="font-mono">{host?.name}</span> {t("update.descPre")} v
          {host?.version || "…"}
          {t("update.descPost")}
        </p>
      </div>

      <div className="mt-6 rounded-xl border border-border bg-card p-4">
        <div className="mb-3 flex items-center justify-between">
          <div>
            <div className="text-sm font-medium text-foreground">{t("update.pushTitle")}</div>
            <div className="text-xs text-muted-foreground">{t("update.pushDesc")}</div>
          </div>
          <Button
            size="sm"
            onClick={() => void runUpdate()}
            disabled={state === "updating" || state === "done"}
          >
            {state === "updating" ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : state === "done" ? (
              <Check className="h-3.5 w-3.5" />
            ) : (
              t("update.now")
            )}
          </Button>
        </div>
        {(state === "updating" || state === "done") && (
          <InstallProgressBar
            label={state === "done" ? t("update.updated") : t("update.updating")}
            percent={pct}
          />
        )}
        {error && <p className="mt-3 text-xs text-destructive">{error}</p>}
      </div>
    </div>
  );
}
