import { useCallback, useEffect, useRef, useState } from "react";
import { WizardShell } from "@/components/onboarding/WizardShell";
import { AnimatedStep } from "@/components/onboarding/AnimatedStep";
import { useWizard } from "@/components/onboarding/useWizard";
import { Button } from "@/components/ui/button";
import { StepWelcome } from "@/components/onboarding/client/StepWelcome";
import { StepConsent } from "@/components/onboarding/client/StepConsent";
import {
  StepDiscover,
  peerToHost,
  type DiscoveredHost,
} from "@/components/onboarding/client/StepDiscover";
import {
  StepUpdate,
  type UpdateState,
} from "@/components/onboarding/client/StepUpdate";
import { StepWaitPerm } from "@/components/onboarding/client/StepWaitPerm";
import {
  parseFolderMaps,
  isPersistedRealMapping,
  StepMappings,
  type Mapping,
} from "@/components/onboarding/client/StepMappings";
import { StepDone } from "@/components/onboarding/client/StepDone";
import { useT } from "@/lib/i18n";
import { capture, EVENTS } from "@/lib/telemetry";

// 0 Welcome, 1 Consent(crash), 2 Consent(analytics),
// 3 Discover, 4 Update, 5 WaitPerm, 6 Mappings, 7 Done
const TOTAL = 8;

const S = {
  WELCOME: 0,
  CONSENT_CRASH: 1,
  CONSENT_ANALYTICS: 2,
  DISCOVER: 3,
  UPDATE: 4,
  WAIT_PERM: 5,
  MAPPINGS: 6,
  DONE: 7,
} as const;

const START_STEPS: Record<string, number> = {
  welcome: S.WELCOME,
  connect: S.DISCOVER,
  // Client cannot repair host AX/SR; re-discovery surfaces fresh pairing metadata plus the host-onboarding recovery CTA.
  grant: S.DISCOVER,
  engine: S.DISCOVER,
};

function initialStepFromLocation() {
  if (typeof window === "undefined") return S.WELCOME;
  const raw = new URLSearchParams(window.location.search).get("startStep") || "";
  if (Object.prototype.hasOwnProperty.call(START_STEPS, raw)) return START_STEPS[raw];
  return S.WELCOME;
}

// The native launch guard opens onboarding with `?startStep=engine` when the HOST's agent engine is
// missing/unauthenticated. initialStepFromLocation() collapses that to S.DISCOVER (the client has no
// engine step — engine setup lives in the host app), which would lose WHY we landed here. Read the raw
// reason so Discover can surface the host-engine-repair CTA instead of behaving like a normal scan.
function initialStartReason(): string {
  if (typeof window === "undefined") return "";
  return new URLSearchParams(window.location.search).get("startStep") || "";
}

export function deriveHostFlags(r: Awaited<ReturnType<typeof window.remotepair.hostAppStatus>>) {
  const majorMismatch =
    !!r.installed && !r.compatible && r.incompatibleKind === "major_mismatch";
  const outdated =
    !majorMismatch && !!r.installed && !r.compatible && r.incompatibleKind === "below_floor";
  return { majorMismatch, outdated };
}

