//! All app secrets in ONE keychain item, read once per launch and kept in memory.
//!
//! macOS asks for permission per keychain item and per read unless the user picks
//! "Always Allow". Storing every secret (GitHub token, sync keys, AI keys…) as its
//! own item, read on every API call, meant repeated prompts. Now there is at most
//! one prompt per launch. Older builds' separate items are moved in once.

use std::collections::BTreeMap;
use std::sync::Mutex;

const SERVICE: &str = "dev.nonlinear.app";
const VAULT: &str = "nonlinear-secrets-v1";
/// Items written by builds before the single-item vault.
const LEGACY: &[&str] = &[
    "github-token", "github-pat-fallback", "sync-key", "sync-session", "sync-cursor", "nonlinear-selftest",
    "ai-key:openai", "ai-key:anthropic", "ai-key:gemini", "ai-key:openrouter", "ai-key:ollama", "ai-key:claude-code", "ai-key:codex-cli",
];

type Map = BTreeMap<String, String>;

struct State {
    secrets: Option<Map>,
    /// a read that failed (e.g. the user clicked Deny) is not retried this launch
    failed: Option<String>,
}

static STATE: Mutex<State> = Mutex::new(State { secrets: None, failed: None });

fn entry(name: &str) -> Result<keyring::Entry, String> {
    keyring::Entry::new(SERVICE, name).map_err(|e| e.to_string())
}

fn save(map: &Map) -> Result<(), String> {
    let e = entry(VAULT)?;
    if map.is_empty() {
        return match e.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(x) => Err(x.to_string()),
        };
    }
    e.set_password(&serde_json::to_string(map).map_err(|x| x.to_string())?).map_err(|x| x.to_string())
}

fn migrate_legacy() -> Result<Map, String> {
    let mut map = Map::new();
    for key in LEGACY {
        if let Ok(v) = entry(key)?.get_password() {
            map.insert((*key).to_string(), v);
        }
    }
    if !map.is_empty() {
        save(&map)?;
        for key in map.keys() {
            if let Ok(e) = entry(key) {
                let _ = e.delete_credential();
            }
        }
    }
    Ok(map)
}

fn loaded(state: &mut State) -> Result<&mut Map, String> {
    if let Some(err) = &state.failed {
        return Err(err.clone());
    }
    if state.secrets.is_none() {
        let read = match entry(VAULT)?.get_password() {
            Ok(json) => Ok(serde_json::from_str::<Map>(&json).unwrap_or_default()),
            Err(keyring::Error::NoEntry) => migrate_legacy(),
            Err(x) => Err(x.to_string()),
        };
        match read {
            Ok(map) => state.secrets = Some(map),
            Err(err) => {
                state.failed = Some(format!("Keychain access was not allowed ({err}). Restart the app to try again."));
                return Err(state.failed.clone().unwrap());
            }
        }
    }
    Ok(state.secrets.as_mut().unwrap())
}

pub fn get(key: &str) -> Result<Option<String>, String> {
    let mut state = STATE.lock().map_err(|e| e.to_string())?;
    Ok(loaded(&mut state)?.get(key).cloned())
}

pub fn set(key: &str, value: Option<String>) -> Result<(), String> {
    let mut state = STATE.lock().map_err(|e| e.to_string())?;
    let map = loaded(&mut state)?;
    let changed = match value {
        Some(v) => map.insert(key.to_string(), v.clone()).as_deref() != Some(v.as_str()),
        None => map.remove(key).is_some(),
    };
    if changed {
        let snapshot = map.clone();
        save(&snapshot)?;
    }
    Ok(())
}
