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
  transport: "LAN" | "Tailscale";
  version: string;
  hostKeyFP?: string;
  serviceInstanceID?: string;
  hostNonce?: string;
  pairPort?: number;
  outdated?: boolean;
  majorMismatch?: boolean;
};

type BridgePeer = Awaited<ReturnType<typeof window.remotepair.discover>>["peers"][number];

type Props = {
  selected: DiscoveredHost | null;
  setSelected: (h: DiscoveredHost | null) => void;
};

function peerToHost(peer: BridgePeer): DiscoveredHost {
  const pairingAddress = peer.pairingAddress ?? peer.addrs[0] ?? peer.name;
  const sshTarget =
    peer.target ?? (peer.hostUser ? `${peer.hostUser}@${pairingAddress}` : pairingAddress);
  return {
    id: peer.fp ?? sshTarget ?? peer.name,
    name: peer.name,
    address: pairingAddress,
    pairingAddress,
    sshTarget,
    hostUser: peer.hostUser,
    transport: peer.source === "tailscale" ? "Tailscale" : "LAN",
    version: "",
    hostKeyFP: peer.fp || undefined,
    serviceInstanceID: peer.serviceInstanceID,
    hostNonce: peer.hostNonce,
    pairPort: peer.pairPort,
  };
}

function deriveHostFlags(r: Awaited<ReturnType<typeof window.remotepair.hostAppStatus>>) {
  const majorMismatch =
    !!r.installed && !r.compatible && r.incompatibleKind === "major_mismatch";
  const outdated =
    !majorMismatch && !!r.installed && !r.compatible && r.incompatibleKind === "below_floor";
  return { majorMismatch, outdated };
}

export function StepDiscover({ selected, setSelected }: Props) {
  const { t } = useT();
  const [scanning, setScanning] = useState(true);
  const [hosts, setHosts] = useState<DiscoveredHost[]>([]);
  const [selectingId, setSelectingId] = useState<string | null>(null);
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
        const byId = new Map<string, DiscoveredHost>();
        for (const peer of res.peers || []) {
          // A peer is selectable if it can pair right now (live pairing window: serviceInstanceID +
          // hostNonce + pairPort) OR it is an installed XpairHost that only needs the Update flow.
          // Selecting a host runs hostAppStatus(), which is the ONLY place below_floor is detected and
          // routed to StepUpdate — so dropping non-broadcasting XpairHosts (round-10's `if (!canPair)`)
          // hid below-floor hosts and dead-ended the upgrade in an empty Discover screen. A below-floor /
          // not-broadcasting XpairHost carries a host-key fp (Bonjour TXT fp= or tailnet pairing metadata,
          // both emitted only by an XpairHost) and a non-"setup" status ("connect" = advertises the Xpair
          // role, "reconnect" = ssh host with the app confirmed present); a plain reachable Mac is
          // fp=null + status "setup" — nothing to pair or update, so drop it. A kept non-broadcasting host
          // routes to Update (below-floor) or WaitPerm's actionable "not broadcasting — open Connect on the
          // host, then rescan" message, never a silent dead-end.
          const canPair = !!(peer.serviceInstanceID && peer.hostNonce && peer.pairPort);
          const isXpairHost = !!peer.fp || peer.status !== "setup";
          if (!canPair && !isXpairHost) continue;
          const host = peerToHost(peer);
          byId.set(host.id, host);
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

  const chooseHost = async (host: DiscoveredHost) => {
    setSelectingId(host.id);
    try {
      const status = await window.remotepair.hostAppStatus(host.sshTarget ?? host.address);
      const flags = deriveHostFlags(status);
      setSelected({
        ...host,
        version: status.version || host.version,
        outdated: flags.outdated,
        majorMismatch: flags.majorMismatch,
      });
    } catch {
      setSelected(null);
    } finally {
      setSelectingId(null);
    }
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

        {hosts.map((h) => {
          const host = selected?.id === h.id ? { ...h, ...selected } : h;
          return (
            <HostRow
              key={h.id}
              host={host}
              selected={selected?.id === h.id}
              selecting={selectingId === h.id}
              onSelect={() => void chooseHost(h)}
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
  selecting,
  onSelect,
}: {
  host: DiscoveredHost;
  selected: boolean;
  selecting: boolean;
  onSelect: () => void;
}) {
  const { t } = useT();
  return (
    <button
      type="button"
      onClick={onSelect}
      disabled={selecting}
      className={
        "flex w-full items-center gap-3 rounded-xl border px-4 py-3 text-left transition-colors disabled:opacity-70 " +
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
        {selecting ? (
          <Loader2 className="h-3 w-3 animate-spin" />
        ) : (
          selected && <Check className="h-3 w-3" />
        )}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate font-mono text-sm text-foreground">{host.name}</span>
          <span
            className={
              "rounded-full px-1.5 py-0.5 text-[10px] font-medium " +
              (host.transport === "LAN"
                ? "bg-muted text-muted-foreground"
                : "bg-blue-500/10 text-blue-500")
            }
          >
            {host.transport}
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
