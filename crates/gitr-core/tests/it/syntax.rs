
use crate::common::*;
use gitr_core::highlight::{DiffSyntax, Span, Token};

/// A C# file whose fourth line is inside a block comment, so only colouring from the whole file
/// shows it as comment.
fn source(word: &str) -> String {
    format!("namespace Shop;\n/*\n  Orders.\n  int {word} = 0;\n*/\npublic class Orders\n{{\n}}\n")
}

/// The span of line 4 when it is coloured as comment.
fn comment(word: &str) -> Vec<Span> {
    vec![Span(0, format!("  int {word} = 0;").len() as u32, Token::Comment)]
}

fn line(s: &DiffSyntax, old: bool, no: u32) -> Vec<Span> {
    (if old { &s.old } else { &s.new }).get(&no).cloned().unwrap_or_default()
}

#[tokio::test]
async fn unstaged_staged_and_untracked_diffs_are_coloured_from_their_files() {
    let (_t, dir) = repo_with_commit();
    write(&dir, "Orders.cs", &source("count"));
    git(&dir, &["add", "Orders.cs"]);
    git(&dir, &["commit", "-q", "-m", "orders"]);
    let g = isolated_git();

    // Unstaged: the index against the working tree.
    write(&dir, "Orders.cs", &source("total"));
    let s = g.diff_file_syntax(&dir, "Orders.cs", false, false).await.unwrap();
    assert_eq!(line(&s, true, 4), comment("count"), "{s:?}");
    assert_eq!(line(&s, false, 4), comment("total"), "{s:?}");
    assert_eq!(line(&s, false, 6)[0], Span(0, 6, Token::Keyword), "unchanged lines are coloured too: {s:?}");

    // Staged: HEAD against the index, whatever the working tree holds now.
    git(&dir, &["add", "Orders.cs"]);
    write(&dir, "Orders.cs", "garbage\n");
    let s = g.diff_file_syntax(&dir, "Orders.cs", true, false).await.unwrap();
    assert_eq!(line(&s, true, 4), comment("count"), "{s:?}");
    assert_eq!(line(&s, false, 4), comment("total"), "{s:?}");

    // Untracked: the whole file is new.
    write(&dir, "New.cs", &source("n"));
    let s = g.diff_file_syntax(&dir, "New.cs", false, true).await.unwrap();
    assert_eq!(line(&s, false, 4), comment("n"), "{s:?}");
    assert!(s.old.is_empty());

    // A file with no grammar gets no colours.
    write(&dir, "notes.txt", "public class A\n");
    let s = g.diff_file_syntax(&dir, "notes.txt", false, true).await.unwrap();
    assert_eq!(s, DiffSyntax::default());
}

#[tokio::test]
async fn commit_diffs_are_coloured_from_the_parent_and_the_commit_across_a_rename() {
    let (_t, dir) = repo_with_commit();
    write(&dir, "Old.cs", &source("count"));
    git(&dir, &["add", "-A"]);
    git(&dir, &["commit", "-q", "-m", "add"]);
    git(&dir, &["mv", "Old.cs", "Orders.cs"]);
    write(&dir, "Orders.cs", &source("total"));
    git(&dir, &["add", "-A"]);
    git(&dir, &["commit", "-q", "-m", "rename"]);
    let sha = git_out(&dir, &["rev-parse", "HEAD"]).trim().to_string();

    let s = isolated_git().commit_file_diff_syntax(&dir, &sha, "Orders.cs", Some("Old.cs")).await.unwrap();
    assert_eq!(line(&s, true, 4), comment("count"), "{s:?}");
    assert_eq!(line(&s, false, 4), comment("total"), "{s:?}");
}
