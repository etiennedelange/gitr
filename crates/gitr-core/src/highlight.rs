//! Syntax colours for diff lines. Each side of a diff is coloured from its whole file (the old
//! file for removed lines, the new one for added and unchanged lines), so a line inside a
//! multi-line comment or string is coloured as part of it. A line whose file text doesn't match
//! the diff (no file to read, a filter, a conflict) is coloured from its hunk alone instead.
//!
//! The grammars are bat's (through two-face) on syntect, with pure-Rust regexes.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::sync::OnceLock;
use std::time::Instant;

use serde::Serialize;
use syntect::parsing::{ParseState, Scope, ScopeStack, SyntaxReference, SyntaxSet};

use crate::diff::{FileDiff, LineKind};

/// A file larger than this is not read for colouring; its lines are coloured from their hunks.
pub const MAX_SOURCE_BYTES: u64 = 2 * 1024 * 1024;
/// Colouring stops at a longer line (minified code), which alone could take seconds.
const MAX_LINE_BYTES: usize = 4096;

/// What a piece of code is. The UI gives each its own colour; anything else stays plain.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Token {
    Keyword,
    Type,
    Function,
    String,
    Number,
    Comment,
    Tag,
    Attribute,
    Meta,
}

/// `[start, end, token]` in UTF-16 code units of the line's text (JavaScript string indices).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct Span(pub u32, pub u32, pub Token);

/// Spans by line number: `old` for removed lines, `new` for added and unchanged lines. Lines with
/// nothing to colour are left out.
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
pub struct DiffSyntax {
    pub old: BTreeMap<u32, Vec<Span>>,
    pub new: BTreeMap<u32, Vec<Span>>,
}

fn syntaxes() -> &'static SyntaxSet {
    static SET: OnceLock<SyntaxSet> = OnceLock::new();
    SET.get_or_init(two_face::syntax::extra_newlines)
}

/// The grammar for `path`: by file name (`Dockerfile`, `Cargo.lock`), then extension, then a
/// first line such as `#!/bin/sh`. None for plain text.
pub fn syntax_for(path: &str, first_line: Option<&str>) -> Option<&'static SyntaxReference> {
    let set = syntaxes();
    let name = path.rsplit('/').next().unwrap_or(path);
    set.find_syntax_by_extension(name)
        .or_else(|| name.rsplit_once('.').and_then(|(_, ext)| set.find_syntax_by_extension(ext)))
        .or_else(|| first_line.and_then(|l| set.find_syntax_by_first_line(l)))
        .filter(|s| s.name != "Plain Text")
}

/// Whether colouring needs the old file (there are removed lines) and the new one (added or
/// unchanged lines).
pub fn sides_needed(diff: &FileDiff) -> (bool, bool) {
    let lines = || diff.hunks.iter().flat_map(|h| &h.lines);
    (lines().any(|l| l.kind == LineKind::Remove), lines().any(|l| matches!(l.kind, LineKind::Add | LineKind::Context)))
}

/// Colours `diff`'s lines, reading `old` and `new` (the whole files, when known). Stops at
/// `deadline`, leaving the remaining lines plain.
pub fn highlight_diff(path: &str, diff: &FileDiff, old: Option<&str>, new: Option<&str>, deadline: Instant) -> DiffSyntax {
    let first_line = new.or(old).and_then(|s| s.lines().next());
    let Some(syntax) = syntax_for(path, first_line) else {
        return DiffSyntax::default();
    };
    // Each side's lines per hunk, in order, marked when the diff shows them from that side.
    let (mut old_side, mut new_side) = (Vec::new(), Vec::new());
    for h in &diff.hunks {
        let (mut o, mut n) = (Vec::new(), Vec::new());
        for l in &h.lines {
            if let Some(no) = l.old_no {
                o.push((no, l.text.as_str(), l.kind == LineKind::Remove));
            }
            if let Some(no) = l.new_no {
                n.push((no, l.text.as_str(), l.kind != LineKind::Remove));
            }
        }
        old_side.push(o);
        new_side.push(n);
    }
    DiffSyntax {
        old: colour_side(syntax, old, &old_side, deadline),
        new: colour_side(syntax, new, &new_side, deadline),
    }
}

