//! Dictation post-processing: spoken snippets and custom vocabulary.
//!
//! Runs on every transcript before it is handed to the LLM cleanup step (or
//! straight to the clipboard on the free tier).
//!
//! Matching is whole-word based, where "word" means Unicode alphanumerics or
//! underscore. A hand-rolled matcher is used instead of regex so triggers
//! ending in punctuation (`c++`) still match, and so there is no regex
//! dependency in the hot path.

use serde::{Deserialize, Serialize};

/// Spoken phrase → literal replacement (e.g. "new line" → "\n").
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Snippet {
    pub id: String,
    /// What the user says.
    pub trigger: String,
    /// What gets typed instead.
    pub replacement: String,
}

/// Spoken form → preferred written form (e.g. "pay pee ar" → "PR").
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct VocabEntry {
    pub spoken: String,
    pub written: String,
}

fn is_word_char(c: char) -> bool {
    c.is_alphanumeric() || c == '_'
}

/// Does `hay` start with `needle`, optionally folding ASCII case?
/// Returns the matched byte length when it does.
fn match_len(hay: &str, needle: &str, case_insensitive: bool) -> Option<usize> {
    if needle.is_empty() || hay.len() < needle.len() {
        return None;
    }
    let h = hay.as_bytes();
    let n = needle.as_bytes();
    for (i, &b) in n.iter().enumerate() {
        let hb = h[i];
        if hb == b {
            continue;
        }
        if case_insensitive
            && hb.is_ascii_alphanumeric()
            && b.is_ascii_alphanumeric()
            && hb.eq_ignore_ascii_case(&b)
        {
            continue;
        }
        return None;
    }
    Some(needle.len())
}

/// May a match of `needle` be followed by `after`?
///
/// A match followed by a word character is always a partial-word hit. A match
/// followed by punctuation is a partial hit too when the trigger is itself a
/// plain word: "c" must not fire inside "c++". Punctuation-terminated triggers
/// opt out of that rule, which is what makes "c++" itself matchable.
fn boundary_after_ok(needle: &str, after: Option<char>) -> bool {
    match after {
        None => true,
        Some(c) if is_word_char(c) => false,
        Some(c) if c.is_whitespace() => true,
        Some(_) => !needle.chars().all(is_word_char),
    }
}

/// Replace whole-word occurrences of `needle` in `hay`.
fn replace_words(hay: &str, needle: &str, replacement: &str, case_insensitive: bool) -> String {
    let needle = needle.trim();
    if needle.is_empty() {
        return hay.to_string();
    }
    let mut out = String::with_capacity(hay.len());
    let mut rest = hay;
    'outer: while !rest.is_empty() {
        let mut search_from = 0;
        while search_from < rest.len() {
            let tail = &rest[search_from..];
            let Some(len) = match_len(tail, needle, case_insensitive) else {
                // Advance to the next char boundary.
                let step = rest[search_from..]
                    .chars()
                    .next()
                    .map(|c| c.len_utf8())
                    .unwrap_or(1);
                search_from += step;
                continue;
            };
            let start = search_from;
            let end = start + len;
            let before = rest[..start].chars().last();
            let after = rest[end..].chars().next();
            let boundary_ok = !before.is_some_and(is_word_char) && boundary_after_ok(needle, after);
            if boundary_ok {
                out.push_str(&rest[..start]);
                out.push_str(replacement);
                rest = &rest[end..];
                continue 'outer;
            }
            let step = rest[start..]
                .chars()
                .next()
                .map(|c| c.len_utf8())
                .unwrap_or(1);
            search_from += step;
        }
        // No further match: emit the remainder verbatim.
        out.push_str(rest);
        break;
    }
    out
}

/// Replace whole-word snippet triggers (case-insensitive).
pub fn apply_snippets(text: &str, snippets: &[Snippet]) -> String {
    let mut out = text.to_string();
    for s in snippets {
        out = replace_words(&out, &s.trigger, &s.replacement, true);
    }
    out
}

/// Replace whole-word vocabulary entries (case-sensitive spoken form).
pub fn apply_vocabulary(text: &str, vocab: &[VocabEntry]) -> String {
    let mut out = text.to_string();
    for v in vocab {
        out = replace_words(&out, &v.spoken, &v.written, false);
    }
    out
}

