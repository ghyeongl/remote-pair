import { useCallback, useEffect, useState } from "react";
import { Check, Download, ExternalLink, Loader2, RefreshCw, Wifi } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useT } from "@/lib/i18n";

export type DiscoveredHost = {
  id: string;
  name: string;
  address: string;
  pairingAddress?: string;
  sshTarget?: string;
  hostUser?: string;
  transport: "LAN" | "SSH" | "Tailscale";
  version: string;
  hostKeyFP?: string;
  serviceInstanceID?: string;
  hostNonce?: string;
  pairPort?: number;
  pairingMetaStatus?: "loading" | "ok" | "error";
  pairingMetaError?: string;
  outdated?: boolean;
  majorMismatch?: boolean;
  // True once probeSelectedHost has RESOLVED for this host (success or failure). The Update
  // auto-skip must not fire on the pre-probe default (outdated/majorMismatch both false) or a
  // slow SSH probe would skip an outdated host before its status is known.
  probed?: boolean;
};

type BridgePeer = Awaited<ReturnType<typeof window.remotepair.discover>>["peers"][number];

type Props = {
  selected: DiscoveredHost | null;
  setSelected: (h: DiscoveredHost | null) => void;
  // Set when onboarding was opened by the launch guard because the HOST's agent engine is missing/
  // unauthenticated (?startStep=engine). The client has no engine step, so surface a host-onboarding CTA.
  engineRecovery?: boolean;
};

export function peerToHost(peer: BridgePeer): DiscoveredHost {
  const pairingAddress = peer.pairingAddress ?? peer.addrs[0] ?? peer.name;
  const sshTarget =
    peer.target ?? (peer.hostUser ? `${peer.hostUser}@${pairingAddress}` : pairingAddress);
  const transport =
    peer.source === "lan" ? "LAN" : peer.source === "tailscale" ? "Tailscale" : "SSH";
  return {
    id: peer.fp ?? sshTarget ?? peer.name,
    name: peer.name,
    address: pairingAddress,
    pairingAddress,
    sshTarget,
    hostUser: peer.hostUser,
    transport,
    version: "",
    pairingMetaStatus: "loading",
  };
}

function transportLabelKey(transport: DiscoveredHost["transport"]) {
  if (transport === "LAN") return "discover.badge.lan";
  if (transport === "Tailscale") return "discover.badge.tailscale";
  return "discover.badge.ssh";
}

