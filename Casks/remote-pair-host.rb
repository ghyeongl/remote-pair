cask "remote-pair-host" do
  version "0.4.13"
  sha256 "dc8d85564d4eded4a17ff0be279971cc28d0f734d984bfa2efc3352078863394"

  url "https://github.com/ghyeongl/remote-pair/releases/download/v#{version}/RemotePairHost-#{version}.zip"
  name "RemotePairHost"
  desc "Menu-bar host for remote pairing with Claude (tmux + approve + sessions)"
  homepage "https://github.com/ghyeongl/remote-pair"

  depends_on macos: :ventura

  # Self-signed (not notarized): strip quarantine so Gatekeeper allows launch and
  # TCC (Accessibility / Screen Recording) grants stick to the stable signing identity.
  # Homebrew quarantines downloads by default, so we remove it explicitly post-install.
  app "RemotePairHost.app"

  postflight do
    system_command "/usr/bin/xattr",
                   args: ["-dr", "com.apple.quarantine", "#{appdir}/RemotePairHost.app"]
  end

  uninstall quit: "com.x10lab.remote-pair-host"

  zap trash: "~/.remote-pair"

  caveats <<~EOS
    RemotePairHost is self-signed (not notarized). After install you must grant,
    in System Settings → Privacy & Security:
      • Accessibility   → RemotePairHost  (ON)
      • Screen Recording → RemotePairHost (ON)
    These grants persist across updates as long as the signing identity is stable.
  EOS
end