export default function App() {
  const { t } = useT();
  const [initialStep] = useState(() => initialStepFromLocation());
  // Sticky for the window's lifetime: if the engine is fixed on the host, the next launch's native guard
  // won't return `engine`, so the window simply won't reopen in this mode.
  const [engineRecovery] = useState(() => initialStartReason() === "engine");
  const w = useWizard(TOTAL, initialStep);

  useEffect(() => {
    capture(EVENTS.ONBOARDING_STARTED);
  }, []);

  const [crashReports, setCrashReports] = useState(true);
  const [analytics, setAnalytics] = useState(false);
  const [consentLoaded, setConsentLoaded] = useState(false);

  useEffect(() => {
    let alive = true;
    void window.remotepair
      .tGetConsent()
      .then((r) => {
        if (!alive) return;
        setAnalytics(!!r.telemetry);
        setCrashReports(!!r.crashReport);
      })
      .catch(() => {})
      .finally(() => {
        if (alive) setConsentLoaded(true);
      });
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    if (!consentLoaded) return;
    void window.remotepair.tSetConsent(analytics, crashReports).catch(() => {});
  }, [analytics, crashReports, consentLoaded]);

  const [selectedHost, setSelectedHost] = useState<DiscoveredHost | null>(null);
  const [updateState, setUpdateState] = useState<UpdateState>("idle");
  const [updatePct, setUpdatePct] = useState(0);
  const [permAccepted, setPermAccepted] = useState(false);
  const [permDenied, setPermDenied] = useState(false);
  const [mappings, setMappings] = useState<Mapping[]>([]);
  // True while the post-pairing hostAppStatus re-probe is in flight. On the first-pair path the host
  // could not be SSH-probed before pairing, so this is the ONLY chance to learn it is below the
  // compatibility floor / a major mismatch — block progression past WaitPerm until it resolves, or a
  // user (esp. one with preloaded mappings) could click through to Done against an incompatible host.
  const [postPairProbePending, setPostPairProbePending] = useState(false);

  const selectedRef = useRef<DiscoveredHost | null>(null);
  selectedRef.current = selectedHost;

  // The ssh target the CURRENT mappings belong to. Compared by target (not host id) because a discovered
  // host's id is its key fingerprint while a config-restored host's id is REMOTE_HOST — the target is the
  // stable identity across both. null until we know which host the mappings are for.
  const mappingsHostRef = useRef<string | null>(null);
  const hostTarget = (h: DiscoveredHost | null) => h?.sshTarget ?? h?.address ?? null;

  const setSelected = useCallback((host: DiscoveredHost | null) => {
    // Mappings belong to exactly one host (client↔host FOLDER_MAPS paths). Keep them when the user
    // (re-)selects the SAME host — e.g. a returning user whose saved mappings were preloaded — but clear
    // them when switching to a DIFFERENT host, so its Mappings/Done gates never pass against another
    // host's paths (which don't exist on it). Clear ONLY when the new target is NON-NULL and differs:
    // deselecting (setSelected(null) from Discover's Rescan / going back) must NOT drop mappings the user
    // still owns, or reselecting the same host would trap them at the empty Mappings gate.
    const target = hostTarget(host);
    if (target !== null && target !== mappingsHostRef.current) {
      setMappings([]);
      mappingsHostRef.current = target;
    }
    setSelectedHost(host);
    setUpdateState("idle");
    setUpdatePct(0);
    setPermAccepted(false);
    setPermDenied(false);
  }, []);

  useEffect(() => {
    let alive = true;
    void window.remotepair
      .getConfig()
      .then((cfg) => {
        if (!alive) return;
        const remoteHost = cfg.remoteHost.trim();
        // Preload saved FOLDER_MAPS on EVERY entry path (not just resume): a returning user re-running
        // setup from Welcome must see their existing mappings, or the Mappings step (which hard-blocks
        // Next until hasRealMapping) traps them with an empty list they'd have to recreate.
        const parsedMappings = parseFolderMaps(cfg.folderMaps, cfg.folderMapModes);
        if (parsedMappings.length) {
          setMappings((current) => (current.length ? current : parsedMappings));
          if (!mappingsHostRef.current) mappingsHostRef.current = remoteHost || null;
        }
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  const hostProbeId = useRef(0);
  const probeSelectedHost = useCallback(async () => {
    const host = selectedRef.current;
    if (!host) return null;
    const probeId = ++hostProbeId.current;
    try {
      const r = await window.remotepair.hostAppStatus(host.sshTarget ?? host.address);
      const flags = deriveHostFlags(r);
      if (hostProbeId.current === probeId) {
        setSelectedHost((current) => {
          if (!current || current.id !== host.id) return current;
          const next = {
            ...current,
            version: r.version || current.version,
            outdated: flags.outdated,
            majorMismatch: flags.majorMismatch,
            probed: true,
          };
          if (
            current.version === next.version &&
            current.outdated === next.outdated &&
            current.majorMismatch === next.majorMismatch &&
            current.probed === next.probed
          ) {
            return current;
          }
          return next;
        });
      }
      return r;
    } catch {
      // Probe failed: we could not determine status, but mark it settled so the wizard is not
      // stuck on Update forever — outdated/majorMismatch stay false, so progression resumes.
      if (hostProbeId.current === probeId) {
        setSelectedHost((current) =>
          current && current.id === host.id && !current.probed
            ? { ...current, probed: true }
            : current,
        );
      }
      return null;
    }
  }, []);

  useEffect(() => {
    if (selectedHost) void probeSelectedHost();
  }, [selectedHost?.id, probeSelectedHost]);

  const mergePairingMeta = useCallback(
    (
      selectedId: string,
      meta: Awaited<ReturnType<typeof window.remotepair.fetchPairingMeta>>,
      mappedHost?: DiscoveredHost | null,
    ) => {
      setSelectedHost((h) => {
        if (!h || h.id !== selectedId) return h;
        const base = mappedHost
          ? {
              ...h,
              ...mappedHost,
              version: h.version,
              outdated: h.outdated,
              majorMismatch: h.majorMismatch,
            }
          : h;
        if (!meta.ok) {
          return {
            ...base,
            hostKeyFP: base.hostKeyFP || h.hostKeyFP,
            // A failed pull INVALIDATES any earlier pairing-window transcript: the window may
            // have been denied/expired/closed, and stale sid/nonce/port would let WaitPerm
            // poll a dead window instead of surfacing the real state.
            serviceInstanceID: undefined,
            hostNonce: undefined,
            pairPort: undefined,
            pairingMetaStatus: "error",
            pairingMetaError: meta.err || t("wait.discoveryMissing"),
          };
        }
        return {
          ...base,
          hostKeyFP: meta.fp || base.hostKeyFP || h.hostKeyFP,
          serviceInstanceID: meta.serviceInstanceID || undefined,
          hostNonce: meta.hostNonce || undefined,
          pairPort: meta.pairPort || undefined,
          hostUser: meta.hostUser || base.hostUser,
          pairingMetaStatus: "ok",
          pairingMetaError: "",
        };
      });
    },
    [],
  );

  const fetchAndMergePairingMeta = useCallback(
    async (host: DiscoveredHost, mappedHost?: DiscoveredHost | null) => {
      const selectedId = host.id;
      const target =
        mappedHost?.pairingAddress ?? mappedHost?.address ?? host.pairingAddress ?? host.address;
      setSelectedHost((h) =>
        h && h.id === selectedId
          ? {
              ...h,
              ...(mappedHost
                ? {
                    ...mappedHost,
                    id: h.id,
                    version: h.version,
                    outdated: h.outdated,
                    majorMismatch: h.majorMismatch,
                  }
                : {}),
              pairingMetaStatus: "loading",
              pairingMetaError: "",
            }
          : h,
      );
      try {
        const meta = await window.remotepair.fetchPairingMeta(target);
        mergePairingMeta(selectedId, meta, mappedHost);
        return meta;
      } catch (error) {
        const meta = {
          ok: false,
          fp: "",
          serviceInstanceID: "",
          hostNonce: "",
          pairPort: 0,
          hostUser: "",
          err: error instanceof Error ? error.message : String(error),
        };
        mergePairingMeta(selectedId, meta, mappedHost);
        return meta;
      }
    },
    [mergePairingMeta],
  );

  useEffect(() => {
    if (selectedHost) void fetchAndMergePairingMeta(selectedHost);
  }, [selectedHost?.id, fetchAndMergePairingMeta]);

  const needsUpdate = !!selectedHost?.outdated;
  const majorMismatch = !!selectedHost?.majorMismatch;
  const blockedOnUpdate = w.index === 4 && majorMismatch;
  const blockedOnDeny = w.index === 5 && permDenied;
  const hasRealMapping = mappings.some(isPersistedRealMapping);

  const goBackToDiscover = () => {
    setSelected(null);
    setUpdateState("idle");
    setUpdatePct(0);
    setPermAccepted(false);
    setPermDenied(false);
    w.goTo(3, "prev");
  };

  const goToPairing = () => {
    setPermAccepted(false);
    setPermDenied(false);
    w.goTo(S.WAIT_PERM, "next");
  };

  const retryHostPrompt = async () => {
    const cur = selectedRef.current;
    setPermDenied(false);
    setPermAccepted(false);
    if (!cur) return;
    const selectedId = cur.id;
    let mapped: DiscoveredHost | null = null;
    try {
      const res = await window.remotepair.discover();
      const match = (res.peers || []).find((p) => {
        const m = peerToHost(p);
        const currentTarget = cur.sshTarget ?? cur.address;
        const currentAddress = cur.pairingAddress ?? cur.address;
        return (
          (cur.hostKeyFP && p.fp === cur.hostKeyFP) ||
          m.sshTarget === currentTarget ||
          m.address === currentAddress ||
          m.pairingAddress === currentAddress
        );
      });
      mapped = match ? peerToHost(match) : null;
    } catch {
      mapped = null;
    }
    const latest = selectedRef.current;
    if (!latest || latest.id !== selectedId) return;
    void fetchAndMergePairingMeta(latest, mapped);
  };

  useEffect(() => {
    if (w.index !== S.UPDATE) return;
    if (!selectedHost) {
      w.goTo(S.DISCOVER, "prev");
      return;
    }
    void probeSelectedHost();
  }, [w.index, selectedHost?.id, probeSelectedHost, w.goTo]);

  // Re-probe once pairing is accepted. Before pairing the dedicated key is not yet authorized, so the
  // Discover/Update hostAppStatus probes cannot SSH-authenticate and report not-installed → the Update
  // gate auto-skips. Now that the key is authorized the probe returns the real version; the DONE-effect
  // above then bounces a below-floor / major-mismatch host back to Update instead of reaching Done.
  useEffect(() => {
    if (w.index === S.WAIT_PERM && permAccepted) {
      setPostPairProbePending(true);
      void probeSelectedHost().finally(() => setPostPairProbePending(false));
    }
  }, [w.index, permAccepted, probeSelectedHost]);

  useEffect(() => {
    if (w.index !== S.DONE) return;
    if (!selectedHost) {
      w.goTo(S.DISCOVER, "prev");
      return;
    }
    if (majorMismatch || (needsUpdate && updateState !== "done")) {
      forcedUpdateLanding.current = true; // guard redirect, not a user Back — see the S.UPDATE effect
      w.goTo(S.UPDATE, "prev");
      return;
    }
    if (!permAccepted || permDenied) {
      w.goTo(S.WAIT_PERM, "prev");
      return;
    }
    if (!hasRealMapping) {
      w.goTo(S.MAPPINGS, "prev");
    }
  }, [
    w.index,
    selectedHost,
    majorMismatch,
    needsUpdate,
    updateState,
    permAccepted,
    permDenied,
    hasRealMapping,
    w.goTo,
  ]);

  const forcedUpdateLanding = useRef(false);
  useEffect(() => {
    if (w.index !== S.UPDATE) return;
    if (w.direction === "prev") {
      if (forcedUpdateLanding.current) {
        // The Done guard forced this landing (below-floor/major-mismatch host) — stay on
        // Update; only a USER Back should pass through to Discover.
        forcedUpdateLanding.current = false;
      } else {
        w.goTo(S.DISCOVER, "prev");
        return;
      }
    }
    // Gate on probed: never skip Update until the host status probe has resolved, or a slow
    // SSH probe lets the timer skip an outdated host on the pre-probe default (both flags false).
    if (selectedHost?.probed && !needsUpdate && !majorMismatch && updateState !== "done") {
      const tm = setTimeout(() => w.next(), 650);
      return () => clearTimeout(tm);
    }
  }, [w.index, w.direction, selectedHost?.probed, needsUpdate, majorMismatch, updateState, w]);

  const nextDisabled =
    (w.index === 3 && !selectedHost) ||
    blockedOnUpdate ||
    (w.index === 4 && needsUpdate && updateState !== "done") ||
    blockedOnDeny ||
    (w.index === 5 && !permAccepted) ||
    // Hold at WaitPerm until the post-pairing compatibility re-probe resolves, so an incompatible host
    // routes back to Update instead of letting the user click through to Done.
    (w.index === 5 && postPairProbePending) ||
    (w.index === 6 && !hasRealMapping);

  const showNext = !w.isLast && !blockedOnUpdate && !blockedOnDeny;

  return (
    <>
      <WizardShell
        title="Xpair"
        step={w.index}
        totalSteps={w.totalSteps}
        onPrev={w.prev}
        onNext={showNext ? w.next : undefined}
        nextDisabled={nextDisabled}
        nextLabel={
          w.index === 0
            ? t("shell.getStarted")
            : w.index === 6
            ? t("shell.finish")
            : t("shell.next")
        }
        footerSlot={
          w.isLast ? (
            <Button size="sm" onClick={() => window.remotepair.complete()}>
              {t("shell.openXpair")}
            </Button>
          ) : null
        }
      >
        <AnimatedStep stepKey={w.index} direction={w.direction}>
          {w.index === 0 && <StepWelcome />}
          {w.index === 1 && (
            <StepConsent kind="crash" value={crashReports} onChange={setCrashReports} />
          )}
          {w.index === 2 && (
            <StepConsent kind="analytics" value={analytics} onChange={setAnalytics} />
          )}
          {w.index === 3 && (
            <StepDiscover
              selected={selectedHost}
              setSelected={setSelected}
              engineRecovery={engineRecovery}
            />
          )}
          {w.index === 4 && (
            <StepUpdate
              host={selectedHost}
              state={updateState}
              setState={setUpdateState}
              pct={updatePct}
              setPct={setUpdatePct}
              onBackToDiscover={goBackToDiscover}
              onRepairPairing={goToPairing}
            />
          )}
          {w.index === 5 && (
            <StepWaitPerm
              host={selectedHost}
              accepted={permAccepted}
              setAccepted={setPermAccepted}
              denied={permDenied}
              onDeny={() => setPermDenied(true)}
              onRetry={retryHostPrompt}
              onPickAnother={goBackToDiscover}
            />
          )}
          {w.index === 6 && (
            <StepMappings
              mappings={mappings}
              setMappings={setMappings}
              hostTarget={selectedHost?.sshTarget ?? selectedHost?.address}
            />
          )}
          {w.index === 7 && <StepDone host={selectedHost} mappings={mappings} />}
        </AnimatedStep>
      </WizardShell>
      {/* Build stamp — confirms a launched window is the latest build. */}
      <div className="pointer-events-none fixed bottom-1 left-2 z-50 select-none font-mono text-[10px] text-muted-foreground/40">
        build {__BUILD_ID__}
      </div>
    </>
  );
}