export function StepDiscover({ selected, setSelected, engineRecovery }: Props) {
  const { t } = useT();
  const [scanning, setScanning] = useState(true);
  const [hosts, setHosts] = useState<BridgePeer[]>([]);
  const [scanNonce, setScanNonce] = useState(0);
  const [scanError, setScanError] = useState("");
  const [openingHost, setOpeningHost] = useState(false);

  const rescan = useCallback(() => {
    setSelected(null);
    setScanning(true);
    setHosts([]);
    setScanError("");
    setScanNonce((nonce) => nonce + 1);
  }, [setSelected]);

  useEffect(() => {
    let stopped = false;
    const scan = async () => {
      setScanning(true);
      setScanError("");
      try {
        const cli = await window.remotepair.cliReady();
        if (!cli.ready) {
          const installed = await window.remotepair.installCli();
          if (!installed.ok) {
            if (!stopped) {
              setHosts([]);
              setScanError(installed.err || cli.err || "Could not install the xpair CLI.");
            }
            return;
          }
          const afterInstall = await window.remotepair.cliReady();
          if (!afterInstall.ready) {
            if (!stopped) {
              setHosts([]);
              setScanError(afterInstall.err || "xpair CLI installed but is not ready.");
            }
            return;
          }
        }
        const res = await window.remotepair.discover();
        if (stopped) return;
        if (res.err) setScanError(res.err);
        const byId = new Map<string, BridgePeer>();
        for (const peer of res.peers || []) {
          // A peer is selectable when discovery has enough evidence that it is an XpairHost. Pairing
          // fields are fetched directly from the host after selection, so discovery stays a listing hint.
          const isXpairHost = !!peer.fp || peer.status !== "setup";
          if (!isXpairHost) continue;
          const host = peerToHost(peer);
          byId.set(host.id, peer);
        }
        setHosts(Array.from(byId.values()));
      } catch (error) {
        if (!stopped) {
          setHosts([]);
          setScanError(error instanceof Error ? error.message : String(error));
        }
      } finally {
        if (!stopped) setScanning(false);
      }
    };
    void scan();
    return () => {
      stopped = true;
    };
  }, [scanNonce]);

  const chooseHost = (peer: BridgePeer) => {
    setSelected(peerToHost(peer));
  };

  const openHostOnboarding = useCallback(async () => {
    setOpeningHost(true);
    setScanError("");
    try {
      const res = await window.remotepair.openHostOnboarding();
      if (!res.ok) setScanError(res.err || "Could not open host onboarding.");
    } catch (error) {
      setScanError(error instanceof Error ? error.message : String(error));
    } finally {
      setOpeningHost(false);
    }
  }, []);

  const empty = !scanning && hosts.length === 0;

  return (
    <div>
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-xl font-semibold tracking-tight text-foreground">
            {t("discover.title")}
          </h2>
          <p className="mt-1.5 text-sm text-muted-foreground">
            {t("discover.desc")}
          </p>
        </div>
        <Button
          size="sm"
          variant="ghost"
          onClick={rescan}
          disabled={scanning}
        >
          {scanning ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <RefreshCw className="h-3.5 w-3.5" />
          )}
        </Button>
      </div>

      {engineRecovery && (
        <div className="mt-4 rounded-2xl border border-amber-500/30 bg-amber-500/5 p-4">
          <h3 className="text-sm font-semibold text-foreground">
            {t("discover.engineRecovery.title")}
          </h3>
          <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">
            {t("discover.engineRecovery.desc")}
          </p>
          <Button size="sm" className="mt-3" onClick={openHostOnboarding} disabled={openingHost}>
            {t("discover.openHost")}
            <ExternalLink className="h-3.5 w-3.5" />
          </Button>
        </div>
      )}

      <div className="mt-5 space-y-2">
        {hosts.length === 0 && scanning && (
          <div className="rounded-2xl border border-border bg-card p-6">
            <div className="flex items-start gap-4">
              <div className="relative h-10 w-10 shrink-0">
                <span className="radar-ring" />
                <span className="radar-ring" style={{ animationDelay: "0.7s" }} />
                <div className="absolute inset-0 flex items-center justify-center text-primary">
                  <Wifi className="h-4 w-4" />
                </div>
              </div>
              <div className="min-w-0 flex-1">
                <h3 className="text-sm font-semibold text-foreground">
                  {t("discover.installedQ")}
                </h3>
                <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">
                  {t("discover.installedDesc")}
                </p>
                <div className="mt-4 flex items-center gap-3">
                  <Button size="sm" variant="outline" onClick={openHostOnboarding} disabled={openingHost}>
                    {t("discover.openHost")}
                    <ExternalLink className="h-3.5 w-3.5 text-muted-foreground" />
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={rescan}
                    disabled={scanning}
                  >
                    <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
                    {t("discover.rescan")}
                  </Button>
                </div>
              </div>
            </div>
          </div>
        )}

        {scanError ? (
          <p className="rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">
            {scanError}
          </p>
        ) : null}

        {hosts.map((peer) => {
          const h = peerToHost(peer);
          const host = selected?.id === h.id ? { ...h, ...selected } : h;
          return (
            <HostRow
              key={h.id}
              host={host}
              selected={selected?.id === h.id}
              onSelect={() => chooseHost(peer)}
            />
          );
        })}

        {empty && (
          <div className="rounded-2xl border border-border bg-card p-6 text-center">
            <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-muted text-muted-foreground">
              <Download className="h-5 w-5" />
            </div>
            <h3 className="mt-4 text-sm font-semibold text-foreground">
              {t("discover.empty.title")}
            </h3>
            <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">
              {t("discover.empty.desc")}
            </p>
            <div className="mt-4 flex flex-col items-center gap-3">
              <Button size="sm" variant="outline" onClick={openHostOnboarding} disabled={openingHost}>
                {t("discover.openHost")}
                <ExternalLink className="h-3.5 w-3.5 text-muted-foreground" />
              </Button>
              <Button size="sm" variant="secondary" onClick={rescan}>
                <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
                {t("discover.rescan")}
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function HostRow({
  host,
  selected,
  onSelect,
}: {
  host: DiscoveredHost;
  selected: boolean;
  onSelect: () => void;
}) {
  const { t } = useT();
  return (
    <button
      type="button"
      onClick={onSelect}
      className={
        "flex w-full items-center gap-3 rounded-xl border px-4 py-3 text-left transition-colors " +
        (selected
          ? "border-primary/40 bg-primary/5"
          : "border-border bg-card hover:border-foreground/20")
      }
    >
      <div
        className={
          "flex h-5 w-5 shrink-0 items-center justify-center rounded-full border " +
          (selected
            ? "border-primary bg-primary text-primary-foreground"
            : "border-border bg-background")
        }
      >
        {selected && <Check className="h-3 w-3" />}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate font-mono text-sm text-foreground">{host.name}</span>
          <span
            className={
              "rounded-full px-1.5 py-0.5 text-[10px] font-medium " +
              (host.transport === "Tailscale"
                ? "bg-blue-500/10 text-blue-500"
                : "bg-muted text-muted-foreground")
            }
          >
            {t(transportLabelKey(host.transport))}
          </span>
          {host.outdated && (
            <span className="rounded-full bg-amber-500/10 px-1.5 py-0.5 text-[10px] font-medium text-amber-600">
              {t("discover.badge.updateNeeded")}
            </span>
          )}
          {host.majorMismatch && (
            <span className="rounded-full bg-rose-500/10 px-1.5 py-0.5 text-[10px] font-medium text-rose-600">
              {t("discover.badge.incompatible")}
            </span>
          )}
        </div>
        <div className="mt-0.5 font-mono text-[10px] text-muted-foreground">
          {host.address} · v{host.version || "…"}
        </div>
      </div>
    </button>
  );
}
