mod common;

use common::*;
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

#[tokio::test]
async fn colouring_reuses_the_diff_just_shown_and_reads_both_files_with_two_processes() {
    let (_t, dir) = repo_with_commit();
    write(&dir, "Orders.cs", &source("count"));
    git(&dir, &["add", "Orders.cs"]);
    git(&dir, &["commit", "-q", "-m", "orders"]);
    write(&dir, "Orders.cs", &source("total"));
    git(&dir, &["add", "Orders.cs"]);
    let sha = git_out(&dir, &["rev-parse", "HEAD"]).trim().to_string();
    let g = isolated_git();

    // Staged: HEAD and the index are both blobs.
    let log = LogCapture::start();
    g.diff_file(&dir, "Orders.cs", true, false).await.unwrap();
    let s = g.diff_file_syntax(&dir, "Orders.cs", true, false).await.unwrap();
    assert_eq!(line(&s, true, 4), comment("count"), "{s:?}");
    assert_eq!(line(&s, false, 4), comment("total"), "{s:?}");
    assert_eq!(log.git_lines("diff").len(), 1, "{}", log.text());
    assert_eq!(log.git_lines("cat-file").len(), 2, "{}", log.text());
    drop(log);

    // A commit: its parent is remembered with the diff.
    let log = LogCapture::start();
    g.commit_file_diff(&dir, &sha, "Orders.cs", None).await.unwrap();
    let s = g.commit_file_diff_syntax(&dir, &sha, "Orders.cs", None).await.unwrap();
    assert_eq!(line(&s, false, 4), comment("count"), "{s:?}");
    assert_eq!(log.git_lines("rev-list").len(), 1, "{}", log.text());
    assert_eq!(log.git_lines("diff-tree").len(), 1, "{}", log.text());
    assert_eq!(log.git_lines("cat-file").len(), 2, "{}", log.text());
    drop(log);

    // Taken once: a second colouring runs the diff itself.
    let log = LogCapture::start();
    g.diff_file_syntax(&dir, "Orders.cs", true, false).await.unwrap();
    assert_eq!(log.git_lines("diff").len(), 1, "{}", log.text());
}

#[tokio::test]
async fn a_new_file_is_coloured_when_one_side_is_missing() {
    let (_t, dir) = repo_with_commit();
    write(&dir, "New.cs", &source("n"));
    git(&dir, &["add", "New.cs"]);
    // HEAD:New.cs is missing and :0:New.cs is not, in the same cat-file call.
    let s = isolated_git().diff_file_syntax(&dir, "New.cs", true, false).await.unwrap();
    assert_eq!(line(&s, false, 4), comment("n"), "{s:?}");
    assert!(s.old.is_empty());
}

#[tokio::test]
async fn colours_follow_the_diff_shown_until_the_repository_changes() {
    let (_t, dir) = repo_with_commit();
    write(&dir, "Orders.cs", &source("count"));
    git(&dir, &["add", "Orders.cs"]);
    git(&dir, &["commit", "-q", "-m", "orders"]);
    let g = isolated_git();

    // The file changes after its diff was shown, but before the change is noticed: the colours
    // are still for the diff on screen (line 4 changed, not line 5).
    write(&dir, "Orders.cs", &source("total"));
    g.diff_file(&dir, "Orders.cs", false, false).await.unwrap();
    write(&dir, "Orders.cs", &format!("// moved\n{}", source("total")));
    let s = g.diff_file_syntax(&dir, "Orders.cs", false, false).await.unwrap();
    assert_eq!(line(&s, true, 4), comment("count"), "{s:?}");

    // Once noticed, the remembered diff is dropped and the new one is coloured.
    g.diff_file(&dir, "Orders.cs", false, false).await.unwrap();
    g.forget_diffs(&dir);
    let s = g.diff_file_syntax(&dir, "Orders.cs", false, false).await.unwrap();
    assert_eq!(line(&s, false, 5), comment("total"), "{s:?}");
    assert_eq!(line(&s, false, 1), vec![Span(0, 8, Token::Comment)], "{s:?}");
}
