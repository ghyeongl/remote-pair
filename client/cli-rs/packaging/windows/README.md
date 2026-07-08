# Windows packaging — `.msi` (WiX)

POC installer for the native `xpair.exe`, built with the [WiX Toolset](https://wixtoolset.org/)
v5 (`dotnet tool install --global wix`). VSCodium-native installers are WiX-based, so this
keeps the client on the same toolchain.

## What it does
- Installs `xpair.exe` to `C:\Program Files\Xpair` (per-machine → requires elevation).
- Appends that folder to the **system** `PATH` (removed on uninstall).
- `MajorUpgrade` blocks downgrades and replaces same-or-newer cleanly.

## Not yet (deferred)
- **Code signing** — v1 ships unsigned per the plan; SmartScreen will warn until signed.
- Start-menu shortcuts, a UI sequence, per-user scope, file associations.
- Version is stamped by CI from `Cargo.toml`; `xpair self-update` installs the MSI published on
  GitHub Releases (`xpair-<version>-x64.msi`, falling back to `xpair-cli.msi`).

## Build locally
```sh
cd client/cli-rs
cargo build --release --locked
dotnet tool install --global wix
wix build packaging/windows/xpair.wxs -b target/release -arch x64 \
  -d Version=0.1.0 -o xpair-0.1.0-x64.msi
```

CI builds this on `windows-latest` (`.github/workflows/package-windows.yml`) as a build artifact;
the release workflow builds on the self-hosted Win11 runner and uploads both MSI asset names to the
GitHub Release.
