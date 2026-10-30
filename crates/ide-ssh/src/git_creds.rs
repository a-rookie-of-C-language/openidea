//! Saved git HTTPS credentials, in the app's own secret store (next to the SSH
//! passwords), never in git's global configuration. Answers to askpass prompts
//! are remembered only after the git command that used them succeeded, and a
//! stored credential that fails authentication is forgotten so the next command
//! asks again.

use crate::secrets::SecretFile;
use parking_lot::Mutex;
use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::Arc;

/// A stored credential: `user` answered `Username for …`, `secret` the password.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct GitCredential {
    pub user: String,
    pub secret: String,
}

/// What [`GitCredentials::lookup`] decided for a prompt.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum GitAnswer {
    /// Answer the prompt with this text without asking the user.
    Auto(String),
    /// Nothing stored; the dialog may offer to remember a new credential.
    PromptNew,
}

/// Shared store: a [`SecretFile`] of `scheme://host` → `user\nsecret`, plus the
/// state of the git command currently running (credentials it consumed and
/// answers to save when it succeeds).
#[derive(Clone)]
pub struct GitCredentials {
    saved: Arc<SecretFile>,
    session: Arc<Mutex<Session>>,
}

#[derive(Default)]
struct Session {
    /// Stored credentials this command used (possibly wrong): forgotten if the
    /// command fails with an authentication error.
    used: HashSet<String>,
    /// `scheme://host` → credential the user asked to remember: written when the
    /// command succeeds.
    pending: HashMap<String, GitCredential>,
}

/// Global instance: the askpass server and every `git` child process agree on it.
static INSTANCE: Mutex<Option<GitCredentials>> = Mutex::new(None);

/// Installs the store of `path` (the app's data directory). Called once at
/// start-up; git prompts before that are simply not remembered.
pub fn init(path: PathBuf) {
    *INSTANCE.lock() = Some(GitCredentials { saved: Arc::new(SecretFile::new(path)), session: Arc::default() });
}

/// The installed store, if start-up got that far.
pub fn get() -> Option<GitCredentials> {
    INSTANCE.lock().clone()
}

/// `scheme://host` of an HTTPS prompt (`Username for 'https://host'` /
/// `Password for 'https://user@host'`); `None` for anything else (SSH prompts,
/// passphrases, host-key questions — none of git's business here).
pub fn prompt_key(prompt: &str) -> Option<String> {
    let quoted = prompt.split('\'').nth(1)?;
    let (scheme, rest) = quoted.split_once("://")?;
    if !matches!(scheme, "http" | "https") {
        return None;
    }
    let authority = rest.split('/').next()?;
    // `user@host` (possibly with a password): keep the host part only.
    let host = authority.rsplit('@').next()?;
    let host = host.split(':').next()?; // port is not part of the key
    if host.is_empty() {
        return None;
    }
    Some(format!("{scheme}://{host}"))
}

/// The user name embedded in a password prompt (`https://user@host`), if any.
/// Git URL-encodes it (`%40` for `@`), which a lookup must match.
fn prompt_user(prompt: &str) -> Option<String> {
    let quoted = prompt.split('\'').nth(1)?;
    let authority = quoted.split_once("://")?.1.split('/').next()?;
    let (user, _) = authority.rsplit_once('@')?;
    let user = user.split(':').next()?;
    (!user.is_empty()).then(|| user.to_owned())
}

/// `stderr` of a failed git command says the stored credential was rejected.
fn is_auth_failure(stderr: &str) -> bool {
    let s = stderr.to_ascii_lowercase();
    s.contains("authentication failed")
        || s.contains("authentication unsuccessful")
        || s.contains("invalid username or password")
        || s.contains("access denied")
        || s.contains("authorization failed")
        || s.contains("could not read username")
        || s.contains("could not read password")
        || s.contains("403")
        || s.contains("401")
}

impl GitCredentials {
    /// The stored credential for `key` (`scheme://host`).
    pub fn credential(&self, key: &str) -> Option<GitCredential> {
        let raw = self.saved.get(key)?;
        let (user, secret) = raw.split_once('\n')?;
        Some(GitCredential { user: user.to_owned(), secret: secret.to_owned() })
    }

    /// What to do with a git HTTPS `prompt`: answer it from the store or show
    /// the dialog (`PromptNew` still records `key` as "in play").
    /// `None`: not a git HTTPS credential prompt.
    pub fn lookup(&self, prompt: &str) -> Option<GitAnswer> {
        let key = prompt_key(prompt)?;
        let wants_user = prompt.to_ascii_lowercase().starts_with("username");
        match self.credential(&key) {
            Some(c) => {
                // The password prompt carries the user name git will send: a
                // mismatch means the stored entry belongs to another account.
                let answer = if wants_user {
                    Some(c.user)
                } else {
                    prompt_user(prompt).is_none_or(|u| u == c.user).then_some(c.secret)
                };
                Some(answer.map_or(GitAnswer::PromptNew, GitAnswer::Auto))
            }
            None => Some(GitAnswer::PromptNew),
        }
    }

    /// The stored answer to `prompt`; `None` falls through to the UI prompt.
    /// Only a consumed *password* marks `key` as used — a stored user name
    /// alone proves nothing about the credential's validity.
    pub fn answer_saved(&self, prompt: &str) -> Option<String> {
        match self.lookup(prompt)? {
            GitAnswer::Auto(a) => {
                let password = !prompt.to_ascii_lowercase().starts_with("username");
                if password && let Some(key) = prompt_key(prompt) {
                    self.session.lock().used.insert(key);
                }
                Some(a)
            }
            GitAnswer::PromptNew => None,
        }
    }