/// Sentence-final punctuation belongs to the word before it: "uri ." → "uri.".
/// Only the tail of the text is touched, so mid-sentence replacements keep the
/// space that makes them readable (`"hello \n world : 42"`).
fn join_trailing_punctuation(text: &str) -> String {
    let trimmed = text.trim_end();
    let Some(last) = trimmed.chars().next_back() else {
        return String::new();
    };
    if !matches!(last, '.' | ',' | ';' | ':' | '!' | '?') {
        return trimmed.to_string();
    }
    let head = trimmed[..trimmed.len() - last.len_utf8()].trim_end();
    if head.is_empty() {
        return trimmed.to_string();
    }
    let mut out = String::with_capacity(trimmed.len());
    out.push_str(head);
    out.push(last);
    out
}

/// Full cleanup pass applied to a raw transcript.
pub fn postprocess(text: &str, snippets: &[Snippet], vocab: &[VocabEntry]) -> String {
    join_trailing_punctuation(apply_vocabulary(&apply_snippets(text, snippets), vocab).trim())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn snip(trigger: &str, replacement: &str) -> Snippet {
        Snippet {
            id: trigger.into(),
            trigger: trigger.into(),
            replacement: replacement.into(),
        }
    }

    #[test]
    fn snippets_replace_whole_words_only() {
        let snippets = vec![snip("new line", "\n"), snip("colon", ":")];
        assert_eq!(
            apply_snippets("hello new line world colon 42", &snippets),
            "hello \n world : 42"
        );
        // No partial-word hits.
        assert_eq!(
            apply_snippets("newline is new lines", &snippets),
            "newline is new lines"
        );
    }

    #[test]
    fn snippets_are_case_insensitive() {
        let snippets = vec![snip("newline", "\n")];
        assert_eq!(apply_snippets("NewLine again", &snippets), "\n again");
        // Mixed-case trigger also matches lowercase text.
        let snippets = vec![snip("NEW LINE", "\n")];
        assert_eq!(apply_snippets("a new line b", &snippets), "a \n b");
    }

    #[test]
    fn empty_and_blank_triggers_are_ignored() {
        let snippets = vec![snip("", "X"), snip("  ", "Y")];
        assert_eq!(apply_snippets("keep as is", &snippets), "keep as is");
    }

    #[test]
    fn punctuation_terminated_triggers_match() {
        // `c++` ends in non-word chars: a plain trailing \b would fail here.
        let snippets = vec![snip("c++", "C++")];
        assert_eq!(
            apply_snippets("I love c++ (really)", &snippets),
            "I love C++ (really)"
        );
        // But "c" alone must not match inside "c++".
        let snippets = vec![snip("c", "see")];
        assert_eq!(apply_snippets("c++ rocks", &snippets), "c++ rocks");
    }

    #[test]
    fn vocabulary_rewrites_spoken_forms() {
        let vocab = vec![
            VocabEntry {
                spoken: "pay pee ar".into(),
                written: "PR".into(),
            },
            VocabEntry {
                spoken: "github".into(),
                written: "GitHub".into(),
            },
        ];
        assert_eq!(
            apply_vocabulary("opened a pay pee ar on github today", &vocab),
            "opened a PR on GitHub today"
        );
        // Case-sensitive: existing "GitHub" is untouched.
        assert_eq!(apply_vocabulary("GitHub rocks", &vocab), "GitHub rocks");
    }

    #[test]
    fn non_ascii_text_survives() {
        let snippets = vec![snip("newline", "\n")];
        assert_eq!(
            apply_snippets("héllo newline wörld", &snippets),
            "héllo \n wörld"
        );
        let vocab = vec![VocabEntry {
            spoken: "café".into(),
            written: "cafe".into(),
        }];
        assert_eq!(apply_vocabulary("un café noir", &vocab), "un cafe noir");
    }

    #[test]
    fn postprocess_trims_and_composes() {
        let snippets = vec![snip("period", ".")];
        let vocab = vec![VocabEntry {
            spoken: "uri".into(),
            written: "URI".into(),
        }];
        assert_eq!(
            postprocess("  check the uri period ", &snippets, &vocab),
            "check the URI."
        );
    }

    #[test]
    fn repeated_occurrences_all_replaced() {
        let snippets = vec![snip("dot", ".")];
        assert_eq!(apply_snippets("dot a dot b dot", &snippets), ". a . b .");
    }
}
