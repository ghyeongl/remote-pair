cask "xpair-host" do
  version "0.5.1a1" # release-pinned (NOT the dev shared/.build-counter, which bumps per build); bump when cutting a release
  sha256 :no_check # self-signed (not notarized); quarantine stripped post-install

  url "https://github.com/x10lab/xpair/releases/download/v#{version}/XpairHost-#{version}.zip"
  name "XpairHost"
  desc "Menu-bar host for remote pairing with Claude (tmux + approve + sessions)"
  homepage "https://github.com/x10lab/xpair"

  depends_on macos: :ventura
  # The host bundles arm64-only binaries (app + screen sidecar + Swift helpers,
  # all built -target arm64-apple-macos13.0). Reject Intel explicitly instead of
  # failing silently at launch. (universal via lipo is a separate follow-up.)
  depends_on arch: :arm64

  # Self-signed (not notarized): strip quarantine so Gatekeeper allows launch and
  # TCC (Accessibility / Screen Recording) grants stick to the stable signing identity.
  # Homebrew quarantines downloads by default, so we remove it explicitly post-install.
  app "XpairHost.app"

  postflight do
    system_command "/usr/bin/xattr",
                   args: ["-dr", "com.apple.quarantine", "#{appdir}/XpairHost.app"]
  end

  uninstall launchctl: [
              "com.x10lab.xpair-host",
              "com.x10lab.xpair-host-watchdog",
            ],
            quit: "com.x10lab.xpair-host",
            trash: [
              "~/Library/LaunchAgents/com.x10lab.xpair-host.plist",
              "~/Library/LaunchAgents/com.x10lab.xpair-host-watchdog.plist",
            ]

  zap trash: [
    "~/Library/LaunchAgents/com.x10lab.xpair-host.plist",
    "~/Library/LaunchAgents/com.x10lab.xpair-host-watchdog.plist",
    "~/.xpair/host",
    "~/.local/share/xpair",
  ]

  caveats <<~EOS
    XpairHost is self-signed (not notarized). After install you must grant,
    in System Settings → Privacy & Security:
      • Accessibility   → XpairHost  (ON)
      • Screen Recording → XpairHost (ON)
    These grants persist across updates as long as the signing identity is stable.
  EOS
end
