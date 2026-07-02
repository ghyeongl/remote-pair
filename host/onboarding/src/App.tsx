import { useCallback, useEffect, useMemo, useState } from "react";
import { WizardShell } from "@/components/onboarding/WizardShell";
import { AnimatedStep } from "@/components/onboarding/AnimatedStep";
import { useWizard } from "@/components/onboarding/useWizard";
import { Button } from "@/components/ui/button";
import { StepWelcome } from "@/components/onboarding/host/StepWelcome";
import { StepConsent } from "@/components/onboarding/host/StepConsent";
import {
  StepSinglePerm,
  PERM_ORDER,
  type PermKey,
  type PermState,
  type PermStatus,
} from "@/components/onboarding/host/StepSinglePerm";
import { StepEngine, type EngineKey } from "@/components/onboarding/host/StepEngine";
import {
  StepBroadcast,
  type BroadcastState,
  type IncomingRequest,
} from "@/components/onboarding/host/StepBroadcast";
import { StepDone } from "@/components/onboarding/host/StepDone";
import { useT } from "@/lib/i18n";
import type { PairingStatus } from "@/global";

const CONSENT_ANALYTICS_IDX = 2;
const PERM_START = 3;
const PERM_END = PERM_START + PERM_ORDER.length - 1;
const ENGINE_IDX = PERM_END + 1;
const BROADCAST_IDX = ENGINE_IDX + 1;
const DONE_IDX = BROADCAST_IDX + 1;
const TOTAL = DONE_IDX + 1;

const EMPTY_PERM: PermState = {
  login: "pending",
  ax: "pending",
  sr: "pending",
  fda: "pending",
  sharing: "pending",
};

function deepLinkIndex() {
  const deepLink =
    typeof window !== "undefined"
      ? (window as unknown as { __rp_initialStep?: string }).__rp_initialStep
      : undefined;
  if (deepLink === "permissions") return PERM_START;
  if (deepLink === "engine") return ENGINE_IDX;
  if (deepLink === "connect") return BROADCAST_IDX;
  return 0;
}

function clampStep(n: number) {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(TOTAL - 1, Math.trunc(n)));
}

function firstUnmetPermIndex(state: PermState) {
  const i = PERM_ORDER.findIndex((k) => state[k] !== "granted");
  return i === -1 ? null : PERM_START + i;
}

