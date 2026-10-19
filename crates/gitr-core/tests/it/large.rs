
use std::time::Instant;

use crate::common::*;

/// A repository with many changed files must stay responsive.
/// Run with `cargo test -p gitr-core --test it large:: -- --ignored --nocapture`.
#[tokio::test]
#[ignore = "slow: creates 20,000 files"]
async fn twenty_thousand_changed_files_stay_responsive() {
    let (_t, dir) = repo_with_commit();
    let g = isolated_git();
    for i in 0..20_000 {
        write(&dir, &format!("d{}/f{i}.txt", i % 200), &format!("line {i}\n"));
    }
    let timed = |label: &'static str, t: Instant| eprintln!("{label}: {:?}", t.elapsed());

    let t = Instant::now();
    let st = g.status(&dir).await.unwrap();
    timed("status", t);
    assert_eq!(st.unstaged_count(), 20_000);

    let t = Instant::now();
    g.stage_all(&dir).await.unwrap();
    timed("stage_all", t);

    let t = Instant::now();
    let lines = g.line_stats(&dir).await.unwrap();
    timed("line_stats", t);
    assert_eq!(lines.staged.len(), 20_000);

    let t = Instant::now();
    let d = g.diff_file(&dir, "d0/f0.txt", true, false).await.unwrap();
    timed("diff_file", t);
    assert!(!d.hunks.is_empty());

    let t = Instant::now();
    let paths: Vec<String> = (0..20_000).step_by(2).map(|i| format!("d{}/f{i}.txt", i % 200)).collect();
    g.unstage(&dir, &paths).await.unwrap();
    timed("unstage 10,000 paths", t);
    assert_eq!(g.status(&dir).await.unwrap().staged_count(), 10_000);

    let t = Instant::now();
    g.stage_all(&dir).await.unwrap();
    g.commit(&dir, "big", false).await.unwrap();
    timed("stage_all + commit", t);
    assert_eq!(g.status(&dir).await.unwrap().staged_count(), 0);
}

/// History of a long branch: the first page, and the unpushed check against many remote refs.
/// Run with `cargo test -p gitr-core --test it large:: -- --ignored --nocapture`.
#[tokio::test]
#[ignore = "slow: creates 20,000 commits and 2,000 remote refs"]
async fn twenty_thousand_commits_page_quickly() {
    let (_t, dir) = repo_with_commit();
    let parent = git_out(&dir, &["rev-parse", "HEAD"]).trim().to_string();
    let mut stream = String::new();
    for i in 1..20_000 {
        let msg = format!("commit {i}\n");
        stream.push_str(&format!("commit refs/heads/main\nmark :{i}\ncommitter T <t@x> {} +0000\ndata {}\n{msg}", 946684800 + i, msg.len()));
        if i == 1 {
            stream.push_str(&format!("from {parent}\n"));
        }
        stream.push('\n');
    }
    // Remote-tracking refs spread over the history, as a busy team's origin has.
    for i in 0..2_000 {
        stream.push_str(&format!("reset refs/remotes/origin/b{i}\nfrom :{}\n\n", 1 + i * 9));
    }
    git_stdin(&dir, &["fast-import", "--quiet"], stream.as_bytes());
    git(&dir, &["remote", "add", "origin", "https://example.invalid/r.git"]);
    let g = isolated_git();

    let t = Instant::now();
    let page = g.log(&dir, 0, 200).await.unwrap();
    eprintln!("log first page: {:?}", t.elapsed());
    assert_eq!(page.commits.len(), 200);
    assert!(page.has_more);
    // Above the newest remote ref (commit 17992) everything is unpushed.
    assert!(page.commits.iter().all(|c| c.unpushed));

    let t = Instant::now();
    let page = g.log(&dir, 19_800, 200).await.unwrap();
    eprintln!("log last page: {:?}", t.elapsed());
    assert!(!page.has_more);
}
