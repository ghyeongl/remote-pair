import { useEffect, useState } from "react";
import { Check, Fingerprint, Laptop, Loader2, Radio, ShieldAlert, ShieldX } from "lucide-react";
import { Button } from "@shared/components/ui/button";
import { useT } from "@/lib/i18n";

export type IncomingRequest = {
  id: string;
  name: string;
  ip: string;
  user: string;
  keyFingerprint: string;
};

export type BroadcastState =
  | "waiting"
  | "incoming"
  | "accepted-pending-proof"
  | "accepted"
  | "denied";

type Props = {
  state: BroadcastState;
  setState: (s: BroadcastState) => void;
  request: IncomingRequest | null;
  setRequest: (r: IncomingRequest | null) => void;
  error?: string;
  onBroadcastAgain: () => void | Promise<void>;
};

export function StepBroadcast({
  state,
  setState,
  request,
  setRequest,
  error,
  onBroadcastAgain,
}: Props) {
  const { t } = useT();
  const [dots, setDots] = useState(1);
  // Real machine name for the "this Mac" label — the pairing approval screen must identify THIS host,
  // not a hardcoded mockup value, or the user approves a client against the wrong machine.
  const [hostname, setHostname] = useState("");
  useEffect(() => {
    let alive = true;
    void window.xpair
      .getHostInfo()
      .then((info) => {
        if (alive) setHostname(info?.hostname || "");
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    if (state !== "waiting") return;
    const tm = setInterval(() => setDots((d) => (d % 3) + 1), 500);
    return () => clearInterval(tm);
  }, [state]);

  if (state === "denied") {
    return (
      <div className="flex h-full flex-col items-center justify-center text-center">
        <div className="mb-6 flex h-16 w-16 items-center justify-center rounded-2xl bg-rose-500/10 text-rose-600">
          <ShieldX className="h-7 w-7" />
        </div>
        <h2 className="text-xl font-semibold tracking-tight text-foreground">
          {t("bc.denied.title")}
        </h2>
        <p className="mt-2 max-w-sm text-sm text-muted-foreground">{t("bc.denied.desc")}</p>
        <Button
          size="sm"
          className="mt-6"
          onClick={() => {
            setRequest(null);
            setState("waiting");
            void onBroadcastAgain();
          }}
        >
          {t("bc.broadcastAgain")}
        </Button>
      </div>
    );
  }

  if (state === "accepted-pending-proof") {
    return (
      <div className="flex flex-col items-center text-center">
        <div className="mb-6 flex h-16 w-16 items-center justify-center rounded-full bg-primary/10 text-primary">
          <Loader2 className="h-7 w-7 animate-spin" />
        </div>
        <h2 className="text-xl font-semibold tracking-tight text-foreground">
          {t("bc.pending.title")}
        </h2>
        <p className="mt-2 max-w-sm text-sm text-muted-foreground">{t("bc.pending.desc")}</p>
        <div className="mt-6 w-full max-w-xs rounded-xl border border-primary/30 bg-primary/5 px-4 py-3 text-left">
          <div className="mb-2 flex items-center gap-2 text-[10px] uppercase tracking-wide text-primary">
            <Fingerprint className="h-3 w-3" />
            {t("bc.fingerprint")}
          </div>
          <div className="font-mono text-[13px] leading-relaxed text-foreground break-all">
            {request?.keyFingerprint}
          </div>
        </div>
      </div>
    );
  }

  if (state === "accepted") {
    return (
      <div className="flex flex-col items-center text-center">
        <div className="mb-6 flex h-16 w-16 items-center justify-center rounded-full bg-primary/10 text-primary">
          <Check className="h-7 w-7" />
        </div>
        <h2 className="text-xl font-semibold tracking-tight text-foreground">
          {t("bc.paired.title")}
        </h2>
        <p className="mt-2 max-w-sm text-sm text-muted-foreground">{t("bc.paired.desc")}</p>
        <div className="mt-6 w-full max-w-xs rounded-xl border border-primary/30 bg-primary/5 px-4 py-3 text-left">
          <div className="mb-2 flex items-center gap-2 text-[10px] uppercase tracking-wide text-primary">
            <Laptop className="h-3 w-3" />
            {t("bc.pairedWith")}
          </div>
          <div className="font-mono text-sm text-foreground">{request?.name}</div>
          <div className="mt-0.5 font-mono text-xs text-muted-foreground">
            {request?.user}@{request?.ip}
          </div>
        </div>
        {/* Re-advertise a fresh pairing window (force=true) so a replacement/additional device can pair
            without manually editing the ledger — the documented Broadcast recovery. */}
        <Button
          variant="ghost"
          size="sm"
          className="mt-4"
          onClick={() => {
            setRequest(null);
            setState("waiting");
            void onBroadcastAgain();
          }}
        >
          {t("bc.pairAnother")}
        </Button>
      </div>
    );
  }

  if (state === "incoming" && request) {
    return (
      <div className="flex flex-col items-center text-center">
        <div className="mb-6 flex h-16 w-16 items-center justify-center rounded-2xl bg-primary/10 text-primary">
          <Laptop className="h-7 w-7" />
        </div>
        <h2 className="text-xl font-semibold tracking-tight text-foreground">
          {t("bc.incoming.title")}
        </h2>
        <p className="mt-2 max-w-sm text-sm text-muted-foreground">{t("bc.incoming.desc")}</p>

        <div className="mt-6 w-full max-w-sm rounded-xl border border-border bg-card p-4 text-left">
          <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
            {t("bc.from")}
          </div>
          <div className="mt-1 font-mono text-sm text-foreground">{request.name}</div>
          <div className="mt-0.5 font-mono text-xs text-muted-foreground">
            {request.user}@{request.ip}
          </div>

          <div className="mt-3 border-t border-border pt-3">
            <div className="mb-1 flex items-center gap-1.5 text-[10px] uppercase tracking-wide text-muted-foreground">
              <Fingerprint className="h-3 w-3" />
              {t("bc.fingerprint")}
            </div>
            <div className="font-mono text-[13px] leading-relaxed tracking-wide text-foreground break-all">
              {request.keyFingerprint}
            </div>
          </div>
        </div>

        <div className="mt-4 w-full max-w-sm rounded-xl border border-amber-500/30 bg-amber-500/5 p-3 text-left">
          <div className="mb-1.5 flex items-center gap-1.5 text-[10px] font-medium uppercase tracking-wide text-amber-700 dark:text-amber-500">
            <ShieldAlert className="h-3 w-3" />
            {t("bc.warnTitle")}
          </div>
          <ul className="space-y-1 text-xs leading-relaxed text-foreground/80">
            <li>• {t("bc.warn1")}</li>
            <li>• {t("bc.warn2")}</li>
            <li>• {t("bc.warn3")}</li>
          </ul>
          <p className="mt-2 text-[11px] text-muted-foreground">{t("bc.warnRevoke")}</p>
        </div>

      </div>
    );
  }

  return (
    <div className="flex flex-col items-center text-center">
      <div className="relative mb-6 h-20 w-20">
        <span className="radar-ring" />
        <span className="radar-ring" style={{ animationDelay: "0.7s" }} />
        <div className="absolute inset-0 flex items-center justify-center">
          <div className="flex h-12 w-12 items-center justify-center rounded-full bg-primary/15 text-primary soft-pulse">
            <Radio className="h-5 w-5" />
          </div>
        </div>
      </div>

      <h2 className="text-xl font-semibold tracking-tight text-foreground">
        {t("bc.title")}{".".repeat(dots)}
      </h2>
      <p className="mt-2 max-w-sm text-sm text-muted-foreground">{t("bc.desc")}</p>

      <div className="mt-6 w-full max-w-xs rounded-xl border border-border bg-muted/30 px-4 py-3 text-left">
        <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
          {t("bc.thisMac")}
        </div>
        <div className="mt-1 font-mono text-sm text-foreground">{hostname || "…"}</div>
      </div>

      {error ? <p className="mt-4 max-w-sm text-xs text-destructive">{error}</p> : null}
    </div>
  );
}
