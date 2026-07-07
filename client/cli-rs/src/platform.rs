//! OS detection + per-OS capability flags.
//!
//! Ports `_xpair_os()` (`client/cli/xpair:40-46`, `client/cli/xpair-launch:24-30`). Unlike the
//! bash version that parses `uname`, each compiled binary already knows its target OS via
//! `cfg!(target_os=…)`, which is more reliable. An `RP_OS` env override is honored for
//! parity with the bash override and to exercise per-OS branches in tests.

use std::fmt;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Os {
    Mac,
    Linux,
    Windows,
}

impl Os {
    /// The OS this binary is running on, honoring an `RP_OS` override (`mac|linux|windows`).
    pub fn current() -> Os {
        if let Ok(v) = std::env::var("RP_OS") {
            if let Some(os) = Os::parse(&v) {
                return os;
            }
        }
        Os::compiled()
    }

    /// The compile-time target OS (ignores any override).
    pub const fn compiled() -> Os {
        if cfg!(target_os = "macos") {
            Os::Mac
        } else if cfg!(target_os = "windows") {
            Os::Windows
        } else {
            Os::Linux
        }
    }

    /// Parse an `RP_OS`-style token. Accepts the `uname`-ish spellings the bash detected
    /// (`MINGW*/MSYS*/CYGWIN*` → windows) so existing overrides keep working.
    pub fn parse(s: &str) -> Option<Os> {
        let s = s.trim().to_ascii_lowercase();
        match s.as_str() {
            "mac" | "macos" | "darwin" => Some(Os::Mac),
            "linux" => Some(Os::Linux),
            "windows" | "win" => Some(Os::Windows),
            other => {
                if other.starts_with("mingw")
                    || other.starts_with("msys")
                    || other.starts_with("cygwin")
                {
                    Some(Os::Windows)
                } else {
                    None
                }
            }
        }
    }

    /// Whether SSH connection multiplexing (`ControlMaster`/`ControlPath`/`ControlPersist`)
    /// is usable. **FALSE on Windows** (decision **C1**): Win32-OpenSSH has never supported
    /// multiplexing — its mux path relies on AF_UNIX `SCM_RIGHTS` fd-passing that has no
    /// Windows equivalent (Win32-OpenSSH issues #1328/#405, open ~10 years). On Windows we
    /// spawn an independent `ssh.exe` per connection and pass the neutralizer args below.
    pub fn supports_multiplexing(self) -> bool {
        !matches!(self, Os::Windows)
    }

    /// SSH args that neutralize any ambient `~/.ssh/config` multiplexing settings. On Windows
    /// this is `-o ControlMaster=no -o ControlPath=none` (so a stray user config can't trigger
    /// the `muxclient socket(): Unknown error`); empty on mac/linux where multiplexing is kept.
    pub fn ssh_mux_neutralizer_args(self) -> &'static [&'static str] {
        if self.supports_multiplexing() {
            &[]
        } else {
            &["-o", "ControlMaster=no", "-o", "ControlPath=none"]
        }
    }
}

impl fmt::Display for Os {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            Os::Mac => "mac",
            Os::Linux => "linux",
            Os::Windows => "windows",
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn windows_disables_multiplexing() {
        assert!(!Os::Windows.supports_multiplexing());
        assert_eq!(
            Os::Windows.ssh_mux_neutralizer_args(),
            &["-o", "ControlMaster=no", "-o", "ControlPath=none"]
        );
    }

    #[test]
    fn unix_keeps_multiplexing() {
        assert!(Os::Mac.supports_multiplexing());
        assert!(Os::Linux.supports_multiplexing());
        assert!(Os::Mac.ssh_mux_neutralizer_args().is_empty());
        assert!(Os::Linux.ssh_mux_neutralizer_args().is_empty());
    }

    #[test]
    fn parses_unameish_spellings() {
        assert_eq!(Os::parse("Darwin"), Some(Os::Mac));
        assert_eq!(Os::parse("MINGW64_NT-10.0"), Some(Os::Windows));
        assert_eq!(Os::parse("MSYS_NT-10.0"), Some(Os::Windows));
        assert_eq!(Os::parse("CYGWIN_NT-10.0"), Some(Os::Windows));
        assert_eq!(Os::parse("Linux"), Some(Os::Linux));
        assert_eq!(Os::parse("plan9"), None);
    }

    #[test]
    fn display_roundtrips() {
        assert_eq!(Os::Windows.to_string(), "windows");
        assert_eq!(Os::Mac.to_string(), "mac");
        assert_eq!(Os::Linux.to_string(), "linux");
    }
}
