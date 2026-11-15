#!/usr/bin/env bash
#
# Scenario tests for the safety controls of ralph-loop.sh (ticket 52): the global, fail-closed
# debt hold at ticket selection (ADR 0020), and what may leave the machine after a rejection or a
# pause (ADR 0021). Each scenario runs the real harness (`main --once`) in a throwaway git repo with
# a stub agent and reviewer; every remote is a throwaway bare repository, so nothing here reaches a
# real remote, and the refs those repositories received are the evidence.
set -Eeuo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/test-git-isolation.sh"

SOURCE_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
readonly SOURCE_ROOT
WORK="$(mktemp -d)"
readonly WORK
trap '[[ -n "${KEEP_WORK:-}" ]] || rm -rf "${WORK}"' EXIT
failures=0

# Agent stub. GREEN writes the feature; STUB_SECRET=1 adds a credential-shaped line (built at run
# time, so no test file holds one), STUB_WORKFLOW=1 a GitHub workflow.
cat >"${WORK}/agent.sh" <<'EOF'
#!/usr/bin/env bash
echo "${RALPH_PHASE}" >>"${STUB_CALLS}.agent"
case "${RALPH_PHASE}" in
  green)
    echo feature >feature.txt
    if [[ "${STUB_SECRET:-0}" == 1 ]]; then
      printf 'const key = "AKIA%s";\n' "$(printf 'Z%.0s' {1..16})" >config.ts
    fi
    # An agent that breaks the no-git rule: its work would be committed onto the base branch.
    if [[ "${STUB_SWITCH:-0}" == 1 ]]; then
      git switch --quiet main
    fi
    if [[ "${STUB_WORKFLOW:-0}" == 1 ]]; then
      mkdir -p .github/workflows && echo 'on: push' >.github/workflows/x.yml
    fi
    ;;
esac
exit 0
EOF

