import { useEffect, useState } from "react";
import { Check, Shield, ShieldX } from "lucide-react";
import { Button } from "@/components/ui/button";
import { StepDeadEnd } from "@/components/onboarding/StepDeadEnd";
import { useT } from "@/lib/i18n";
import type { DiscoveredHost } from "./StepDiscover";

type Props = {
  host: DiscoveredHost | null;
  accepted: boolean;
  setAccepted: (v: boolean) => void;
  denied: boolean;
  onDeny: () => void;
  onRetry: () => void;
  onPickAnother: () => void;
};

export function StepWaitPerm({
  host,
  accepted,
  setAccepted,
  denied,
  onDeny,
  onRetry,
  onPickAnother,
}: Props) {
  const { t } = useT();
  const [dots, setDots] = useState(1);
  const [error, setError] = useState("");
  const [clientFingerprint, setClientFingerprint] = useState("");
  const [retryNonce, setRetryNonce] = useState(0);

  useEffect(() => {
    if (accepted || denied) return;
    const tm = setInterval(() => setDots((d) => (d % 3) + 1), 500);
    return () => clearInterval(tm);
  }, [accepted, denied]);

  useEffect(() => {
    if (!host || accepted || denied) return;
    const missingPairingFields =
      !host.hostKeyFP || !host.serviceInstanceID || !host.hostNonce || !host.pairPort;
    if (missingPairingFields) {
      if (host.pairingMetaStatus === "error") {
        setError(
          host.pairingMetaError ||
            "Host is not broadcasting pairing details. Open Connect on the host, then rescan.",
        );
      } else {
        setError("");
      }
      return;
    }

    let stopped = false;
    let pollTimer: number | undefined;
    let sendTimer: number | undefined;
    let lastFingerprint = "";
    const pairingHost = host.pairingAddress ?? host.address;
    const sshTarget = host.sshTarget ?? host.address;
    const clearTimers = () => {
      if (pollTimer !== undefined) window.clearInterval(pollTimer);
      if (sendTimer !== undefined) window.clearInterval(sendTimer);
      pollTimer = undefined;
      sendTimer = undefined;
    };
    const poll = async (expectedFingerprint: string) => {
      try {
        const status = await window.remotepair.pairingStatus({
          host: sshTarget,
          pairingHost,
        });
        if (stopped) return;
        if (status.paired && (!expectedFingerprint || status.fingerprint === expectedFingerprint)) {
          clearTimers();
          const pinned = await window.remotepair.pinHostKey(sshTarget, host.hostKeyFP!);
          if (!pinned.ok) {
            if (!stopped) setError(pinned.err || "Could not save the confirmed host key.");
            return;
          }
          const saved = await window.remotepair.setHost(sshTarget);
          if (saved && saved.code !== 0) {
            if (!stopped) {
              setError(saved.err || saved.out || "Could not save the paired host.");
            }
            return;
          }
          if (!stopped) setAccepted(true);
          return;
        }
        if (status.denied) {
          clearTimers();
          onDeny();
          return;
        }
        if (status.err && !status.pending) setError(status.err);
      } catch (err) {
        if (!stopped) setError(err instanceof Error ? err.message : String(err));
      }
    };

    void (async () => {
      setError("");
      setClientFingerprint("");
      const sendOnce = async () => {
        const sent = await window.remotepair.sendPairingRequest({
          host: pairingHost,
          port: host.pairPort!,
          hostKeyFP: host.hostKeyFP!,
          hostNonce: host.hostNonce!,
          serviceInstanceID: host.serviceInstanceID!,
        });
        if (stopped) return;
        if (!sent.ok) {
          setError(sent.err || "Could not send pairing request.");
          return;
        }
        lastFingerprint = sent.fingerprint;
        setClientFingerprint(sent.fingerprint);
        setError("");
        if (pollTimer === undefined) {
          await poll(sent.fingerprint);
          if (!stopped && pollTimer === undefined) {
            pollTimer = window.setInterval(() => void poll(lastFingerprint), 1500);
          }
        }
      };
      await sendOnce();
      if (!stopped) sendTimer = window.setInterval(() => void sendOnce(), 2000);
    })().catch((err) => {
      if (!stopped) setError(err instanceof Error ? err.message : String(err));
    });

    return () => {
      stopped = true;
      clearTimers();
    };
  }, [
    accepted,
    denied,
    host?.address,
    host?.pairingAddress,
    host?.sshTarget,
    host?.hostKeyFP,
    host?.hostNonce,
    host?.pairPort,
    host?.pairingMetaError,
    host?.pairingMetaStatus,
    host?.serviceInstanceID,
    onDeny,
    retryNonce,
    setAccepted,
  ]);

  if (denied) {
    return (
      <StepDeadEnd
        icon={ShieldX}
        tone="danger"
        title={t("wait.denied.title")}
        description={t("wait.denied.desc")}
        detail={`${host?.name} · ${host?.address}`}
        actions={[
          { label: t("wait.tryAgain"), onClick: onRetry },
          { label: t("wait.pickAnother"), variant: "outline", onClick: onPickAnother },
        ]}
      />
    );
  }

  if (accepted) {
    return (
      <div className="flex flex-col items-center text-center">
        <div className="mb-6 flex h-16 w-16 items-center justify-center rounded-full bg-primary/10 text-primary">
          <Check className="h-7 w-7" />
        </div>
        <h2 className="text-xl font-semibold tracking-tight text-foreground">
          {t("wait.accepted.title")}
        </h2>
        <p className="mt-2 max-w-sm text-sm text-muted-foreground">
          {t("wait.accepted.descPre")}{" "}
          <span className="font-mono">{host?.name}</span>
          {t("wait.accepted.descPost")}
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col items-center text-center">
      <div className="relative mb-6 h-20 w-20">
        <span className="radar-ring" />
        <span className="radar-ring" style={{ animationDelay: "0.7s" }} />
        <div className="absolute inset-0 flex items-center justify-center">
          <div className="soft-pulse flex h-12 w-12 items-center justify-center rounded-full bg-primary/15 text-primary">
            <Shield className="h-5 w-5" />
          </div>
        </div>
      </div>

      <h2 className="text-xl font-semibold tracking-tight text-foreground">
        {t("wait.title")}{".".repeat(dots)}
      </h2>
      <p className="mt-2 max-w-sm text-sm text-muted-foreground">
        {t("wait.descPre")} <span className="font-mono">{host?.name}</span>
        {t("wait.descPost")}
      </p>

      <div className="mt-6 w-full max-w-xs rounded-xl border border-border bg-muted/30 px-4 py-3 text-left">
        <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
          {t("wait.requestingFrom")}
        </div>
        <div className="mt-1 font-mono text-sm text-foreground">{host?.name}</div>
        <div className="mt-0.5 font-mono text-xs text-muted-foreground">{host?.address}</div>
        {clientFingerprint ? (
          <div className="mt-2 break-all font-mono text-[11px] text-muted-foreground">
            {clientFingerprint}
          </div>
        ) : null}
      </div>

      {error ? <p className="mt-4 max-w-sm text-xs text-destructive">{error}</p> : null}
      {error ? (
        <div className="mt-4 flex items-center gap-3">
          <Button
            size="sm"
            variant="secondary"
            onClick={() => {
              setError("");
              setRetryNonce((n) => n + 1);
              onRetry();
            }}
          >
            {t("wait.tryAgain")}
          </Button>
          <Button size="sm" variant="outline" onClick={onPickAnother}>
            {t("wait.pickAnother")}
          </Button>
        </div>
      ) : null}
    </div>
  );
}