    /// The user's `answer` to `prompt`, remembered when the current git command
    /// succeeds (`remember` = the dialog's "Remember" checkbox). Records the
    /// key only for pending saves: a re-typed answer does not consume the
    /// stored credential, so an auth failure must not delete it.
    pub fn answered(&self, prompt: &str, answer: &str, remember: bool) {
        if !remember {
            return;
        }
        let Some(key) = prompt_key(prompt) else { return };
        let mut s = self.session.lock();
        let wants_user = prompt.to_ascii_lowercase().starts_with("username");
        let entry = s.pending.entry(key).or_insert(GitCredential { user: String::new(), secret: String::new() });
        if wants_user {
            entry.user = answer.to_owned();
        } else {
            entry.secret = answer.to_owned();
            // The password prompt carries the user name git will send.
            if entry.user.is_empty()
                && let Some(u) = prompt_user(prompt)
            {
                entry.user = u;
            }
        }
    }

    /// Called when a git child process exits: on success, writes the remembered
    /// credentials and marks used ones as verified; on an authentication
    /// failure, forgets every credential the command consumed so the next run
    /// asks again instead of looping on a wrong password.
    pub fn command_finished(&self, success: bool, stderr: &str) {
        let session = std::mem::take(&mut *self.session.lock());
        if success {
            for (key, c) in session.pending {
                if c.secret.is_empty() {
                    continue; // a lone user name is not a credential
                }
                if let Err(e) = self.saved.set(&key, &format!("{}\n{}", c.user, c.secret)) {
                    tracing::warn!("git credentials: {}", e.message);
                }
            }
        } else if is_auth_failure(stderr) {
            // `used` holds exactly the keys whose stored password was sent.
            for key in session.used {
                self.saved.delete(&key);
            }
        }
    }

    /// Settings › Git: `scheme://host` entries with a saved credential.
    pub fn list(&self) -> Vec<String> {
        self.saved.keys()
    }

    /// Forgets the credential of `key` (Settings › Git › Clear, or a remote edit).
    pub fn forget(&self, key: &str) {
        self.saved.delete(key);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn store() -> (tempfile::TempDir, GitCredentials) {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("git-credentials.json");
        (tmp, GitCredentials { saved: Arc::new(SecretFile::new(path)), session: Arc::default() })
    }

    #[test]
    fn parses_https_prompts() {
        assert_eq!(prompt_key("Username for 'https://github.com': ").as_deref(), Some("https://github.com"));
        assert_eq!(prompt_key("Password for 'https://user@github.com': ").as_deref(), Some("https://github.com"));
        assert_eq!(
            prompt_key("Password for 'https://user%40mail.com@example.com:8443/x': ").as_deref(),
            Some("https://example.com")
        );
        assert_eq!(prompt_key("git@github.com's password: "), None);
        assert_eq!(prompt_key("Enter passphrase for key '/u/.ssh/id_ed25519': "), None);
    }

    #[test]
    fn saves_only_after_success_and_answers_silently() {
        let (_t, c) = store();
        // First run: prompts the user, who checks "remember".
        assert_eq!(c.lookup("Username for 'https://github.com': "), Some(GitAnswer::PromptNew));
        c.answered("Username for 'https://github.com': ", "me", true);
        c.answered("Password for 'https://me@github.com': ", "secret", true);
        // A failure before the password is verified saves nothing.
        c.command_finished(false, "fatal: some other error");
        assert_eq!(c.lookup("Username for 'https://github.com': "), Some(GitAnswer::PromptNew));

        c.answered("Username for 'https://github.com': ", "me", true);
        c.answered("Password for 'https://me@github.com': ", "secret", true);
        c.command_finished(true, "");
        // Second run: no prompts at all.
        assert_eq!(c.lookup("Username for 'https://github.com': "), Some(GitAnswer::Auto("me".into())));
        assert_eq!(c.lookup("Password for 'https://me@github.com': "), Some(GitAnswer::Auto("secret".into())));
    }

    #[test]
    fn forgets_a_rejected_credential() {
        let (_t, c) = store();
        c.answered("Username for 'https://github.com': ", "me", true);
        c.answered("Password for 'https://me@github.com': ", "wrong", true);
        c.command_finished(true, "");
        // The next command consumes the stored credential silently.
        assert_eq!(c.answer_saved("Username for 'https://github.com': ").as_deref(), Some("me"));
        assert_eq!(c.answer_saved("Password for 'https://me@github.com': ").as_deref(), Some("wrong"));
        c.command_finished(
            false,
            "remote: Invalid username or password.\nfatal: Authentication failed for 'https://github.com/x.git/'",
        );
        assert_eq!(c.lookup("Username for 'https://github.com': "), Some(GitAnswer::PromptNew));
    }

    #[test]
    fn lists_and_forgets() {
        let (_t, c) = store();
        c.answered("Username for 'https://a.example.com': ", "u", true);
        c.answered("Password for 'https://u@a.example.com': ", "p", true);
        c.answered("Username for 'https://b.example.com': ", "u", true);
        c.answered("Password for 'https://u@b.example.com': ", "p", true);
        c.command_finished(true, "");
        assert_eq!(c.list(), vec!["https://a.example.com", "https://b.example.com"]);
        c.forget("https://a.example.com");
        assert_eq!(c.list(), vec!["https://b.example.com"]);
    }
}
