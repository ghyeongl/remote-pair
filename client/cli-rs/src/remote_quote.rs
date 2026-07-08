//! POSIX shell quoting for commands sent to the **remote macOS host** over SSH.
//!
//! Decision **U1**: local Windows process spawns use argv arrays with no shell (handled at
//! the spawn site, not here). This module is *only* for building the single string payload
//! that runs under the host's POSIX `sh`/`bash` (e.g. `ssh host '<payload>'`). Keeping the
//! two concerns separate prevents the local-vs-remote conflation that broke an earlier draft.

/// Single-quote a string for safe use inside a POSIX shell command line.
///
/// Wraps `s` in single quotes and rewrites each embedded `'` as `'\''`. The result is always
/// a single shell word that expands to exactly `s` (no variable/glob/backtick expansion).
pub fn posix_single_quote(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    out.push('\'');
    for c in s.chars() {
        if c == '\'' {
            out.push_str("'\\''");
        } else {
            out.push(c);
        }
    }
    out.push('\'');
    out
}

/// Join an argv into a single POSIX-safe command string (each arg single-quoted, space-separated).
pub fn posix_join(args: &[&str]) -> String {
    args.iter()
        .map(|a| posix_single_quote(a))
        .collect::<Vec<_>>()
        .join(" ")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn plain_word() {
        assert_eq!(posix_single_quote("abc"), "'abc'");
    }

    #[test]
    fn embedded_single_quote() {
        // a'b  ->  'a'\''b'
        assert_eq!(posix_single_quote("a'b"), "'a'\\''b'");
    }

    #[test]
    fn spaces_and_shell_metachars_are_inert() {
        assert_eq!(
            posix_single_quote("a b; rm -rf $HOME `x`"),
            "'a b; rm -rf $HOME `x`'"
        );
    }

    #[test]
    fn empty_string() {
        assert_eq!(posix_single_quote(""), "''");
    }

    #[test]
    fn join_quotes_each_arg() {
        assert_eq!(
            posix_join(&[
                "tmux-aqua",
                "-S",
                "/tmp/aqua-tmux.sock",
                "attach",
                "-d",
                "-t",
                "=my session"
            ]),
            "'tmux-aqua' '-S' '/tmp/aqua-tmux.sock' 'attach' '-d' '-t' '=my session'"
        );
    }
}
