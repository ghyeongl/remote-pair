import { useState, type Dispatch, type SetStateAction } from "react";
import { ChevronRight, Folder, FolderOpen, FolderTree, Home, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useT } from "@/lib/i18n";

export type MappingMode = "mount" | "sync";
export type Mapping = {
  id: string;
  mode: MappingMode;
  hostPath?: string;
  clientPath?: string;
  savedClientPath?: string;
  persisted?: boolean;
  persisting?: boolean;
  error?: string;
};

// FALLBACK ONLY: when a mapping has no stored method (FOLDER_MAP_MODES), infer it from the
// path convention. Mount mappings created by the default mount backend live under this root;
// everything else is treated as sync.
function inferMethod(clientPath: string): MappingMode {
  return clientPath.includes("/.xpair/host/mounts/") ? "mount" : "sync";
}

function parseModes(raw: string): Map<string, MappingMode> {
  const m = new Map<string, MappingMode>();
  for (const entry of (raw || "").split(";")) {
    const s = entry.trim();
    if (!s) continue;
    const idx = s.indexOf("::");
    if (idx === -1) continue;
    const clientPath = s.slice(0, idx);
    const method = s.slice(idx + 2);
    if (method === "mount") m.set(clientPath, "mount");
    else if (method === "sync") m.set(clientPath, "sync");
  }
  return m;
}

/** Parse FOLDER_MAPS (`client::host;...`) into redesigned Mapping rows, taking each mapping's
 * stored method from FOLDER_MAP_MODES (`client::mount;client2::sync`) when present. */
export function parseFolderMaps(raw: string, modes?: string): Mapping[] {
  if (!raw) return [];
  const modeOf = parseModes(modes || "");
  return raw
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((entry, index) => {
      const idx = entry.indexOf("::");
      const clientPath = idx === -1 ? entry : entry.slice(0, idx);
      const hostPath = idx === -1 ? "" : entry.slice(idx + 2);
      return {
        id: `${clientPath}::${hostPath}::${index}`,
        mode: modeOf.get(clientPath) ?? inferMethod(clientPath),
        hostPath,
        clientPath,
        savedClientPath: clientPath,
        persisted: !!clientPath && !!hostPath,
      };
    });
}

export function isPersistedRealMapping(mapping: Mapping): boolean {
  return !!(
    mapping.persisted &&
    mapping.hostPath?.trim() &&
    mapping.clientPath?.trim()
  );
}

type FsNode = { name: string; children?: FsNode[] };

// TODO(US-004/host-fs): replace HOST_FS sample with a real host listing bridge.
const HOST_FS: FsNode = {
  name: "~",
  children: [
    {
      name: "Spaces",
      children: [
        { name: "Work", children: [{ name: "monorepo" }, { name: "designs" }] },
        { name: "Personal", children: [{ name: "notes" }, { name: "photos" }] },
      ],
    },
    {
      name: "Documents",
      children: [
        { name: "Projects", children: [{ name: "xpair" }, { name: "site" }] },
        { name: "Invoices" },
      ],
    },
    { name: "Downloads", children: [{ name: "installers" }] },
    { name: "Developer", children: [{ name: "sandbox" }, { name: "scripts" }] },
    { name: "Google Drive", children: [{ name: "Shared" }, { name: "My Drive" }] },
  ],
};

type Props = {
  mappings: Mapping[];
  setMappings: Dispatch<SetStateAction<Mapping[]>>;
  hostTarget?: string;
};

function needsHostResolution(hostPath: string) {
  return hostPath.startsWith("~") || !hostPath.startsWith("/");
}