type SideLine<'a> = (u32, &'a str, bool);

fn colour_side(syntax: &SyntaxReference, source: Option<&str>, hunks: &[Vec<SideLine>], deadline: Instant) -> BTreeMap<u32, Vec<Span>> {
    let mut out = BTreeMap::new();
    let wanted: HashMap<u32, &str> = hunks.iter().flatten().filter(|l| l.2).map(|&(no, text, _)| (no, text)).collect();
    let Some(&last) = wanted.keys().max() else {
        return out;
    };
    // Lines coloured from the file, whose text matched the diff's.
    let mut done = HashSet::new();
    if let Some(source) = source {
        let mut h = Highlighter::new(syntax);
        for (i, text) in source.lines().enumerate().take(last as usize) {
            if Instant::now() > deadline {
                return out;
            }
            let Some(spans) = h.line(text) else { break };
            let no = i as u32 + 1;
            if wanted.get(&no) == Some(&text) {
                done.insert(no);
                if !spans.is_empty() {
                    out.insert(no, spans);
                }
            }
        }
    }
    for hunk in hunks.iter().filter(|h| h.iter().any(|(no, _, w)| *w && !done.contains(no))) {
        let mut h = Highlighter::new(syntax);
        for &(no, text, w) in hunk {
            if Instant::now() > deadline {
                return out;
            }
            let Some(spans) = h.line(text) else { break };
            if w && !done.contains(&no) && !spans.is_empty() {
                out.insert(no, spans);
            }
        }
    }
    out
}

struct Highlighter {
    state: ParseState,
    stack: ScopeStack,
}

impl Highlighter {
    fn new(syntax: &SyntaxReference) -> Self {
        Self { state: ParseState::new(syntax), stack: ScopeStack::new() }
    }

    /// The spans of the next line. None when the line is too long or the grammar fails on it;
    /// the state is lost then, so the caller stops.
    fn line(&mut self, text: &str) -> Option<Vec<Span>> {
        if text.len() > MAX_LINE_BYTES {
            return None;
        }
        // The grammars are the "newlines" kind: each line ends with its newline.
        let ops = self.state.parse_line(&format!("{text}\n"), syntaxes()).ok()?;
        let mut spans = Spans { text, at: 0, out: Vec::new() };
        let mut pos = 0;
        for (i, op) in ops {
            let i = i.min(text.len());
            if i > pos {
                spans.push(pos, i, token_of(self.stack.as_slice(), &text[pos..i]));
                pos = i;
            }
            self.stack.apply(&op).ok()?;
        }
        if pos < text.len() {
            spans.push(pos, text.len(), token_of(self.stack.as_slice(), &text[pos..]));
        }
        Some(spans.out)
    }
}

/// Builds a line's spans from consecutive byte ranges, merging neighbours of the same token.
struct Spans<'a> {
    text: &'a str,
    /// UTF-16 offset of the next range.
    at: u32,
    out: Vec<Span>,
}

impl Spans<'_> {
    fn push(&mut self, from: usize, to: usize, token: Option<Token>) {
        let start = self.at;
        self.at += self.text[from..to].encode_utf16().count() as u32;
        let Some(token) = token else { return };
        match self.out.last_mut() {
            Some(last) if last.1 == start && last.2 == token => last.1 = self.at,
            _ => self.out.push(Span(start, self.at, token)),
        }
    }
}

#[derive(Clone, Copy)]
enum Rule {
    Is(Token),
    /// A keyword when it is a word (`class`, `new`, `is`); symbols (`=>`, `+`, `::`) stay plain.
    Word,
    /// Code inside a string or another language (an interpolation, a script in HTML): its own
    /// scopes decide, never the string's.
    Stop,
}

