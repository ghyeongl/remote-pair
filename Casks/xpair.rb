cask "xpair" do
  version "0.5.1a1" # release-pinned (NOT the dev shared/.build-counter, which bumps per build); bump when cutting a release
  sha256 :no_check # self-signed (not notarized); quarantine stripped post-install

  url "https://github.com/x10lab/xpair/releases/download/v#{version}/Xpair-#{version}.zip"
  name "Xpair"
  desc "Client IDE for remote pairing with Claude (VSCodium fork: Sessions sidebar + Browser)"
  homepage "https://github.com/x10lab/xpair"

  depends_on macos: :ventura
  # The client IDE ships an arm64-only build (VSCodium fork). Reject Intel explicitly instead of
  # failing silently at launch. (universal via lipo is a separate follow-up.)
  depends_on arch: :arm64

  # Self-signed (not notarized): strip quarantine so Gatekeeper allows launch and TCC (folder
  # access / mic) grants stick to the stable signing identity. Homebrew quarantines downloads by
  # default, so we remove it explicitly post-install.
  app "Xpair.app"

  postflight do
    system_command "/usr/bin/xattr",
                   args: ["-dr", "com.apple.quarantine", "#{appdir}/Xpair.app"]
  end

  uninstall quit: "com.x10lab.xpair"

  zap trash: [
    "~/.xpair/client",
    "~/.xpair/ide",
    "~/.xpair/ide-server",
  ]

  caveats <<~EOS
    Xpair (client IDE) is self-signed (not notarized). Gatekeeper quarantine is stripped on
    install. The host side is a separate cask:
      brew install --cask xpair-host
  EOS
end
