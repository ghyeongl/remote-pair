# Xpair IDE (VSCodium fork — Vendor separation / Option C)

`client/ide/` is Xpair's VSCodium-based IDE, restructured so Xpair-owned code is
cleanly separated from the **pristine** VSCodium build recipe.

## Layout

```
client/ide/
├─ remotepair/              ← everything Xpair owns (the only files we maintain)
│  ├─ ext/                  embedded extension + generate-contracts.mjs + committed generated/
│  ├─ patches/              zz-remotepair-ide-frontend.patch (the whole Xpair frontend)
│  ├─ product.overlay.json  Xpair branding (merged onto stock product.json at build)
│  ├─ dev-build.sh          Xpair build orchestrator (= pristine dev/build.sh + identity)
│  └─ REMOTEPAIR.md         authoritative Xpair-surface manifest + invariants
├─ vendor/vscodium/         ← PRISTINE VSCodium recipe, git subtree from VSCodium/vscodium
│                             (remote `vscodium`). Do NOT edit — changes go in remotepair/.
├─ build.sh                 thin wrapper: inject Xpair artifacts → run remotepair/dev-build.sh
├─ update_upstream.sh       documents `git subtree pull` for the vendor recipe
└─ README.md  .gitignore  .nvmrc  .editorconfig
```

## Build

```sh
cd client/ide && ./build.sh        # -> dist/VSCode-darwin-<arch>/Xpair.app
```

`build.sh` injects `remotepair/`'s frontend patch + branding overlay into the pristine vendor
recipe (trap-cleaned afterward, so `vendor/` stays byte-pristine for the next subtree pull),
then runs `remotepair/dev-build.sh` with CWD = the recipe root. Requires nvm node (`.nvmrc`).
Build flags pass through to `dev-build.sh` (`-p` build assets, `-o` skip build, `-s` skip source).

Dev-watch operates inside the checkout at `vendor/vscodium/vscode/` (created by the first build).

### Windows IDE build

Windows packaging runs through the same wrapper from Git Bash:

```sh
cd client/ide
XPAIR_CLI_EXE=/c/path/to/xpair.exe ./build.sh
```

`XPAIR_CLI_EXE` is optional but recommended. When it points at a built native CLI, `build.sh`
copies it into `dist/VSCode-win32-*/resources/app/bin/xpair.exe` before creating
`dist/Xpair-win32-*-<build>.zip`. If `XPAIR_CLI_EXE` is unset, the zip is still produced with
a loud warning and no bundled `xpair.exe`; this lets branches before `client/cli-rs` exists keep
validating the IDE package.

The CI path is `.github/workflows/win32-ide-build.yml`, a manual plus weekly workflow for the
self-hosted `[self-hosted, Windows, X64, Win11]` runner. The runner needs Git Bash, Node/npm
matching `client/ide/.nvmrc`, Python, rustup/cargo, MSVC Build Tools, and Windows PowerShell
for `Compress-Archive`.

## Upstream sync (Option C)

`vendor/vscodium/` tracks pristine VSCodium directly; Xpair files never round-trip:

```sh
git subtree pull --prefix=client/ide/vendor/vscodium vscodium <tag> --squash
```

Current anchor: VSCodium **1.121.03429** (VS Code 1.121.0). See `./update_upstream.sh`.

See **`remotepair/REMOTEPAIR.md`** for the full Xpair surface + invariants, and
`vendor/vscodium/README.md` for upstream VSCodium documentation.