function mappingError(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

export function StepMappings({ mappings, setMappings, hostTarget }: Props) {
  const { t } = useT();
  const add = () =>
    setMappings((current) => [...current, { id: crypto.randomUUID(), mode: "mount" }]);
  const remove = async (id: string) => {
    const mapping = mappings.find((m) => m.id === id);
    if (!mapping?.savedClientPath) {
      setMappings((current) => current.filter((m) => m.id !== id));
      return;
    }
    patchInternal(id, { persisting: true, error: "" });
    try {
      const removed = await window.remotepair.removeMapping(mapping.savedClientPath);
      if (removed.code !== 0) throw new Error(removed.err || removed.out || "mapping remove failed");
      setMappings((current) => current.filter((m) => m.id !== id));
    } catch (error) {
      patchInternal(id, { persisting: false, error: mappingError(error) });
    }
  };
  const patch = (id: string, p: Partial<Mapping>) =>
    setMappings((current) =>
      current.map((m) =>
        m.id === id ? { ...m, ...p, persisted: false, error: undefined } : m,
      ),
    );
  const patchInternal = (id: string, p: Partial<Mapping>) =>
    setMappings((current) => current.map((m) => (m.id === id ? { ...m, ...p } : m)));
  const persist = async (mapping: Mapping) => {
    const hostPath = mapping.hostPath?.trim() || "";
    const clientPath = mapping.clientPath?.trim() || "";
    if (!hostPath) {
      patchInternal(mapping.id, { error: "Choose a host folder first." });
      return;
    }
    if (mapping.mode === "sync" && !clientPath) {
      patchInternal(mapping.id, { error: "Choose a client folder first." });
      return;
    }
    patchInternal(mapping.id, { persisting: true, error: "" });
    try {
      let resolvedHostPath = hostPath;
      if (needsHostResolution(hostPath)) {
        const target = hostTarget?.trim();
        if (!target) {
          patchInternal(mapping.id, { persisting: false, error: "Select a host first." });
          return;
        }
        const resolved = await window.remotepair.resolveHostPath(target, hostPath);
        if (!resolved.ok) {
          patchInternal(mapping.id, {
            persisting: false,
            error: `Host folder not found: ${hostPath}`,
          });
          return;
        }
        resolvedHostPath = resolved.path;
      }
      let persistedClientPath = clientPath;
      if (mapping.mode === "mount") {
        const mounted = await window.remotepair.mount(resolvedHostPath);
        if (mounted.code !== 0) throw new Error(mounted.err || mounted.out || "mount failed");
        persistedClientPath =
          mounted.mountpoint || (await window.remotepair.defaultMountpoint(resolvedHostPath));
      }
      const savedPath = mapping.savedClientPath;
      const changingPath = !!savedPath && savedPath !== persistedClientPath;
      if (savedPath && !changingPath) {
        // Same client path re-save: `xpair map add` appends, so drop the prior entry first to avoid a
        // duplicate. Safe because the path is unchanged (already known to exist).
        const removed = await window.remotepair.removeMapping(savedPath);
        if (removed.code !== 0) throw new Error(removed.err || removed.out || "mapping remove failed");
      }
      const added = await window.remotepair.addMapping(
        persistedClientPath,
        resolvedHostPath,
        mapping.mode,
      );
      if (added.code !== 0) throw new Error(added.err || added.out || "mapping save failed");
      // `xpair map add` no-ops (rc 0, "already mapped …") when the new client path is a DESCENDANT of an
      // existing mapped root — including the OLD mapping we're editing. In that case nothing new was
      // persisted, so dropping the old entry would delete the only mapping (which still serves the new
      // path via longest-prefix resolution) → data loss. Only remove the old entry when the add really
      // persisted a distinct new one.
      const addWasNoOp = /already mapped/i.test(added.out || "");
      if (savedPath && changingPath && !addWasNoOp) {
        // The replacement is saved above, so it is now safe to drop the OLD entry. Doing the remove
        // AFTER a successful add means a bad/nonexistent new client path can never lose the old mapping.
        const removed = await window.remotepair.removeMapping(savedPath);
        if (removed.code !== 0) throw new Error(removed.err || removed.out || "mapping remove failed");
      }
      patchInternal(mapping.id, {
        clientPath: persistedClientPath,
        hostPath: resolvedHostPath,
        savedClientPath: persistedClientPath,
        persisted: true,
        persisting: false,
        error: "",
      });
    } catch (error) {
      patchInternal(mapping.id, {
        persisted: false,
        persisting: false,
        error: mappingError(error),
      });
    }
  };

  return (
    <div>
      <h2 className="text-xl font-semibold tracking-tight text-foreground">
        {t("map.title")}
      </h2>
      <p className="mt-1.5 text-sm text-muted-foreground">{t("map.desc")}</p>

      <div className="mt-6 space-y-3">
        {mappings.length === 0 && (
          <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-border py-10 text-center">
            <FolderTree className="h-7 w-7 text-muted-foreground/60" />
            <p className="mt-3 text-sm text-muted-foreground">{t("map.empty")}</p>
          </div>
        )}

        {mappings.map((m, i) => (
          <MappingRow
            key={m.id}
            index={i}
            mapping={m}
            onChange={(p) => patch(m.id, p)}
            onPersist={() => void persist(m)}
            onRemove={() => void remove(m.id)}
          />
        ))}

        <Button variant="outline" size="sm" onClick={add} className="w-full">
          <Plus className="mr-1.5 h-4 w-4" />
          {t("map.add")}
        </Button>
      </div>
    </div>
  );
}

function MappingRow({
  index,
  mapping,
  onChange,
  onPersist,
  onRemove,
}: {
  index: number;
  mapping: Mapping;
  onChange: (p: Partial<Mapping>) => void;
  onPersist: () => void;
  onRemove: () => void;
}) {
  const { t } = useT();
  const [browserOpen, setBrowserOpen] = useState(false);
  const [clientOpen, setClientOpen] = useState(false);
  const canPersist = !!mapping.hostPath && (mapping.mode === "mount" || !!mapping.clientPath);

  return (
    <div className="rounded-xl border border-border bg-card p-4">
      <div className="mb-3 flex items-center justify-between">
        <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          {t("map.n")} {index + 1}
        </span>
        <button
          type="button"
          onClick={onRemove}
          disabled={mapping.persisting}
          className="text-muted-foreground hover:text-destructive"
          aria-label={t("map.remove")}
        >
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      </div>

      <div className="mb-3 inline-flex rounded-lg border border-border bg-muted/40 p-0.5">
        {(["mount", "sync"] as const).map((mode) => (
          <button
            type="button"
            key={mode}
            onClick={() => onChange({ mode, clientPath: mode === "mount" ? undefined : mapping.clientPath })}
            className={
              "rounded-md px-3 py-1 text-xs font-medium transition-colors " +
              (mapping.mode === mode
                ? "bg-background text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground")
            }
          >
            {mode === "mount" ? t("map.modeMount") : t("map.modeSync")}
          </button>
        ))}
      </div>

      <p className="mb-3 text-xs text-muted-foreground">
        {mapping.mode === "mount" ? t("map.mountDesc") : t("map.syncDesc")}
      </p>

      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        <PathButton
          label={t("map.hostFolder")}
          value={mapping.hostPath}
          onClick={() => setBrowserOpen(true)}
        />
        {mapping.mode === "sync" && (
          <PathButton
            label={t("map.clientFolder")}
            value={mapping.clientPath}
            onClick={() => setClientOpen(true)}
          />
        )}
      </div>

      {mapping.mode === "mount" && mapping.clientPath ? (
        <div className="mt-2 truncate font-mono text-[11px] text-muted-foreground">
          {mapping.clientPath}
        </div>
      ) : null}

      <div className="mt-3 flex items-center justify-between gap-3">
        <div className="min-w-0 text-xs">
          {mapping.error ? (
            <span className="text-destructive">{mapping.error}</span>
          ) : mapping.persisted ? (
            <span className="text-primary">Saved</span>
          ) : (
            <span className="text-muted-foreground">Not saved</span>
          )}
        </div>
        <Button
          size="sm"
          variant="secondary"
          disabled={!canPersist || mapping.persisting}
          onClick={onPersist}
        >
          {mapping.persisting ? "Saving" : "Save"}
        </Button>
      </div>

      <HostFolderBrowser
        open={browserOpen}
        onClose={() => setBrowserOpen(false)}
        onConfirm={(p) => {
          onChange({ hostPath: p });
          setBrowserOpen(false);
        }}
      />
      <ClientPathPopover
        open={clientOpen}
        onClose={() => setClientOpen(false)}
        onPick={(p) => {
          onChange({ clientPath: p });
          setClientOpen(false);
        }}
      />
    </div>
  );
}

function PathButton({
  label,
  value,
  onClick,
}: {
  label: string;
  value?: string;
  onClick: () => void;
}) {
  const { t } = useT();
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex w-full items-center gap-2 rounded-lg border border-border bg-background px-3 py-2 text-left text-xs transition-colors hover:border-foreground/20"
    >
      <Folder className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
      <span className="min-w-0 flex-1 truncate font-mono">
        {value ?? (
          <span className="text-muted-foreground">
            {t("map.choose")} {label.toLowerCase()}…
          </span>
        )}
      </span>
    </button>
  );
}

