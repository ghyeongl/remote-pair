import type { ComponentType } from "react";
import { useCallback, useEffect, useState } from "react";
import {
  AlertCircle,
  Bot,
  Check,
  Download,
  KeyRound,
  Loader2,
  RotateCw,
  Sparkles,
  SquareTerminal,
  Terminal,
} from "lucide-react";
import { Button } from "@shared/components/ui/button";
import { Input } from "@shared/components/ui/input";
import type { EngineId } from "@/global";
import { useT } from "@/lib/i18n";

export type EngineKey = EngineId;

type Props = {
  selected: Set<EngineKey>;
  setSelected: (s: Set<EngineKey>) => void;
};

type EngineStatus = {
  installed: boolean;
  authed: boolean;
  version: string;
  err: string;
};

type EngineStatuses = Record<EngineKey, EngineStatus>;

const ORDER: EngineKey[] = ["claude", "codex", "opencode", "shell"];
const ICONS: Record<EngineKey, ComponentType<{ className?: string }>> = {
  claude: Sparkles,
  codex: Bot,
  opencode: Terminal,
  shell: SquareTerminal,
};
const BADGE: Partial<Record<EngineKey, "recommended">> = { claude: "recommended" };

const isReady = (s: EngineStatus | null | undefined) => !!s && s.installed && s.authed;
const primaryEngine = (selected: Set<EngineKey>, preferred?: EngineKey | null) => {
  if (preferred && selected.has(preferred)) return preferred;
  return ORDER.find((id) => selected.has(id)) ?? null;
};

const missingText = (s: EngineStatus | null | undefined) => {
  if (!s) return "Not checked";
  if (!s.installed) return "Not installed";
  if (!s.authed) return "Installed, sign-in needed";
  return s.version ? `Ready (${s.version})` : "Ready";
};