# A register whose TD-001 is $1 (Blocks) owned by $2 (Target), triaged; "none none" for none.
register() {
  local blocks=$1 target=$2 status=PLANNED triage="2026-11-14: a maintainer" risk=SECURITY
  if [[ "${blocks}" == none ]]; then
    status=OPEN triage=pending risk=UNTRIAGED
  fi
  cat <<REGISTER
# Technical Debt Register

<!-- ralph-debt:begin -->
### TD-001: Earlier deferred finding
- **Status:** ${status}
- **Severity:** LOW
- **Risk:** ${risk}
- **Triage:** ${triage}
- **Source:** ticket 00
- **Evidence:** earlier review
- **Components:** \`old.txt\`
- **Problem:** p
- **Impact:** i
- **Justification:** deferred
- **Remediation:** r
- **Target:** ${target}
- **Blocks:** ${blocks}
<!-- ralph-debt:end -->
REGISTER
}

new_repo() {
  local dir="${WORK}/$1"
  mkdir -p "${dir}/scripts" "${dir}/skills/code-review" "${dir}/issues" "${dir}/docs"
  cp "${SOURCE_ROOT}/ralph-loop.sh" "${dir}/"
  cp "${SOURCE_ROOT}"/scripts/{ralph-review.mjs,ralph-review-prompt.mjs,ralph-artifacts.mjs,ralph-debt.mjs,ralph-red.mjs,ralph-provider.mjs,ralph-push-inspect.mjs} "${dir}/scripts/"
  register none none >"${dir}/docs/technical-debt.md"
  node "${dir}/scripts/ralph-debt.mjs" format "${dir}/docs/technical-debt.md" --root "${dir}"
  cp "${SOURCE_ROOT}/skills/code-review/report.schema.json" "${dir}/skills/code-review/"
  printf '# 01: Demo ticket\n\n**Blocked by:** None (can start immediately)\n\n**Status:** ready-for-agent\n\n- [ ] works\n' \
    >"${dir}/issues/01-demo.md"
  printf '.ralph/\n' >"${dir}/.gitignore"
  git -C "${dir}" init --quiet --initial-branch=main
  git -C "${dir}" config core.autocrlf false
  git -C "${dir}" -c user.name=t -c user.email=t@t add -A
  git -C "${dir}" -c user.name=t -c user.email=t@t commit --quiet -m init
  printf '%s\n' "${dir}"
}

commit_all() { git -C "$1" -c user.name=t -c user.email=t@t add -A && git -C "$1" -c user.name=t -c user.email=t@t commit --quiet -m "$2"; }

# Command-line arguments for the next run_harness (e.g. --push-rejected 01). run_harness runs in a
# command substitution, so the caller resets this after every run: an authorization must never
# carry over into the next scenario.
HARNESS_ARGS=()

# Runs one harness pass; prints its exit code. Gate and RED check are stubbed to pass.
run_harness() {
  local dir=$1
  shift
  (
    cd "${dir}"
    while read -r name; do unset "${name}"; done < <(compgen -e | grep '^RALPH_' || true)
    export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@t GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@t
    export RALPH_AGENT_CMD="bash ${WORK}/agent.sh" RALPH_REVIEW_CMD="node ${SOURCE_ROOT}/scripts/ralph-stub-reviewer.mjs"
    export RALPH_MAX_ATTEMPTS=1 STUB_CALLS="${dir}.calls" "$@"
    # shellcheck source=../ralph-loop.sh
    source ./ralph-loop.sh
    run_gate() { : >"$1"; }
    verify_red() { : >"$1"; }
    main --once "${HARNESS_ARGS[@]}"
  ) >"${dir}.out" 2>&1 && echo 0 || echo $?
}

# `ralph-loop.sh --dry-run` in <dir>, without the caller's RALPH_* settings; its exit status.
dry_run() {
  (
    cd "$1"
    while read -r name; do unset "${name}"; done < <(compgen -e | grep '^RALPH_' || true)
    bash ./ralph-loop.sh --dry-run
  ) >"$1.dry-run.out" 2>&1
}

check() {
  local name=$1 condition=$2
  if eval "${condition}"; then
    printf '  ok    %s\n' "${name}"
  else
    printf '  FAIL  %s  (%s)\n' "${name}" "${condition}"
    failures=$((failures + 1))
  fi
}

merged() { git -C "$1" log --oneline main | grep -q "Merge slice/"; }
quarantined() { git -C "$1" branch --list 'rejected/*' | grep -q rejected/01-demo; }
agent_ran() { [[ -s "$1.calls.agent" ]]; }
remote_quarantine() { git -C "$1" for-each-ref --format='%(refname)' 'refs/heads/rejected/'; }
remote_refs() { git -C "$1" for-each-ref --format='%(refname)' | sort; }

# --- Selection: the global, fail-closed hold (ADR 0020) ------------------------------------------

echo "global-hold-holds-a-ticket-created-after-it:"
dir="$(new_repo global-hold)"
register ALL_AGENT_TICKETS "ticket 05" >"${dir}/docs/technical-debt.md"
printf '# 05: Fix\n\n**Blocked by:** None\n\n**Status:** ready-for-human\n' >"${dir}/issues/05-fix.md"
node "${dir}/scripts/ralph-debt.mjs" format "${dir}/docs/technical-debt.md" --root "${dir}"
commit_all "${dir}" "maintainer: TD-001 holds every agent ticket"
# Created after the hold, and not named anywhere in it.
printf '# 02: New\n\n**Blocked by:** None\n\n**Status:** ready-for-agent\n' >"${dir}/issues/02-new.md"
commit_all "${dir}" "a new ticket"
code="$(run_harness "${dir}" STUB_REVIEW=clean)"
HARNESS_ARGS=()
check "the register is valid" \
  "node '${dir}/scripts/ralph-debt.mjs' check '${dir}/docs/technical-debt.md' --root '${dir}'"
check "no ticket is selected: no agent runs, nothing merges" \
  "[[ ${code} == 0 ]] && ! agent_ran '${dir}' && ! merged '${dir}'"
check "the run kept the verdicts it selected by, the new ticket held" \
  "grep -q \$'^02\twaiting\tTD-001 (SECURITY) holds every ticket' '${dir}'/.ralph/logs/2*/debt-gate.tsv"
check "the ticket worked by hand is clear (and never selected)" \
  "grep -q \$'^05\tclear' '${dir}'/.ralph/logs/2*/debt-gate.tsv"

echo "resolving-the-hold-releases-the-tickets:"
dir="$(new_repo global-hold-released)"
register ALL_AGENT_TICKETS "ticket 05" >"${dir}/docs/technical-debt.md"
printf '# 05: Fix\n\n**Blocked by:** None\n\n**Status:** ready-for-human\n' >"${dir}/issues/05-fix.md"
node "${dir}/scripts/ralph-debt.mjs" format "${dir}/docs/technical-debt.md" --root "${dir}"
mkdir -p "${dir}/tests" && echo 'true' >"${dir}/tests/fix.test.sh"
sed -i -e 's/^- \*\*Status:\*\* PLANNED$/- **Status:** RESOLVED/' \
  -e 's/^- \*\*Resolution:\*\* none$/- **Resolution:** fixed/' \
  -e 's/^- \*\*Verification:\*\* none$/- **Verification:** `tests\/fix.test.sh`/' \
  "${dir}/docs/technical-debt.md"
node "${dir}/scripts/ralph-debt.mjs" format "${dir}/docs/technical-debt.md" --root "${dir}"
commit_all "${dir}" "maintainer: TD-001 resolved"
code="$(run_harness "${dir}" STUB_REVIEW=clean)"
HARNESS_ARGS=()
check "the ticket is selected and merges once the hold is resolved" "[[ ${code} == 0 ]] && merged '${dir}'"

for bad in "ALL_AGENT_TICKETS, 01" "all"; do
  name="unreadable-blocks-${bad//[^a-z0-9]/-}"
  echo "${name}:"
  dir="$(new_repo "${name}")"
  register "${bad}" "ticket 05" >"${dir}/docs/technical-debt.md"
  printf '# 05: Fix\n\n**Blocked by:** None\n\n**Status:** ready-for-human\n' >"${dir}/issues/05-fix.md"
  node "${dir}/scripts/ralph-debt.mjs" format "${dir}/docs/technical-debt.md" --root "${dir}" 2>/dev/null || true
  commit_all "${dir}" "a malformed hold"
  code="$(run_harness "${dir}" STUB_REVIEW=clean)"
  HARNESS_ARGS=()
  check "the harness stops with an error before any agent runs" \
    "[[ ${code} != 0 ]] && grep -q 'could not reach a verdict' '${dir}.out' && ! agent_ran '${dir}'"
  check "the dry run fails the same way" "! dry_run '${dir}'"
done

echo "missing-register-selects-nothing:"
dir="$(new_repo missing-register)"
git -C "${dir}" rm --quiet docs/technical-debt.md
commit_all "${dir}" "no register"
code="$(run_harness "${dir}" STUB_REVIEW=clean)"
HARNESS_ARGS=()
check "the harness refuses before any agent runs" "[[ ${code} != 0 ]] && ! agent_ran '${dir}'"

# --- Rejected work and the remote (ADR 0021) ------------------------------------------------------

# Rejects ticket 01 (a CRITICAL finding) with RALPH_PUSH_REMOTE=origin, a fresh bare repository.
# Usage: push_scenario <name> [VAR=value...]; sets dir, remote and code.
push_scenario() {
  local name=$1
  shift
  echo "${name}:"
  dir="$(new_repo "${name}")"
  remote="${WORK}/${name}.remote.git"
  git init --quiet --bare "${remote}"
  git -C "${dir}" remote add origin "${remote}"
  git -C "${dir}" push --quiet origin main
  # PUSH_SETUP, if set, names a function that adjusts the repo before the run (e.g. its push URL).
  [[ -z "${PUSH_SETUP:-}" ]] || "${PUSH_SETUP}" "${dir}"
  remote_refs "${remote}" >"${dir}.refs-before"
  code="$(run_harness "${dir}" STUB_REVIEW=critical RALPH_MAX_REVIEW_ROUNDS=1 RALPH_PUSH_REMOTE=origin "$@")"
  HARNESS_ARGS=()
  check "the ticket is rejected and its work kept on the local quarantine branch" \
    "[[ ${code} != 0 ]] && quarantined '${dir}'"
  check "no remote ref was deleted" \
    "[[ -z \$(comm -23 '${dir}.refs-before' <(remote_refs '${remote}')) ]]"
}

push_scenario rejected-work-is-not-pushed-by-default
check "the remote received no quarantine branch" "[[ -z \$(remote_quarantine '${remote}') ]]"
check "the blocked status still reached the remote's main" \
  "git -C '${remote}' show main:issues/01-demo.md | grep -q '^\*\*Status:\*\* blocked'"
check "the log says why, and how to authorize it" \
  "tr '\n' ' ' <'${dir}.out' | grep -q 'never pushed by default.*--push-rejected 01'"

HARNESS_ARGS=(--push-rejected 01)
push_scenario authorized-and-inspected-rejection-is-pushed
check "the remote received exactly this run's quarantine branch" \
  "[[ \$(remote_quarantine '${remote}') == \
     refs/heads/\$(git -C '${dir}' branch --list 'rejected/*' --format='%(refname:short)') ]]"
check "the inspection ran and passed" "grep -q 'push inspection: passed' '${dir}.out'"

HARNESS_ARGS=(--push-rejected 01)
push_scenario authorized-push-with-a-credential-is-blocked STUB_SECRET=1
check "the remote received no quarantine branch" "[[ -z \$(remote_quarantine '${remote}') ]]"
check "the inspection named the finding" "grep -q 'config.ts:1: AWS access key' '${dir}.out'"
check "the credential is not in the log" "! grep -q 'AKIAZZZZ' '${dir}.out'"

HARNESS_ARGS=(--push-rejected 01)
push_scenario authorized-push-with-a-workflow-is-blocked STUB_WORKFLOW=1
check "the remote received no quarantine branch" "[[ -z \$(remote_quarantine '${remote}') ]]"
check "the inspection named the workflow" \
  "grep -q '.github/workflows/x.yml: .github/ file' '${dir}.out'"

HARNESS_ARGS=(--push-rejected 02)
push_scenario authorization-for-another-ticket-is-no-authorization
check "the remote received no quarantine branch" "[[ -z \$(remote_quarantine '${remote}') ]]"

# The inspection cannot run (it crashes): authorization alone must not let the push through.
echo "unavailable-inspection-blocks-the-push:"
dir="$(new_repo unavailable-inspection)"
printf 'process.exit(2);\n' >"${dir}/scripts/ralph-push-inspect.mjs"
commit_all "${dir}" "an inspection that cannot run"
remote="${WORK}/unavailable-inspection.remote.git"
git init --quiet --bare "${remote}"
git -C "${dir}" remote add origin "${remote}"
git -C "${dir}" push --quiet origin main
HARNESS_ARGS=(--push-rejected 01)
code="$(run_harness "${dir}" STUB_REVIEW=critical RALPH_MAX_REVIEW_ROUNDS=1 RALPH_PUSH_REMOTE=origin)"
HARNESS_ARGS=()
check "the remote received no quarantine branch" \
  "[[ ${code} != 0 && -z \$(remote_quarantine '${remote}') ]] && quarantined '${dir}'"
check "the log says the inspection did not pass" "grep -q 'inspection did not pass' '${dir}.out'"

echo "authorization-needs-a-remote:"
dir="$(new_repo authorization-needs-a-remote)"
HARNESS_ARGS=(--push-rejected 01)
code="$(run_harness "${dir}" STUB_REVIEW=clean)"
HARNESS_ARGS=()
check "refused before any agent runs" \
  "[[ ${code} != 0 ]] && grep -q 'needs RALPH_PUSH_REMOTE' '${dir}.out' && ! agent_ran '${dir}'"

# The sandbox's staging repository is where the evidence must go (the host validates it); a
# sandbox whose remote is anything else is treated like the host.
push_scenario sandbox-staging-receives-rejected-work RALPH_SANDBOX=1 \
  RALPH_STAGING_REMOTE="${WORK}/sandbox-staging-receives-rejected-work.remote.git"
check "the staging repository received the quarantine branch" \
  "[[ -n \$(remote_quarantine '${remote}') ]]"
push_scenario a-remote-that-is-not-the-staging-repository RALPH_SANDBOX=1 \
  RALPH_STAGING_REMOTE="${WORK}/somewhere-else.git"
check "the remote received no quarantine branch" "[[ -z \$(remote_quarantine '${remote}') ]]"

# A pushurl or pushInsteadOf can send pushes elsewhere than the fetch URL says: the staging check
# must look at where the push actually goes.
divert_push() { git -C "$1" remote set-url --push origin "${WORK}/diverted.git"; }
git init --quiet --bare "${WORK}/diverted.git"
PUSH_SETUP=divert_push
push_scenario a-diverted-push-url-is-not-staging RALPH_SANDBOX=1 \
  RALPH_STAGING_REMOTE="${WORK}/a-diverted-push-url-is-not-staging.remote.git"
PUSH_SETUP=""
check "the diverted target received no quarantine branch" \
  "[[ -z \$(remote_quarantine '${WORK}/diverted.git') ]]"

# The agent switched to the base branch: the rejection must not commit or push anything, with or
# without authorization.
echo "an-agent-on-the-base-branch-publishes-nothing:"
dir="$(new_repo agent-switches-branch)"
remote="${WORK}/agent-switches-branch.remote.git"
git init --quiet --bare "${remote}"
git -C "${dir}" remote add origin "${remote}"
git -C "${dir}" push --quiet origin main
before="$(git -C "${remote}" rev-parse main)"
HARNESS_ARGS=(--push-rejected 01)
code="$(run_harness "${dir}" STUB_REVIEW=critical STUB_SWITCH=1 RALPH_MAX_REVIEW_ROUNDS=1 RALPH_PUSH_REMOTE=origin)"
HARNESS_ARGS=()
check "the harness stops with an error" \
  "[[ ${code} != 0 ]] && grep -q 'cannot quarantine safely' '${dir}.out'"
check "the remote's main is unchanged and it has no other branch" \
  "[[ \$(git -C '${remote}' rev-parse main) == '${before}' && \$(remote_refs '${remote}') == refs/heads/main ]]"

if ((failures > 0)); then
  echo "ralph-loop safety scenarios: ${failures} check(s) failed" >&2
  exit 1
fi
echo "ralph-loop safety scenarios: all passed"