/// TextMate scope prefixes to tokens. A piece's innermost scope that matches a prefix decides;
/// the first matching prefix in this list wins.
const RULES: &[(&str, Rule)] = &[
    ("source", Rule::Stop),
    ("meta.embedded", Rule::Stop),
    ("meta.interpolation", Rule::Stop),
    ("comment", Rule::Is(Token::Comment)),
    ("constant.character.escape", Rule::Is(Token::String)),
    ("string", Rule::Is(Token::String)),
    ("markup.raw", Rule::Is(Token::String)),
    ("constant", Rule::Is(Token::Number)),
    ("support.constant", Rule::Is(Token::Number)),
    ("keyword", Rule::Word),
    ("storage", Rule::Word),
    ("variable.language", Rule::Is(Token::Keyword)),
    ("markup.heading", Rule::Is(Token::Keyword)),
    ("entity.name.function", Rule::Is(Token::Function)),
    ("support.function", Rule::Is(Token::Function)),
    ("support.macro", Rule::Is(Token::Function)),
    ("variable.function", Rule::Is(Token::Function)),
    ("entity.name.tag", Rule::Is(Token::Tag)),
    ("entity.other.attribute-name", Rule::Is(Token::Attribute)),
    ("entity.name", Rule::Is(Token::Type)),
    ("entity.other.inherited-class", Rule::Is(Token::Type)),
    ("support.type", Rule::Is(Token::Type)),
    ("support.class", Rule::Is(Token::Type)),
    ("meta.annotation", Rule::Is(Token::Meta)),
    ("variable.annotation", Rule::Is(Token::Meta)),
    ("meta.preprocessor", Rule::Is(Token::Meta)),
];

fn rules() -> &'static [(Scope, Rule)] {
    static PARSED: OnceLock<Vec<(Scope, Rule)>> = OnceLock::new();
    PARSED.get_or_init(|| RULES.iter().map(|&(s, r)| (Scope::new(s).expect("valid scope"), r)).collect())
}