export default function App() {
  const { t } = useT();
  const requestedDeepLink = deepLinkIndex();
  const w = useWizard(TOTAL, requestedDeepLink);
  const [hydrated, setHydrated] = useState(false);
  const [crashReports, setCrashReports] = useState(true);
  const [analytics, setAnalytics] = useState(false);
  const [consentLoaded, setConsentLoaded] = useState(false);
  const [consentDirty, setConsentDirty] = useState(false);
  const [perm, setPerm] = useState<PermState>(EMPTY_PERM);
  const [engines, setEngines] = useState<Set<EngineKey>>(new Set());
  const [broadcast, setBroadcast] = useState<BroadcastState>("waiting");
  const [request, setRequest] = useState<IncomingRequest | null>(null);
  const [pairingError, setPairingError] = useState("");

  const inPerms = w.index >= PERM_START && w.index <= PERM_END;
  const currentPermKey = inPerms ? PERM_ORDER[w.index - PERM_START] : null;
  const currentPermGranted =
    currentPermKey !== null && perm[currentPermKey] === "granted";

  const nextDisabled =
    (inPerms && !currentPermGranted) ||
    (w.index === ENGINE_IDX && engines.size === 0);

  const statusToPerm = useCallback((granted: boolean, current: PermStatus): PermStatus => {
    if (granted) return "granted";
    return current === "opening" ? "opening" : "pending";
  }, []);

  const probePermissions = useCallback(async () => {
    const s = await window.xpair.getStatus();
    let raw: PermState = {
      login: s.login ? "granted" : "pending",
      ax: s.ax ? "granted" : "pending",
      sr: s.sr ? "granted" : "pending",
      fda: s.fda ? "granted" : "pending",
      sharing: s.sharing ? "granted" : "pending",
    };
    setPerm((cur) => {
      const next: PermState = {
        login: statusToPerm(s.login, cur.login),
        ax: statusToPerm(s.ax, cur.ax),
        sr: statusToPerm(s.sr, cur.sr),
        fda: statusToPerm(s.fda, cur.fda),
        sharing: statusToPerm(s.sharing, cur.sharing),
      };
      raw = next;
      return next;
    });
    return raw;
  }, [statusToPerm]);

  const probeReadyEngines = useCallback(async () => {
    const entries = await Promise.all(
      (["claude", "codex", "opencode"] as EngineKey[]).map(async (engine) => {
        try {
          const s = await window.xpair.engineStatus(engine);
          return [engine, s.installed && s.authed] as const;
        } catch {
          return [engine, false] as const;
        }
      }),
    );
    const ready = new Set(entries.filter(([, ok]) => ok).map(([engine]) => engine));
    setEngines((cur) => {
      const kept = new Set([...cur].filter((engine) => ready.has(engine)));
      if (kept.size > 0) return kept;
      const firstReady = ready.values().next().value as EngineKey | undefined;
      return firstReady ? new Set([firstReady]) : new Set();
    });
    return ready;
  }, []);

  useEffect(() => {
    let active = true;
    void window.xpair
      .getConsent()
      .then((c) => {
        if (!active) return;
        setAnalytics(!!c.telemetry);
        setCrashReports(!!c.crash);
        setConsentLoaded(true);
      })
      .catch(() => {
        /* The WK bridge is injected in-app; local Vite preview can run without it. */
      });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (!consentLoaded || !consentDirty) return;
    try {
      void window.xpair.setConsent({ telemetry: analytics, crash: crashReports });
    } catch {
      /* The WK bridge is injected in-app; local Vite preview can run without it. */
    }
  }, [analytics, crashReports, consentDirty, consentLoaded]);

  useEffect(() => {
    let active = true;
    (async () => {
      let persisted = 0;
      try {
        persisted = clampStep(await window.xpair.getOnboardingStep());
      } catch {
        persisted = 0;
      }

      const requested = requestedDeepLink > 0 ? requestedDeepLink : persisted;
      let target = requested;

      if (requested >= PERM_START) {
        try {
          const freshPerm = await probePermissions();
          const unmetPerm = firstUnmetPermIndex(freshPerm);
          if (unmetPerm !== null) target = unmetPerm;
        } catch {
          target = Math.max(PERM_START, Math.min(requested, PERM_END));
        }
      }

      if (target >= ENGINE_IDX) {
        const readyEngines = await probeReadyEngines();
        if (readyEngines.size === 0) target = ENGINE_IDX;
      }

      if (!active) return;
      if (target !== w.index) {
        w.goTo(target, target < w.index ? "prev" : "next");
      }
      setHydrated(true);
    })();
    return () => {
      active = false;
    };
    // Hydration is intentionally one-shot; later step changes are guarded below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!hydrated) return;
    try {
      void window.xpair.setOnboardingStep(w.index);
    } catch {
      /* Best-effort persistence; the guard still uses live probes when the bridge exists. */
    }
  }, [hydrated, w.index]);

  useEffect(() => {
    if (!hydrated) return;
    let active = true;
    (async () => {
      if (w.index >= PERM_START) {
        try {
          const freshPerm = await probePermissions();
          const unmetPerm = firstUnmetPermIndex(freshPerm);
          if (active && unmetPerm !== null && unmetPerm < w.index) {
            w.goTo(unmetPerm, "prev");
            return;
          }
        } catch {
          if (active && w.index > PERM_START) w.goTo(PERM_START, "prev");
          return;
        }
      }

      if (w.index >= ENGINE_IDX) {
        const readyEngines = await probeReadyEngines();
        if (active && readyEngines.size === 0 && w.index > ENGINE_IDX) {
          w.goTo(ENGINE_IDX, "prev");
        }
      }
    })();
    return () => {
      active = false;
    };
  }, [hydrated, probePermissions, probeReadyEngines, w.goTo, w.index]);

  useEffect(() => {
    if (!hydrated || currentPermKey === null) return;
    let active = true;
    const tick = () => {
      probePermissions().catch(() => {
        if (active) setPerm((cur) => ({ ...cur, [currentPermKey]: "pending" }));
      });
    };
    tick();
    const id = window.setInterval(tick, 1500);
    return () => {
      active = false;
      window.clearInterval(id);
    };
  }, [currentPermKey, hydrated, probePermissions]);

  const openCurrentPerm = useCallback(() => {
    if (!currentPermKey) return;
    setPerm((cur) => ({ ...cur, [currentPermKey]: "opening" }));
    void (async (key: PermKey) => {
      try {
        await window.xpair.requestPermission(key);
        await window.xpair.openPermissionPane(key);
      } catch {
        setPerm((cur) => ({ ...cur, [key]: "pending" }));
      } finally {
        window.setTimeout(() => {
          setPerm((cur) =>
            cur[key] === "opening" ? { ...cur, [key]: "pending" } : cur,
          );
        }, 2000);
      }
    })(currentPermKey);
  }, [currentPermKey]);

  const applyPairingStatus = useCallback((s: PairingStatus) => {
    setPairingError(s.error || "");
    if (s.request) {
      setRequest({
        id: s.request.id,
        name: s.request.name,
        ip: s.request.ip,
        user: s.request.user,
        keyFingerprint: s.request.keyFingerprint,
      });
    } else if (s.phase !== "accepted-pending-proof" && s.phase !== "paired") {
      setRequest(null);
    }

    if (s.phase === "incoming" && s.request) {
      setBroadcast("incoming");
    } else if (s.phase === "accepted-pending-proof") {
      setBroadcast("accepted-pending-proof");
    } else if (s.phase === "paired") {
      setBroadcast("accepted");
    } else if (s.phase === "denied") {
      setBroadcast("denied");
    } else if (s.phase === "waiting" || s.phase === "closed") {
      setBroadcast("waiting");
    }
  }, []);

  const beginBroadcast = useCallback(async () => {
    try {
      const s = await window.xpair.beginPairing();
      applyPairingStatus(s);
    } catch (error) {
      setPairingError(error instanceof Error ? error.message : String(error));
      setBroadcast("waiting");
    }
  }, [applyPairingStatus]);

  useEffect(() => {
    if (!hydrated || w.index !== BROADCAST_IDX) return;
    let active = true;
    void beginBroadcast();
    const id = window.setInterval(() => {
      window.xpair
        .pairingStatus()
        .then((s) => {
          if (active) applyPairingStatus(s);
        })
        .catch((error) => {
          if (active) setPairingError(error instanceof Error ? error.message : String(error));
        });
    }, 1000);
    return () => {
      active = false;
      window.clearInterval(id);
      void window.xpair.endPairing();
    };
  }, [applyPairingStatus, beginBroadcast, hydrated, w.index]);

  const footerSlot = useMemo(() => {
    if (w.isLast) {
      return (
        <Button size="sm" onClick={() => window.xpair.complete()}>
          {t("shell.openXpair")}
        </Button>
      );
    }
    if (w.index === BROADCAST_IDX && broadcast === "incoming") {
      return (
        <>
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              window.xpair
                .denyPairing()
                .then(applyPairingStatus)
                .catch((error) => setPairingError(error instanceof Error ? error.message : String(error)));
            }}
          >
            {t("bc.deny")}
          </Button>
          <Button
            size="sm"
            disabled={!request}
            onClick={() => {
              if (!request) return;
              window.xpair
                .acceptPairing({ id: request.id, keyFingerprint: request.keyFingerprint })
                .then(applyPairingStatus)
                .catch((error) => setPairingError(error instanceof Error ? error.message : String(error)));
            }}
          >
            {t("bc.accept")}
          </Button>
        </>
      );
    }
    return null;
  }, [applyPairingStatus, broadcast, request, t, w.index, w.isLast]);

  return (
    <WizardShell
      title="XpairHost"
      step={w.index}
      totalSteps={w.totalSteps}
      onPrev={w.prev}
      onNext={
        w.isLast
          ? undefined
          : w.index === BROADCAST_IDX && broadcast !== "accepted"
            ? undefined
            : w.next
      }
      nextDisabled={nextDisabled}
      nextLabel={
        w.index === 0
          ? t("shell.beginSetup")
          : w.index === BROADCAST_IDX && broadcast === "accepted"
            ? t("shell.continue")
            : t("shell.next")
      }
      footerSlot={footerSlot}
      centerSlot={null}
    >
      <AnimatedStep stepKey={w.index} direction={w.direction}>
        {w.index === 0 && <StepWelcome />}
        {w.index === 1 && (
          <StepConsent
            kind="crash"
            value={crashReports}
            onChange={(v) => {
              setConsentDirty(true);
              setCrashReports(v);
            }}
          />
        )}
        {w.index === CONSENT_ANALYTICS_IDX && (
          <StepConsent
            kind="analytics"
            value={analytics}
            onChange={(v) => {
              setConsentDirty(true);
              setAnalytics(v);
            }}
          />
        )}
        {inPerms && currentPermKey && (
          <StepSinglePerm
            permKey={currentPermKey}
            status={perm[currentPermKey]}
            onOpen={openCurrentPerm}
          />
        )}
        {w.index === ENGINE_IDX && (
          <StepEngine selected={engines} setSelected={setEngines} />
        )}
        {w.index === BROADCAST_IDX && (
          <StepBroadcast
            state={broadcast}
            setState={setBroadcast}
            request={request}
            setRequest={setRequest}
            error={pairingError}
            onBroadcastAgain={beginBroadcast}
          />
        )}
        {w.index === DONE_IDX && <StepDone />}
      </AnimatedStep>
    </WizardShell>
  );
}
