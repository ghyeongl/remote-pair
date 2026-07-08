import { useEffect, useState, type Dispatch, type SetStateAction } from "react";
import { ChevronRight, Folder, FolderOpen, FolderTree, Home, Loader2, Plus, Trash2 } from "lucide-react";
import { Button } from "@shared/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@shared/components/ui/dialog";
import { useT } from "@/lib/i18n";

export type MappingMode = "mount" | "sync";
export type Mapping = {
  id: string;
  mode: MappingMode;
  hostPath?: string;
  clientPath?: string;
  savedClientPath?: string;
  // The host path actually persisted for savedClientPath — used to tell a benign client-path narrowing
  // (host unchanged) from a real host-folder change that `xpair map add` would silently no-op.
  savedHostPath?: string;
  persisted?: boolean;
  persisting?: boolean;
  error?: string;
};

// FALLBACK ONLY: when a mapping has no stored method (FOLDER_MAP_MODES), infer it from the
// path convention. SMB mount mappings land under /Volumes/<device>/<share>;
// everything else is treated as sync.
function inferMethod(clientPath: string): MappingMode {
  return clientPath.startsWith("/Volumes/") ? "mount" : "sync";
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
        savedHostPath: hostPath,
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

type Props = {
  mappings: Mapping[];
  setMappings: Dispatch<SetStateAction<Mapping[]>>;
  hostTarget?: string;
};

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
      // Browser picks are already absolute, but resolveHostPath remains the trust boundary before any
      // mapping is mounted or persisted. It also expands manual ~ paths on the host.
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
      if (savedPath && changingPath && addWasNoOp && resolvedHostPath !== mapping.savedHostPath) {
        // The new client path is a descendant of an existing mapped root, so `xpair map add` refused it
        // ("already mapped") and the host-folder change was NOT persisted — the old root still resolves
        // this subtree to the OLD host path. Marking the row saved with the new host path would let the
        // completion gate pass while launches resolve files to the wrong host directory. Reject and ask
        // the user to remove the parent mapping first. (A benign narrowing that keeps the same host path
        // falls through and is recorded against the existing root below.)
        throw new Error(
          `This client folder is already inside the mapping for ${savedPath}. ` +
            "Remove that mapping first to point it at a different host folder.",
        );
      }
      if (savedPath && changingPath && !addWasNoOp) {
        // The replacement is saved above, so it is now safe to drop the OLD entry. Doing the remove
        // AFTER a successful add means a bad/nonexistent new client path can never lose the old mapping.
        const removed = await window.remotepair.removeMapping(savedPath);
        if (removed.code !== 0) throw new Error(removed.err || removed.out || "mapping remove failed");
      }
      // When the add was a no-op (the new client path is a descendant of the existing root), the old
      // entry is what is actually in FOLDER_MAPS — it was NOT replaced. Record savedClientPath as the
      // REAL persisted key (savedPath), not the unpersisted child, so a later Remove/Re-save runs
      // `map rm` on a key that exists instead of leaving the original mapping behind.
      const persistedKey = addWasNoOp && savedPath ? savedPath : persistedClientPath;
      patchInternal(mapping.id, {
        clientPath: persistedKey,
        hostPath: resolvedHostPath,
        savedClientPath: persistedKey,
        savedHostPath: resolvedHostPath,
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
            hostTarget={hostTarget}
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
  hostTarget,
  onChange,
  onPersist,
  onRemove,
}: {
  index: number;
  mapping: Mapping;
  hostTarget?: string;
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
        hostTarget={hostTarget}
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

type HostDirEntry = { name: string; path: string };
type HostDirListing = {
  base: string;
  entries: HostDirEntry[];
  err?: string;
  truncated?: boolean;
};
type HostCrumb = { label: string; path: string };
const HOST_ROOT_PATH = "~";
const HOST_ROOT_CRUMB: HostCrumb = { label: "~", path: HOST_ROOT_PATH };

function HostFolderBrowser({
  open,
  hostTarget,
  onClose,
  onConfirm,
}: {
  open: boolean;
  hostTarget?: string;
  onClose: () => void;
  onConfirm: (path: string) => void;
}) {
  const { t } = useT();
  const [crumbs, setCrumbs] = useState<HostCrumb[]>([HOST_ROOT_CRUMB]);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [manual, setManual] = useState("");
  const [dirCache, setDirCache] = useState<Record<string, HostDirListing>>({});
  const [loadingPaths, setLoadingPaths] = useState<Record<string, boolean>>({});

  const currentPath = crumbs[crumbs.length - 1]?.path ?? HOST_ROOT_PATH;
  const current = dirCache[currentPath];
  const children = current?.entries ?? [];
  const currentLoading = !!loadingPaths[currentPath];

  const selectedDisplayPath = manual.trim() || selectedPath || current?.base || currentPath;

  const reset = () => {
    setCrumbs([HOST_ROOT_CRUMB]);
    setSelectedPath(null);
    setManual("");
    setDirCache({});
    setLoadingPaths({});
  };

  const close = () => {
    reset();
    onClose();
  };

  const loadDir = async (targetPath: string, force = false) => {
    if (!force && dirCache[targetPath]) return !dirCache[targetPath].err;
    const target = hostTarget?.trim();
    if (!target) {
      setDirCache((cache) => ({
        ...cache,
        [targetPath]: { base: "", entries: [], err: t("map.browseNoHost") },
      }));
      return false;
    }
    setLoadingPaths((currentLoadingPaths) => ({ ...currentLoadingPaths, [targetPath]: true }));
    try {
      const result = await window.remotepair.listHostDir(target, targetPath);
      if (!result.ok) {
        setDirCache((cache) => ({
          ...cache,
          [targetPath]: {
            base: "",
            entries: [],
            err: result.err || t("map.browseError"),
          },
        }));
        return false;
      }
      setDirCache((cache) => ({
        ...cache,
        [targetPath]: {
          base: result.base,
          entries: result.entries,
          truncated: result.truncated,
        },
      }));
      return true;
    } catch (error) {
      setDirCache((cache) => ({
        ...cache,
        [targetPath]: {
          base: "",
          entries: [],
          err: mappingError(error),
        },
      }));
      return false;
    } finally {
      setLoadingPaths((currentLoadingPaths) => {
        const next = { ...currentLoadingPaths };
        delete next[targetPath];
        return next;
      });
    }
  };

  useEffect(() => {
    if (!open) return;
    setCrumbs([HOST_ROOT_CRUMB]);
    setSelectedPath(null);
    setManual("");
    setDirCache({});
    setLoadingPaths({});
    void loadDir(HOST_ROOT_PATH, true);
    // Fetch on dialog open and when the selected host changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, hostTarget]);

  const enterFolder = (entry: HostDirEntry) => {
    setCrumbs((currentCrumbs) => [...currentCrumbs, { label: entry.name, path: entry.path }]);
    setSelectedPath(null);
    void loadDir(entry.path);
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (!v) close();
      }}
    >
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="text-base">{t("map.browserTitle")}</DialogTitle>
        </DialogHeader>

        <div className="flex flex-wrap items-center gap-0.5 rounded-lg border border-border bg-muted/30 px-2 py-1.5 text-xs">
          {crumbs.map((crumb, i) => (
            <div key={`${crumb.path}-${i}`} className="flex items-center gap-0.5">
              <button
                type="button"
                onClick={() => {
                  setCrumbs(crumbs.slice(0, i + 1));
                  setSelectedPath(null);
                  void loadDir(crumb.path);
                }}
                className="rounded px-1.5 py-0.5 font-mono text-foreground hover:bg-accent"
              >
                {crumb.label === "~" ? <Home className="inline h-3 w-3" /> : crumb.label}
              </button>
              {i < crumbs.length - 1 && (
                <ChevronRight className="h-3 w-3 text-muted-foreground" />
              )}
            </div>
          ))}
        </div>

        <div className="max-h-64 min-h-32 overflow-y-auto rounded-lg border border-border bg-background">
          {currentLoading && !current ? (
            <div className="flex items-center justify-center gap-2 p-6 text-center text-xs text-muted-foreground">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              {t("map.browseLoading")}
            </div>
          ) : current?.err ? (
            <div className="p-6 text-center text-xs">
              <p className="font-medium text-destructive">{t("map.browseError")}</p>
              <p className="mt-1 break-words text-muted-foreground">{current.err}</p>
            </div>
          ) : children.length === 0 ? (
            <div className="p-6 text-center text-xs text-muted-foreground">
              {t("map.emptyFolder")}
            </div>
          ) : (
            children.map((c) => {
              const isSelected = selectedPath === c.path;
              const isLoading = !!loadingPaths[c.path];
              return (
                <div
                  key={c.path}
                  onClick={() => setSelectedPath(c.path)}
                  onDoubleClick={() => enterFolder(c)}
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
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      enterFolder(c);
                    }}
                    disabled={isLoading}
                    className="rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground disabled:cursor-wait"
                    title={t("map.openFolder")}
                  >
                    {isLoading ? (
                      <Loader2 className="h-3 w-3 animate-spin" />
                    ) : (
                      <ChevronRight className="h-3 w-3" />
                    )}
                  </button>
                </div>
              );
            })
          )}
        </div>
        {current?.truncated ? (
          <p className="text-[11px] text-muted-foreground">{t("map.browseTruncated")}</p>
        ) : null}

        <div className="space-y-1">
          <div className="text-xs text-muted-foreground">
            {t("map.selected")}{" "}
            <span className="break-all font-mono text-foreground">{selectedDisplayPath}</span>
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
          <Button variant="ghost" size="sm" onClick={close}>
            {t("map.cancel")}
          </Button>
          <Button
            size="sm"
            onClick={() => {
              onConfirm(selectedDisplayPath);
              reset();
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
