import { useCallback, useEffect, useRef, useState } from "react";
import { WizardShell } from "@/components/onboarding/WizardShell";
import { AnimatedStep } from "@/components/onboarding/AnimatedStep";
import { useWizard } from "@/components/onboarding/useWizard";
import { Button } from "@/components/ui/button";
import { StepWelcome } from "@/components/onboarding/client/StepWelcome";
import { StepConsent } from "@/components/onboarding/client/StepConsent";
import {
  StepDiscover,
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
  const numeric = Number(raw);
  if (Number.isInteger(numeric)) {
    return Math.max(S.WELCOME, Math.min(S.DONE, numeric));
  }
  return S.WELCOME;
}

function deriveHostFlags(r: Awaited<ReturnType<typeof window.remotepair.hostAppStatus>>) {
  const majorMismatch =
    !!r.installed && !r.compatible && r.incompatibleKind === "major_mismatch";
  const outdated =
    !majorMismatch && !!r.installed && !r.compatible && r.incompatibleKind === "below_floor";
  return { majorMismatch, outdated };
}

export default function App() {
  const { t } = useT();
  const [initialStep] = useState(() => initialStepFromLocation());
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

  const selectedRef = useRef<DiscoveredHost | null>(null);
  selectedRef.current = selectedHost;

  const setSelected = useCallback((host: DiscoveredHost | null) => {
    setSelectedHost(host);
    setUpdateState("idle");
    setUpdatePct(0);
    setPermAccepted(false);
    setPermDenied(false);
  }, []);

  useEffect(() => {
    if (initialStep < S.UPDATE) return;
    let alive = true;
    void window.remotepair
      .getConfig()
      .then((cfg) => {
        if (!alive) return;
        const parsedMappings = parseFolderMaps(cfg.folderMaps, cfg.folderMapModes);
        if (parsedMappings.length) {
          setMappings((current) => (current.length ? current : parsedMappings));
        }
        const remoteHost = cfg.remoteHost.trim();
        if (!remoteHost) return;
        setSelectedHost((current) =>
          current ?? {
            id: remoteHost,
            name: remoteHost,
            address: remoteHost,
            pairingAddress: remoteHost,
            sshTarget: remoteHost,
            transport: "LAN",
            version: "",
          },
        );
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [initialStep]);

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
          };
          if (
            current.version === next.version &&
            current.outdated === next.outdated &&
            current.majorMismatch === next.majorMismatch
          ) {
            return current;
          }
          return next;
        });
      }
      return r;
    } catch {
      return null;
    }
  }, []);

  useEffect(() => {
    if (selectedHost) void probeSelectedHost();
  }, [selectedHost?.id, probeSelectedHost]);

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

  const retryHostPrompt = () => {
    setPermDenied(false);
    setPermAccepted(false);
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
    if (w.index === S.WAIT_PERM && permAccepted) void probeSelectedHost();
  }, [w.index, permAccepted, probeSelectedHost]);

  useEffect(() => {
    if (w.index !== S.DONE) return;
    if (!selectedHost) {
      w.goTo(S.DISCOVER, "prev");
      return;
    }
    if (majorMismatch || (needsUpdate && updateState !== "done")) {
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

  useEffect(() => {
    if (w.index === 4 && !needsUpdate && !majorMismatch && updateState !== "done") {
      const tm = setTimeout(() => w.next(), 650);
      return () => clearTimeout(tm);
    }
  }, [w.index, needsUpdate, majorMismatch, updateState, w]);

  const nextDisabled =
    (w.index === 3 && !selectedHost) ||
    blockedOnUpdate ||
    (w.index === 4 && needsUpdate && updateState !== "done") ||
    blockedOnDeny ||
    (w.index === 5 && !permAccepted) ||
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
            <StepDiscover selected={selectedHost} setSelected={setSelected} />
          )}
          {w.index === 4 && (
            <StepUpdate
              host={selectedHost}
              state={updateState}
              setState={setUpdateState}
              pct={updatePct}
              setPct={setUpdatePct}
              onBackToDiscover={goBackToDiscover}
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
