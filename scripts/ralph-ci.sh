#!/usr/bin/env bash
#
# Waits for GitHub Actions' CI workflow on one commit, for scripts/ralph-batch.mjs. Only a
# completed, successful run of that exact commit counts; anything else is never a pass.
#
# Usage: scripts/ralph-ci.sh <commit sha>
# Exit:  0 CI passed
#        1 CI failed (failure, timed out, startup failure): a definite failure
#        2 unknown: no run appeared in time, still running at the deadline, cancelled, skipped,
#          or gh failed. The batch stops resumably and checks again on the next run.
#
# Environment: RALPH_CI_WORKFLOW (default ci.yml), RALPH_CI_APPEAR_TIMEOUT (seconds for a run to
# appear, default 600), RALPH_CI_TIMEOUT (seconds overall, default 3600), RALPH_CI_POLL (seconds
# between checks, default 20). Needs an authenticated `gh` for the repository's GitHub remote.
set -Euo pipefail

sha="${1:?usage: ralph-ci.sh <commit sha>}"
workflow="${RALPH_CI_WORKFLOW:-ci.yml}"
appear="${RALPH_CI_APPEAR_TIMEOUT:-600}"
deadline="${RALPH_CI_TIMEOUT:-3600}"
poll="${RALPH_CI_POLL:-20}"

say() { printf '[ralph-ci] %s\n' "$*" >&2; }

command -v gh >/dev/null || {
  say "gh is not installed: CI cannot be verified"
  exit 2
}

started=${SECONDS}
seen=false
while :; do
  # Newest run of the workflow for this commit; `null null null` when there is none yet.
  if line="$(gh run list --workflow "${workflow}" --commit "${sha}" --event push --limit 1 \
    --json status,conclusion,url --jq '.[0] | "\(.status) \(.conclusion) \(.url)"' 2>&1)"; then
    case "${line}" in
      "completed success "*)
        say "CI passed: ${line##* }"
        exit 0
        ;;
      "completed failure "* | "completed timed_out "* | "completed startup_failure "*)
        say "CI failed: ${line}"
        exit 1
        ;;
      "completed "*)
        say "CI finished without a verdict (${line}): not a pass"
        exit 2
        ;;
      "" | "null null null") ;;
      *) seen=true ;;
    esac
  else
    say "gh failed (${line}); retrying"
  fi
  elapsed=$((SECONDS - started))
  if [[ "${seen}" == false ]] && ((elapsed >= appear)); then
    say "no CI run of ${workflow} appeared for ${sha} within ${appear}s"
    exit 2
  fi
  if ((elapsed >= deadline)); then
    say "CI for ${sha} still not finished after ${deadline}s"
    exit 2
  fi
  sleep "${poll}"
done