fn token_of(stack: &[Scope], text: &str) -> Option<Token> {
    for scope in stack.iter().rev() {
        if let Some((_, rule)) = rules().iter().find(|(prefix, _)| prefix.is_prefix_of(*scope)) {
            return match rule {
                Rule::Is(t) => Some(*t),
                Rule::Word => text.starts_with(char::is_alphabetic).then_some(Token::Keyword),
                Rule::Stop => None,
            };
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::diff::parse_unified;
    use std::time::Duration;

    fn later() -> Instant {
        Instant::now() + Duration::from_secs(30)
    }

    /// The token covering `word` in `text`, given that line's spans.
    fn token_at(text: &str, spans: &[Span], word: &str) -> Option<Token> {
        let start = text[..text.find(word).expect("word in line")].encode_utf16().count() as u32;
        spans.iter().find(|s| s.0 <= start && start < s.1).map(|s| s.2)
    }

    const CS: &str = concat!(
        "using System;\n",
        "/* Builds invoices.\n",
        "   int count = 0; */\n",
        "public sealed class InvoiceExporter : IExporter\n",
        "{\n",
        "    public string Name => $\"Export {Count}\";\n",
        "    // done\n",
        "}\n",
    );

    #[test]
    fn colours_csharp_keywords_types_strings_and_comments() {
        let diff = parse_unified("@@ -0,0 +1,8 @@\n+using System;\n+/* Builds invoices.\n+   int count = 0; */\n+public sealed class InvoiceExporter : IExporter\n+{\n+    public string Name => $\"Export {Count}\";\n+    // done\n+}\n");
        let s = highlight_diff("src/InvoiceExporter.cs", &diff, None, Some(CS), later());
        let line = |no: u32| (CS.lines().nth(no as usize - 1).unwrap(), s.new.get(&no).cloned().unwrap_or_default());
        let (text, spans) = line(4);
        assert_eq!(token_at(text, &spans, "public"), Some(Token::Keyword));
        assert_eq!(token_at(text, &spans, "class"), Some(Token::Keyword));
        assert_eq!(token_at(text, &spans, "InvoiceExporter"), Some(Token::Type));
        assert_eq!(token_at(text, &spans, "IExporter"), Some(Token::Type));
        let (text, spans) = line(6);
        assert_eq!(token_at(text, &spans, "\"Export"), Some(Token::String));
        // Code inside an interpolation is not coloured as the string around it.
        assert_ne!(token_at(text, &spans, "Count}"), Some(Token::String));
        assert_eq!(token_at(text, &spans, "=>"), None, "a symbol is not a keyword");
        let (text, spans) = line(7);
        assert_eq!(token_at(text, &spans, "// done"), Some(Token::Comment));
        assert!(s.old.is_empty());
    }

    /// A hunk that starts inside a block comment: only the whole file shows that the line is
    /// comment. Colouring the hunk alone would show `int` as a keyword.
    #[test]
    fn a_line_inside_a_multi_line_comment_is_coloured_from_the_whole_file() {
        let changed = CS.replace("int count = 0; */", "int total = 0; */");
        let diff = parse_unified("@@ -3,2 +3,2 @@\n-   int count = 0; */\n+   int total = 0; */\n public sealed class InvoiceExporter : IExporter\n");
        let s = highlight_diff("a.cs", &diff, Some(CS), Some(&changed), later());
        assert_eq!(s.old[&3], vec![Span(0, 20, Token::Comment)]);
        assert_eq!(s.new[&3], vec![Span(0, 20, Token::Comment)]);
        // Without the files, the hunk alone is all there is.
        let alone = highlight_diff("a.cs", &diff, None, None, later());
        assert_eq!(token_at("   int total = 0; */", &alone.new[&3], "int"), Some(Token::Keyword));
    }

    #[test]
    fn a_line_that_differs_from_the_file_is_coloured_from_its_hunk() {
        let diff = parse_unified("@@ -1,1 +1,1 @@\n-var a = 1;\n+var b = \"x\";\n");
        // The "file" doesn't hold the diff's text (as when a filter changed it).
        let s = highlight_diff("a.cs", &diff, Some("/* other\n"), Some("/* other\n"), later());
        assert_eq!(token_at("var b = \"x\";", &s.new[&1], "\"x\""), Some(Token::String));
        assert_eq!(token_at("var a = 1;", &s.old[&1], "1"), Some(Token::Number));
    }

    #[test]
    fn offsets_are_utf16_code_units() {
        let text = "var s = \"é 🦀\"; // ok";
        let diff = parse_unified(&format!("@@ -0,0 +1 @@\n+{text}\n"));
        let s = highlight_diff("a.cs", &diff, None, Some(&format!("{text}\n")), later());
        let comment = s.new[&1].iter().find(|s| s.2 == Token::Comment).unwrap();
        // é is one unit, the crab two: the comment starts at JavaScript index 16.
        assert_eq!((comment.0, comment.1), (16, 21));
        assert_eq!(text.encode_utf16().count(), 21);
    }

    #[test]
    fn finds_grammars_by_name_extension_and_first_line() {
        assert_eq!(syntax_for("src/a.cs", None).unwrap().name, "C#");
        assert_eq!(syntax_for("ui/App.tsx", None).unwrap().name, "TypeScriptReact");
        assert_eq!(syntax_for("Cargo.lock", None).unwrap().name, "TOML");
        assert_eq!(syntax_for("bin/run", Some("#!/bin/bash")).unwrap().name, "Bourne Again Shell (bash)");
        assert!(syntax_for("notes.txt", None).is_none());
        assert!(syntax_for("LICENSE", None).is_none());
    }

    #[test]
    fn plain_text_and_past_deadline_colour_nothing() {
        let diff = parse_unified("@@ -0,0 +1 @@\n+public class A {}\n");
        assert_eq!(highlight_diff("a.txt", &diff, None, None, later()), DiffSyntax::default());
        let past = Instant::now() - Duration::from_millis(1);
        assert_eq!(highlight_diff("a.cs", &diff, None, None, past), DiffSyntax::default());
    }

    #[test]
    fn serializes_spans_as_arrays() {
        let mut s = DiffSyntax::default();
        s.new.insert(3, vec![Span(0, 6, Token::Keyword)]);
        assert_eq!(serde_json::to_string(&s).unwrap(), r#"{"old":{},"new":{"3":[[0,6,"keyword"]]}}"#);
    }
}