function nodeAt(path: string[]): FsNode | null {
  let cur: FsNode = HOST_FS;
  for (let i = 1; i < path.length; i++) {
    const next = cur.children?.find((c) => c.name === path[i]);
    if (!next) return null;
    cur = next;
  }
  return cur;
}

function HostFolderBrowser({
  open,
  onClose,
  onConfirm,
}: {
  open: boolean;
  onClose: () => void;
  onConfirm: (path: string) => void;
}) {
  const { t } = useT();
  const [path, setPath] = useState<string[]>(["~"]);
  const [selectedName, setSelectedName] = useState<string | null>(null);
  const [manual, setManual] = useState("");

  const current = nodeAt(path);
  const children = current?.children ?? [];

  const selectedPath = selectedName
    ? [...path, selectedName].join("/").replace(/^~\//, "~/")
    : path.join("/").replace(/^~\//, "~/");

  const enterFolder = (name: string) => {
    setPath((p) => [...p, name]);
    setSelectedName(null);
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (!v) {
          setPath(["~"]);
          setSelectedName(null);
          setManual("");
          onClose();
        }
      }}
    >
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="text-base">{t("map.browserTitle")}</DialogTitle>
        </DialogHeader>

        <div className="flex flex-wrap items-center gap-0.5 rounded-lg border border-border bg-muted/30 px-2 py-1.5 text-xs">
          {path.map((seg, i) => (
            <div key={i} className="flex items-center gap-0.5">
              <button
                type="button"
                onClick={() => {
                  setPath(path.slice(0, i + 1));
                  setSelectedName(null);
                }}
                className="rounded px-1.5 py-0.5 font-mono text-foreground hover:bg-accent"
              >
                {seg === "~" ? <Home className="inline h-3 w-3" /> : seg}
              </button>
              {i < path.length - 1 && (
                <ChevronRight className="h-3 w-3 text-muted-foreground" />
              )}
            </div>
          ))}
        </div>

        <div className="max-h-64 min-h-32 overflow-y-auto rounded-lg border border-border bg-background">
          {children.length === 0 ? (
            <div className="p-6 text-center text-xs text-muted-foreground">
              {t("map.emptyFolder")}
            </div>
          ) : (
            children.map((c) => {
              const hasKids = !!c.children?.length;
              const isSelected = selectedName === c.name;
              return (
                <div
                  key={c.name}
                  onClick={() => setSelectedName(c.name)}
                  onDoubleClick={() => hasKids && enterFolder(c.name)}
                  className={
                    "flex w-full cursor-pointer items-center gap-2 border-b border-border/50 px-3 py-2 text-left text-xs last:border-b-0 " +
                    (isSelected
                      ? "bg-accent text-foreground"
                      : "hover:bg-accent/50")
                  }
                >
                  {isSelected ? (
                    <FolderOpen className="h-3.5 w-3.5 text-primary" />
                  ) : (
                    <Folder className="h-3.5 w-3.5 text-primary/70" />
                  )}
                  <span className="flex-1 font-mono">{c.name}</span>
                  {hasKids && (
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        enterFolder(c.name);
                      }}
                      className="rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"
                      title={t("map.openFolder")}
                    >
                      <ChevronRight className="h-3 w-3" />
                    </button>
                  )}
                </div>
              );
            })
          )}
        </div>

        <div className="space-y-1">
          <div className="text-xs text-muted-foreground">
            {t("map.selected")}{" "}
            <span className="font-mono text-foreground">{manual.trim() || selectedPath}</span>
          </div>
          <input
            value={manual}
            onChange={(e) => setManual(e.target.value)}
            placeholder="~/Spaces/Work or /Users/you/project"
            className="w-full rounded-lg border border-border bg-background px-3 py-2 font-mono text-xs outline-none focus:border-foreground/30"
          />
          <p className="text-[11px] text-muted-foreground">{t("map.hostManualHint")}</p>
        </div>

        <DialogFooter>
          <Button variant="ghost" size="sm" onClick={onClose}>
            {t("map.cancel")}
          </Button>
          <Button
            size="sm"
            onClick={() => {
              onConfirm(manual.trim() || selectedPath);
              setPath(["~"]);
              setSelectedName(null);
              setManual("");
            }}
          >
            {t("map.chooseThis")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function isManualClientPath(p: string) {
  return p.startsWith("/") || p.startsWith("~/");
}

function ClientPathPopover({
  open,
  onClose,
  onPick,
}: {
  open: boolean;
  onClose: () => void;
  onPick: (p: string) => void;
}) {
  const { t } = useT();
  const [manual, setManual] = useState("");
  const [error, setError] = useState<string | null>(null);

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle className="text-base">{t("map.localTitle")}</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <p className="text-xs text-muted-foreground">
            {t("map.localUnsupported")}
          </p>
          <div className="space-y-1">
            <input
              value={manual}
              onChange={(e) => setManual(e.target.value)}
              placeholder="~/GoogleDrive/Shared"
              className="w-full rounded-lg border border-border bg-background px-3 py-2 font-mono text-xs outline-none focus:border-foreground/30"
            />
            <Button
              variant="outline"
              size="sm"
              className="w-full"
              disabled={!manual.trim()}
              onClick={() => {
                const next = manual.trim();
                if (!isManualClientPath(next)) {
                  setError("Enter an absolute path starting with / or ~/.");
                  return;
                }
                setError(null);
                onPick(next);
              }}
            >
              {t("map.chooseThis")}
            </Button>
          </div>
          {error && <p className="text-xs text-destructive">{error}</p>}
        </div>
      </DialogContent>
    </Dialog>
  );
}
