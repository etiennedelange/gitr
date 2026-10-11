#!/usr/bin/env bash
# Applies the repository settings that go with docs/releasing.md: squash merge only,
# head branches deleted after merging, main changed only through PRs with green CI, and
# release tags that can't be moved or deleted. Safe to run again; it updates in place.
#
#   gh auth login            # once, as a repository admin
#   tools/release/github-settings.sh [owner/repo]
#
# Rulesets on a private repository need GitHub Pro (or a public repository).
set -euo pipefail

repo="${1:-$(gh repo view --json nameWithOwner --jq .nameWithOwner)}"
echo "Applying settings to $repo"

gh api --method PATCH "repos/$repo" --silent \
  -F allow_squash_merge=true \
  -F allow_merge_commit=false \
  -F allow_rebase_merge=false \
  -F delete_branch_on_merge=true \
  -F allow_update_branch=true \
  -F allow_auto_merge=true \
  -f squash_merge_commit_title=PR_TITLE \
  -f squash_merge_commit_message=PR_BODY

echo "Merge settings applied: squash only, head branches deleted after merging"

if ! gh api "repos/$repo/rulesets" --silent 2>/dev/null; then
  echo "Skipped rulesets: this repository can't use them (private on GitHub Free). Upgrade to Pro or make it public, then run this again." >&2
  exit 0
fi

# Creates the ruleset, or replaces the one with the same name.
upsert_ruleset() {
  local name="$1" body="$2" id
  id=$(gh api "repos/$repo/rulesets" --jq ".[] | select(.name == \"$name\") | .id")
  if [ -n "$id" ]; then
    gh api --method PUT "repos/$repo/rulesets/$id" --input - --silent <<<"$body"
    echo "Updated ruleset: $name"
  else
    gh api --method POST "repos/$repo/rulesets" --input - --silent <<<"$body"
    echo "Created ruleset: $name"
  fi
}

# The required checks are the job names in .github/workflows/ci.yml; keep them in step.
upsert_ruleset "main" '{
  "name": "main",
  "target": "branch",
  "enforcement": "active",
  "conditions": { "ref_name": { "include": ["~DEFAULT_BRANCH"], "exclude": [] } },
  "rules": [
    { "type": "deletion" },
    { "type": "non_fast_forward" },
    { "type": "required_linear_history" },
    {
      "type": "pull_request",
      "parameters": {
        "allowed_merge_methods": ["squash"],
        "required_approving_review_count": 0,
        "dismiss_stale_reviews_on_push": false,
        "require_code_owner_review": false,
        "require_last_push_approval": false,
        "required_review_thread_resolution": true
      }
    },
    {
      "type": "required_status_checks",
      "parameters": {
        "strict_required_status_checks_policy": false,
        "required_status_checks": [
          { "context": "ui" },
          { "context": "rust (ubuntu-latest)" },
          { "context": "rust (windows-latest)" },
          { "context": "rust (macos-latest)" }
        ]
      }
    }
  ]
}'

upsert_ruleset "release tags" '{
  "name": "release tags",
  "target": "tag",
  "enforcement": "active",
  "conditions": { "ref_name": { "include": ["refs/tags/v*"], "exclude": [] } },
  "rules": [
    { "type": "deletion" },
    { "type": "non_fast_forward" },
    { "type": "update" }
  ]
}'
