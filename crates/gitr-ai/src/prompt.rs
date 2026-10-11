use gitr_core::repo::StagedChanges;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CommitPrompt {
    pub system: String,
    pub user: String,
}

const SYSTEM: &str = "You write git commit messages for staged changes.
Rules:
- Output ONLY the commit message. No code fences, quotes, preamble or explanation.
- First line: imperative mood summary, at most 72 characters, no trailing period.
- For non-trivial changes add a blank line, then a short body (wrapped at 72 chars) explaining what changed and why. Use '-' bullets for multiple points.
- If the recent commit subjects follow a consistent convention (e.g. Conventional Commits like 'feat:' / 'fix(scope):', or a ticket prefix like 'ABC-123:'), follow it.
- If a ticket ID is provided and recent commits use ticket IDs, include it the same way.
- Never invent changes that are not in the diff.";

pub fn build_prompt(changes: &StagedChanges) -> CommitPrompt {
    let mut user = String::new();
    if let Some(branch) = &changes.branch {
        user.push_str(&format!("Branch: {branch}\n"));
        if let Some(ticket) = extract_ticket(branch) {
            user.push_str(&format!("Ticket ID: {ticket}\n"));
        }
    }
    if !changes.recent_subjects.is_empty() {
        user.push_str("\nRecent commit subjects (newest first):\n");
        for s in &changes.recent_subjects {
            user.push_str(&format!("- {s}\n"));
        }
    }
    user.push_str("\nStaged files:\n");
    user.push_str(changes.stat.trim_end());
    user.push_str("\n\nStaged diff:\n");
    user.push_str(&changes.diff);
    CommitPrompt { system: SYSTEM.to_string(), user }
}

/// Finds a Jira/ADO-style ticket key such as `AB-1234` in a branch name.
pub fn extract_ticket(branch: &str) -> Option<String> {
    let b = branch.as_bytes();
    let mut i = 0;
    while i < b.len() {
        let at_boundary = i == 0 || !b[i - 1].is_ascii_alphanumeric();
        if at_boundary && b[i].is_ascii_alphabetic() {
            let start = i;
            let mut j = i;
            while j < b.len() && b[j].is_ascii_alphanumeric() {
                j += 1;
            }
            let key = &branch[start..j];
            if j + 1 < b.len()
                && b[j] == b'-'
                && b[j + 1].is_ascii_digit()
                && key.len() >= 2
                && key.bytes().all(|c| c.is_ascii_uppercase() || c.is_ascii_digit())
            {
                let mut k = j + 1;
                while k < b.len() && b[k].is_ascii_digit() {
                    k += 1;
                }
                return Some(branch[start..k].to_string());
            }
            i = j.max(i + 1);
        } else {
            i += 1;
        }
    }
    None
}

/// Strips code fences/quotes models sometimes add despite instructions.
pub fn clean_output(raw: &str) -> String {
    let mut s = raw.trim();
    if s.starts_with("```") {
        s = s.trim_start_matches('`');
        s = s.split_once('\n').map(|(_, rest)| rest).unwrap_or("");
        s = s.trim_end().trim_end_matches('`').trim();
    }
    if s.len() >= 2 && s.starts_with('"') && s.ends_with('"') {
        s = &s[1..s.len() - 1];
    }
    s.trim().to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extracts_ticket_ids() {
        assert_eq!(extract_ticket("feature/AB-2786-fix-login").as_deref(), Some("AB-2786"));
        assert_eq!(extract_ticket("UA-12_thing").as_deref(), Some("UA-12"));
        assert_eq!(extract_ticket("bugfix/abc-123"), None);
        assert_eq!(extract_ticket("release/v1-2"), None);
        assert_eq!(extract_ticket("main"), None);
    }

    #[test]
    fn prompt_includes_context() {
        let p = build_prompt(&StagedChanges {
            branch: Some("feature/AB-9-x".into()),
            stat: " a.rs | 2 +-\n".into(),
            diff: "+hello\n".into(),
            recent_subjects: vec!["AB-8: earlier".into()],
        });
        assert!(p.user.contains("Ticket ID: AB-9"));
        assert!(p.user.contains("- AB-8: earlier"));
        assert!(p.user.contains("+hello"));
        assert!(p.system.contains("ONLY the commit message"));
    }

    #[test]
    fn cleans_fences_and_quotes() {
        assert_eq!(clean_output("```text\nFix bug\n\nBody\n```"), "Fix bug\n\nBody");
        assert_eq!(clean_output("\"Add thing\""), "Add thing");
        assert_eq!(clean_output("  Plain  \n"), "Plain");
    }
}
