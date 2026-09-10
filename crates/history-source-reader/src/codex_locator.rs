//! Shared Codex rollout locator rules.
//!
//! Both the request-parsing binary and the chain planner must agree on what a
//! valid rollout locator looks like, so the rules live here rather than being
//! duplicated. A locator is a repository-relative path shape only; recognizing
//! one grants no access and never rewrites a compressed name to a plain one.

pub fn session_id(value: &str) -> bool {
    value.len() == 36
        && value.bytes().enumerate().all(|(i, v)| {
            if [8, 13, 18, 23].contains(&i) {
                v == b'-'
            } else {
                v.is_ascii_hexdigit()
            }
        })
}

fn timestamp(value: &str) -> bool {
    let b = value.as_bytes();
    if b.len() != 19
        || b.iter().enumerate().any(|(i, v)| match i {
            4 | 7 | 13 | 16 => *v != b'-',
            10 => *v != b'T',
            _ => !v.is_ascii_digit(),
        })
    {
        return false;
    }
    let number = |s: &str| s.parse::<u32>().unwrap_or(u32::MAX);
    let year = number(&value[..4]);
    let leap = year % 4 == 0 && (year % 100 != 0 || year % 400 == 0);
    let days = match number(&value[5..7]) {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 => {
            if leap {
                29
            } else {
                28
            }
        }
        _ => return false,
    };
    (1..=days).contains(&number(&value[8..10]))
        && number(&value[11..13]) < 24
        && number(&value[14..16]) < 60
        && number(&value[17..19]) < 60
}

/// Native reverted rollouts retain the thread UUID but add a distinct rollout
/// UUID. A compressed locator is recognized, not silently changed to its plain
/// sibling.
fn parsed_ids(path: &str) -> Option<(&str, &str)> {
    if path.len() > 160 {
        return None;
    }
    let parts: Vec<_> = path.split('/').collect();
    let file = match parts.as_slice() {
        ["sessions", _, _, _, file] | ["archived_sessions", file] => *file,
        _ => return None,
    };
    let core = file
        .strip_suffix(".zst")
        .unwrap_or(file)
        .strip_prefix("rollout-")
        .and_then(|v| v.strip_suffix(".jsonl"))?;
    let time = core.get(..19)?;
    if !timestamp(time) || core.get(19..20) != Some("-") {
        return None;
    }
    let ids = &core[20..];
    let (id, rollout) = ids.split_once('_').unwrap_or((ids, ids));
    if !session_id(id)
        || id != id.to_ascii_lowercase()
        || !session_id(rollout)
        || rollout != rollout.to_ascii_lowercase()
    {
        return None;
    }
    if !(parts.len() == 2
        || (parts[1] == &time[..4] && parts[2] == &time[5..7] && parts[3] == &time[8..10]))
    {
        return None;
    }
    Some((id, rollout))
}

fn parsed_rollout_id<'a>(path: &'a str, thread: &str) -> Option<&'a str> {
    if !session_id(thread) || thread != thread.to_ascii_lowercase() {
        return None;
    }
    let (id, rollout) = parsed_ids(path)?;
    (id == thread).then_some(rollout)
}

/// Validate a repository-relative locator without granting access.
pub fn valid_locator(path: &str, thread: &str) -> bool {
    parsed_rollout_id(path, thread).is_some()
}

/// Return the physical rollout UUID encoded in a validated locator.
///
/// For a normal locator this is the thread UUID itself. A reverted locator
/// has the form `<stable-thread>_<physical-rollout>`, so callers that already
/// know the expected physical rollout can bind the filename to the metadata
/// claim instead of accepting any sibling with the same stable prefix.
pub fn physical_rollout_id(path: &str, thread: &str) -> Option<String> {
    parsed_rollout_id(path, thread).map(str::to_owned)
}

/// Return the stable thread UUID encoded before the optional `_` in a
/// locator. This is needed for an ancestor that was itself created by a
/// revert: its physical rollout UUID names the chain link, while the native
/// metadata still carries this stable prefix.
pub fn stable_thread_id(path: &str) -> Option<String> {
    parsed_ids(path).map(|(thread, _)| thread.to_owned())
}