export function StepEngine({ selected, setSelected }: Props) {
  const { t } = useT();
  const [engine, setEngine] = useState<EngineKey>("claude");
  const [statuses, setStatuses] = useState<EngineStatuses | null>(null);
  const [probing, setProbing] = useState(false);
  const [installing, setInstalling] = useState<EngineKey | null>(null);
  const [authing, setAuthing] = useState(false);
  const [apiKey, setApiKey] = useState("");
  const [actionErr, setActionErr] = useState("");

  const probeOne = useCallback(async (e: EngineKey): Promise<EngineStatus> => {
    // The shell engine (login shell) is always available — no install/auth, and no backend probe
    // (engineStatus has no shell branch). Report it ready so a shell-only host can still advance.
    if (e === "shell") return { installed: true, authed: true, version: "shell", err: "" };
    try {
      return await window.xpair.engineStatus(e);
    } catch (err) {
      return { installed: false, authed: false, version: "", err: String(err) };
    }
  }, []);

  const persistEngine = useCallback(async (e: EngineKey) => {
    try {
      // xpair-launch reads this host.env ENGINE over SSH; host onboarding is the write site.
      await window.xpair.setEngine(e);
    } catch {
      /* Persist failure should not make a ready local engine look unready. */
    }
  }, []);

  const probe = useCallback(
    async (preferred: EngineKey = engine) => {
      setProbing(true);
      setActionErr("");
      try {
        const entries = await Promise.all(
          ORDER.map(async (id) => [id, await probeOne(id)] as const),
        );
        const nextStatuses = Object.fromEntries(entries) as EngineStatuses;
        setStatuses(nextStatuses);

        const ready = new Set(ORDER.filter((id) => isReady(nextStatuses[id])));
        const nextSelected = new Set([...selected].filter((id) => ready.has(id)));
        if (ready.has(preferred)) nextSelected.add(preferred);
        if (nextSelected.size === 0) {
          const firstReady = ready.values().next().value as EngineKey | undefined;
          if (firstReady) nextSelected.add(firstReady);
        }

        setSelected(nextSelected);
        const focused = primaryEngine(nextSelected, preferred) ?? preferred;
        setEngine(focused);
        setApiKey("");

        const primary = primaryEngine(nextSelected, focused);
        if (primary) await persistEngine(primary);
      } finally {
        setProbing(false);
      }
    },
    [engine, persistEngine, probeOne, selected, setSelected],
  );

  useEffect(() => {
    void probe(engine);
    // Probe once on entry; explicit re-checks and install/auth actions call probe again.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const toggle = useCallback(
    async (id: EngineKey) => {
      setApiKey("");
      setActionErr("");
      const status = statuses?.[id];
      if (!isReady(status)) {
        setEngine(id);
        return;
      }

      const next = new Set(selected);
      if (next.has(id)) {
        next.delete(id);
        const primary = primaryEngine(next, engine === id ? null : engine);
        setSelected(next);
        setEngine(primary ?? id);
        if (primary) await persistEngine(primary);
      } else {
        next.add(id);
        setSelected(next);
        setEngine(id);
        await persistEngine(id);
      }
    },
    [engine, persistEngine, selected, setSelected, statuses],
  );

  const onInstall = useCallback(async () => {
    setInstalling(engine);
    setActionErr("");
    try {
      const r = await window.xpair.installEngine(engine);
      if (!r.ok) {
        setActionErr(r.err || "install failed");
        return;
      }
      await probe(engine);
    } catch (err) {
      setActionErr(String(err));
    } finally {
      setInstalling(null);
    }
  }, [engine, probe]);

  const onSetAuth = useCallback(async () => {
    if (!apiKey.trim()) return;
    setAuthing(true);
    setActionErr("");
    try {
      const r = await window.xpair.setEngineAuth(engine, apiKey.trim());
      setApiKey("");
      if (!r.ok) {
        setActionErr(r.err || "could not set API key");
        return;
      }
      await probe(engine);
    } catch (err) {
      setActionErr(String(err));
    } finally {
      setAuthing(false);
    }
  }, [engine, apiKey, probe]);

  const status = statuses?.[engine] || null;
  const ready = isReady(status);
  const busy = probing || !!installing || authing;
  const catalogReady = statuses !== null;

  return (
    <div>
      <h2 className="text-xl font-semibold tracking-tight text-foreground">
        {t("engine.title")}
      </h2>
      <p className="mt-1.5 text-sm text-muted-foreground">{t("engine.desc")}</p>

      {!catalogReady ? (
        <div className="mt-5 flex items-center gap-2 rounded-lg border border-border bg-muted/30 px-3 py-2.5 text-sm text-muted-foreground">
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          Checking this Mac for supported engines...
        </div>
      ) : (
        <div className="mt-6 space-y-2">
          {ORDER.map((id) => (
            <EngineRow
              key={id}
              k={id}
              active={selected.has(id)}
              focused={engine === id}
              status={statuses[id]}
              onToggle={() => void toggle(id)}
            />
          ))}
        </div>
      )}

      <div className="mt-5 min-h-6 text-xs">
        {probing && catalogReady && (
          <span className="flex items-center gap-2 text-muted-foreground">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            Checking this Mac for supported engines...
          </span>
        )}

        {!probing && status && ready && (
          <span className="flex items-center gap-2 text-primary">
            <Check className="h-3.5 w-3.5" />
            {engine} is installed{status.version ? ` (${status.version})` : ""} and signed in.
          </span>
        )}

        {!probing && status && !status.installed && (
          <div className="flex flex-col gap-2">
            <span className="flex items-center gap-2 text-destructive">
              <AlertCircle className="h-3.5 w-3.5" />
              {engine} isn't installed on this Mac yet.
            </span>
            <Button size="sm" className="h-8 w-fit gap-1.5" disabled={busy} onClick={() => void onInstall()}>
              {installing ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Download className="h-3.5 w-3.5" />
              )}
              {installing ? "Installing..." : "Install"}
            </Button>
          </div>
        )}

        {!probing && status && status.installed && !status.authed && (
          <div className="flex flex-col gap-2">
            <span className="flex items-center gap-2 text-destructive">
              <KeyRound className="h-3.5 w-3.5" />
              {engine} is installed but not signed in.
            </span>
            <div className="flex items-stretch gap-2">
              <Input
                type="password"
                value={apiKey}
                onChange={(ev) => setApiKey(ev.target.value)}
                placeholder={engine === "codex" ? "sk-... (OpenAI API key)" : "sk-ant-... (Anthropic API key)"}
                autoComplete="off"
                className="h-8 flex-1 rounded-lg border-border bg-muted/30 font-mono text-sm"
              />
              <Button
                size="sm"
                className="h-8 shrink-0 gap-1.5"
                disabled={busy || !apiKey.trim()}
                onClick={() => void onSetAuth()}
              >
                {authing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
                {authing ? "Setting..." : "Sign in"}
              </Button>
            </div>
            <p className="text-[11px] leading-snug text-muted-foreground">
              Stored only on this Mac. Prefer a browser login? Run{" "}
              <code className="rounded bg-muted/60 px-1 font-mono">{engine === "claude" ? "claude" : engine === "codex" ? "codex login" : "opencode auth login"}</code>{" "}
              in a terminal here, then{" "}
              <button
                type="button"
                className="underline underline-offset-2 hover:text-foreground"
                onClick={() => void probe(engine)}
              >
                re-check
              </button>
              .
            </p>
          </div>
        )}

        {!probing && status && !status.installed && status.err && (
          <button
            type="button"
            onClick={() => void probe(engine)}
            className="mt-2 inline-flex items-center gap-1.5 rounded-lg bg-muted/40 px-3 py-1.5 font-semibold text-muted-foreground transition-colors hover:bg-muted/60"
          >
            <RotateCw className="h-3.5 w-3.5" />
            Retry
          </button>
        )}

        {actionErr && (
          <div className="mt-2 flex items-start gap-2 text-[11.5px] text-destructive">
            <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span className="min-w-0 break-words">{actionErr}</span>
          </div>
        )}
      </div>
    </div>
  );
}

function EngineRow({
  k,
  active,
  focused,
  status,
  onToggle,
}: {
  k: EngineKey;
  active: boolean;
  focused: boolean;
  status: EngineStatus;
  onToggle: () => void;
}) {
  const { t } = useT();
  const Icon = ICONS[k];
  const badge = BADGE[k];
  const ready = isReady(status);
  return (
    <button
      onClick={onToggle}
      className={
        "flex w-full items-center gap-3 rounded-xl border px-4 py-3 text-left transition-colors " +
        (active
          ? "border-primary/40 bg-primary/5"
          : focused
            ? "border-primary/25 bg-card"
            : "border-border bg-card hover:border-foreground/20")
      }
    >
      <div
        className={
          "flex h-9 w-9 shrink-0 items-center justify-center rounded-lg " +
          (active ? "bg-primary/15 text-primary" : "bg-muted text-muted-foreground")
        }
      >
        <Icon className="h-4 w-4" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium text-foreground">{t(`engine.${k}.name`)}</span>
          {badge && (
            <span className="rounded-full bg-primary/15 px-1.5 py-0.5 text-[10px] font-medium text-primary">
              {t("consent.recommended")}
            </span>
          )}
        </div>
        <div className="text-xs text-muted-foreground">{t(`engine.${k}.desc`)}</div>
        <div className={ready ? "mt-0.5 text-[11px] text-primary" : "mt-0.5 text-[11px] text-muted-foreground"}>
          {missingText(status)}
        </div>
      </div>
      <div
        className={
          "flex h-5 w-5 shrink-0 items-center justify-center rounded-md border " +
          (active
            ? "border-primary bg-primary text-primary-foreground"
            : "border-border bg-background")
        }
      >
        {active && <Check className="h-3.5 w-3.5" />}
      </div>
    </button>
  );
}
