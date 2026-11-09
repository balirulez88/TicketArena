#!/usr/bin/env bash
#
# Scenario tests for the opt-in lead driver (scripts/ralph-lead.sh, scripts/ralph-driver.sh,
# ADR 0017). Each scenario runs the real driver in a throwaway git repo with a stub in place of
# the `claude` binary, and checks what reached the base branch and how many agent runs it cost.
# The quality gate and the RED check are stubs that record what they were given: this file tests
# the driver's own judgement (git intact, RED re-proved from the candidate's tests alone, no
# retry, no fallback, interruption), not the project's tests. That what the driver leaves behind
# passes the real host importer is in scripts/ralph-accept.test.mjs.
set -Eeuo pipefail

SOURCE_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
readonly SOURCE_ROOT
WORK="$(mktemp -d)"
readonly WORK
trap 'rm -rf "${WORK}"' EXIT
failures=0

# The lead stand-in. STUB_LEAD picks its behaviour. It never touches git, except `tamper`.
cat >"${WORK}/lead.sh" <<'EOF'
#!/usr/bin/env bash
echo "${STUB_LEAD:-ok} ticket ${RALPH_TICKET} phase ${RALPH_PHASE}" >>"${STUB_CALLS}.lead"
case "${STUB_LEAD:-ok}" in
  ok)
    mkdir -p .ralph/lead
    echo "AC1 feature.test.ts::feature; sabotage: drop feature" >.ralph/lead/checklist.md
    echo "A feature.ts feature.test.ts" >.ralph/lead/changeset.md
    echo "export const feature = 1;" >feature.ts
    echo "test('feature', () => {});" >feature.test.ts
    printf '{"type":"result","is_error":false,"total_cost_usd":0.42,"usage":{"input_tokens":3,"output_tokens":9,"cache_read_input_tokens":100,"cache_creation_input_tokens":50}}\n'
    ;;
  fail)
    echo "export const partial = 1;" >partial.ts
    echo "boom" >&2
    exit 1
    ;;
  limit)
    echo "export const partial = 1;" >partial.ts
    echo "Claude AI usage limit reached|1762300800"
    exit 1
    ;;
  symlinked)
    # A handoff directory that is a link to somewhere else must neither pass nor be exported.
    secret="$(mktemp -d)"
    echo "TOP-SECRET" >"${secret}/checklist.md"
    echo "TOP-SECRET" >"${secret}/changeset.md"
    mkdir -p .ralph
    rm -rf .ralph/lead
    ln -s "${secret}" .ralph/lead
    echo "export const partial = 1;" >partial.ts
    printf '{"type":"result","is_error":false}\n'
    ;;
  premature)
    # What the pilot did: delegated in the background, wrote the checklist, then ended its turn
    # (exit 0) with the work half done and no changeset.
    mkdir -p .ralph/lead
    echo "AC1 feature.test.ts::feature" >.ralph/lead/checklist.md
    echo "export const partial = 1;" >partial.ts
    echo "I will wait for the implementer's completion notice." >&2
    printf '{"type":"result","is_error":false,"result":"waiting for the background implementer"}
'
    ;;
  undeclared | check-broken)
    # A finished candidate whose test loads a package the base does not have.
    mkdir -p .ralph/lead
    echo "AC1 feature.test.ts::feature" >.ralph/lead/checklist.md
    echo "A feature.ts feature.test.ts" >.ralph/lead/changeset.md
    echo "export const feature = 1;" >feature.ts
    printf 'import "brand-new";\ntest("feature", () => {});\n' >feature.test.ts
    [[ "${STUB_LEAD}" != check-broken ]] || rm scripts/ralph-preflight.mjs
    printf '{"type":"result","is_error":false}\n'
    ;;
  tamper)
    mkdir -p .ralph/lead
    echo "AC1" >.ralph/lead/checklist.md
    echo "A" >.ralph/lead/changeset.md
    echo "export const feature = 1;" >feature.ts
    git switch --quiet main
    ;;
  slow)
    echo "export const partial = 1;" >partial.ts
    echo $$ >"${STUB_CALLS}.pid"
    : >"${STUB_CALLS}.started"
    exec sleep 60
    ;;
esac
EOF

# The Ralph agent stand-in: the lead driver must never run it.
cat >"${WORK}/agent.sh" <<'EOF'
#!/usr/bin/env bash
echo "agent ${RALPH_PHASE:-?}" >>"${STUB_CALLS}.agent"
exit 0
EOF

new_repo() {
  local dir="${WORK}/$1"
  mkdir -p "${dir}/scripts" "${dir}/skills/code-review" "${dir}/issues" "${dir}/docs"
  cp "${SOURCE_ROOT}/ralph-loop.sh" "${dir}/"
  cp "${SOURCE_ROOT}"/scripts/{ralph-lead.sh,ralph-driver.sh,ralph-preflight.mjs,ralph-usage.mjs,ralph-review.mjs,ralph-review-prompt.mjs,ralph-artifacts.mjs,ralph-debt.mjs,ralph-red.mjs,ralph-provider.mjs} "${dir}/scripts/"
  printf '# Technical Debt Register\n\n<!-- ralph-debt:begin -->\n<!-- ralph-debt:end -->\n' \
    >"${dir}/docs/technical-debt.md"
  node "${dir}/scripts/ralph-debt.mjs" format "${dir}/docs/technical-debt.md"
  cp "${SOURCE_ROOT}/skills/code-review/report.schema.json" "${dir}/skills/code-review/"
  printf '# 01: Demo ticket\n\n**Blocked by:** None (can start immediately)\n\n**Status:** ready-for-agent\n\n- [ ] works\n' \
    >"${dir}/issues/01-demo.md"
  printf '.ralph/\n' >"${dir}/.gitignore"
  echo base >"${dir}/app.ts"
  git -C "${dir}" init --quiet --initial-branch=main
  git -C "${dir}" config core.autocrlf false
  git -C "${dir}" -c user.name=t -c user.email=t@t add -A
  git -C "${dir}" -c user.name=t -c user.email=t@t commit --quiet -m init
  printf '%s\n' "${dir}"
}

# One driver run; STUB_* variables set by the caller reach the stubs. The gate and the RED check
# are replaced after sourcing, exactly as scripts/ralph-loop.test.sh replaces them. The RED stub
# records the tree it was asked to judge.
run_lead_body() {
  local dir=$1
  shift
  {
    cd "${dir}"
    while read -r name; do unset "${name}"; done < <(compgen -e | grep '^RALPH_' || true)
    export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@t GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@t
    export RALPH_AGENT_CMD="bash ${WORK}/agent.sh" RALPH_REVIEW_CMD="bash ${WORK}/agent.sh"
    export RALPH_LEAD_CMD="bash ${WORK}/lead.sh" STUB_CALLS="${dir}.calls"
    [[ -z "${STUB_LEAD_TIMEOUT:-}" ]] || export RALPH_LEAD_TIMEOUT="${STUB_LEAD_TIMEOUT}"
    # shellcheck source=ralph-lead.sh
    source ./scripts/ralph-lead.sh
    run_gate() {
      # Before the Lead has started, the only gate that runs is the baseline check on the base.
      if [[ ! -f "${STUB_CALLS}.lead" ]]; then
        echo x >>"${STUB_CALLS}.baseline"
        if [[ "${STUB_BASELINE:-pass}" == fail ||
          ("${STUB_BASELINE:-pass}" == flaky && "$(wc -l <"${STUB_CALLS}.baseline")" -eq 1) ]]; then
          echo "baseline failed" >"$1"
          return 1
        fi
        : >"$1"
        return 0
      fi
      : >"${STUB_CALLS}.gate-ran"
      if [[ "${STUB_GATE:-pass}" == pass ]]; then : >"$1"; else
        echo "gate failed" >"$1"
        return 1
      fi
    }
    [[ "${STUB_BASELINE_KEY:-}" != current ]] ||
      export RALPH_BASELINE_VERIFIED="$(ralph_baseline_key "${PWD}/scripts/ralph-preflight.mjs" HEAD)"
    [[ "${STUB_BASELINE_KEY:-}" != stale ]] || export RALPH_BASELINE_VERIFIED=stale-key
    verify_red() {
      : >"${STUB_CALLS}.red-ran"
      if [[ "${STUB_RED:-pass}" == slow ]]; then
        : >"${STUB_CALLS}.red-started"
        sleep 60 &
        wait $!
      fi
      git status --porcelain --untracked-files=all | cut -c4- >"${STUB_CALLS}.red-tree"
      if [[ "${STUB_RED:-pass}" == pass ]]; then : >"$1"; else
        echo "RED rejected" >"$1"
        return 1
      fi
    }
    lead_main "$@"
  }
}
run_lead() { (run_lead_body "$@"); }

expect() {
  local description=$1
  shift
  if "$@"; then
    printf '  ok    %s\n' "${description}"
  else
    printf '  FAIL  %s\n' "${description}"
    failures=$((failures + 1))
  fi
}
calls() { { [[ -f "${WORK}/$1.calls.$2" ]] && wc -l <"${WORK}/$1.calls.$2" | tr -d ' '; } || echo 0; }
status_of() { sed -n 's/^\*\*Status:\*\* //p' "$1" | head -n 1; }
main_status() { git -C "${WORK}/$1" show main:issues/01-demo.md | sed -n 's/^\*\*Status:\*\* //p'; }
base_of() { git -C "${WORK}/$1" rev-parse refs/heads/main; }
no_merge() { [[ "$(git -C "${WORK}/$1" log --format=%s main | grep -c '^Merge slice/' || true)" == 0 ]]; }

scenario() {
  echo "scenario: $1"
}

# ------------------------------------------------------------------------------ driver selection
scenario "driver selection: Ralph is the default, the lead is opt-in, typos are refused"
# shellcheck source=ralph-driver.sh
source "${SOURCE_ROOT}/scripts/ralph-driver.sh"
expect "unset selects Ralph" test "$(ralph_driver_script "")" = ./ralph-loop.sh
expect "ralph selects Ralph" test "$(ralph_driver_script ralph)" = ./ralph-loop.sh
expect "lead selects the lead driver" test "$(ralph_driver_script lead)" = ./scripts/ralph-lead.sh
expect "an unknown value is refused, not defaulted" bash -c \
  "source '${SOURCE_ROOT}/scripts/ralph-driver.sh'; ! ralph_driver_script Lead 2>/dev/null; ! ralph_driver_script leader 2>/dev/null"
expect "Ralph needs no --ticket" ralph_driver_check "" --once
expect "the lead needs an explicit --ticket" bash -c \
  "source '${SOURCE_ROOT}/scripts/ralph-driver.sh'; ! ralph_driver_check lead --once 2>/dev/null; ralph_driver_check lead --ticket 12"
expect "the lead does not select tickets (--once alone, no ticket)" bash -c \
  "source '${SOURCE_ROOT}/scripts/ralph-driver.sh'; ! ralph_driver_check lead 2>/dev/null"

# ------------------------------------------------------------------------------------ the merge
scenario "a good candidate merges after exactly one lead session and no Ralph agent"
d="$(new_repo merge)"
code=0
STUB_LEAD=ok run_lead "${d}" --ticket 01 >"${d}.out" 2>&1 || code=$?
expect "exit 0" test "${code}" = 0
expect "main holds the slice merge" test \
  "$(git -C "${d}" log -1 --format=%s main)" = "Merge slice/01-demo: Demo ticket"
expect "the slice commit has Ralph's subject" test \
  "$(git -C "${d}" log -1 --format=%s main^2)" = "feat(slice-01): Demo ticket"
expect "the slice is one commit on the base" test \
  "$(git -C "${d}" rev-list --count main^1..main^2)" = 1
expect "the ticket is archived as done" grep -q 'Completed' "${d}/issues/done/01-demo.md"
expect "the commit says what was established" bash -c \
  "git -C '${d}' log -1 --format=%B main^2 | grep -q 'RED re-proved'"
expect "one lead session" test "$(calls merge lead)" = 1
expect "no Ralph agent or reviewer ran" test "$(calls merge agent)" = 0
expect "RED judged the candidate's test alone" bash -c \
  "grep -qx 'feature.test.ts' '${d}.calls.red-tree' && ! grep -qx 'feature.ts' '${d}.calls.red-tree'"
expect "usage is reported with its caveat" bash -c \
  "grep -q '\$0.4200' '${d}'/.ralph/logs/*/usage.md && grep -q 'not subscription usage' '${d}'/.ralph/logs/*/usage.md"
expect "the checklist and changeset are exported to the run's logs" bash -c   "grep -q 'sabotage' '${d}'/.ralph/logs/*/01-demo.lead-handoff/checklist.md && test -s '${d}'/.ralph/logs/*/01-demo.lead-handoff/changeset.md"
expect "the session is logged as ok with exit 0" bash -c \
  "awk -F'\t' '\$4==\"ok\" && \$5==0 {f=1} END{exit !f}' '${d}'/.ralph/logs/*/sessions.tsv"

# ---------------------------------------------------------------------------- rejection (judged)
scenario "a candidate whose tests do not fail on the base is rejected like Ralph rejects"
d="$(new_repo red)"
code=0
STUB_LEAD=ok STUB_RED=fail run_lead "${d}" --ticket 01 >"${d}.out" 2>&1 || code=$?
expect "non-zero exit" test "${code}" != 0
expect "nothing merged" no_merge red
expect "the ticket is blocked on main" test "$(status_of "${d}/issues/01-demo.md")" = blocked
expect "the work is on a quarantine branch" bash -c \
  "git -C '${d}' branch --list 'rejected/01-demo-*' | grep -q ."
expect "one lead session, no retry" test "$(calls red lead)" = 1
expect "no Ralph agent ran" test "$(calls red agent)" = 0

scenario "a candidate that fails the gate is rejected, with no second run"
d="$(new_repo gate)"
code=0
STUB_LEAD=ok STUB_GATE=fail run_lead "${d}" --ticket 01 >"${d}.out" 2>&1 || code=$?
expect "non-zero exit" test "${code}" != 0
expect "nothing merged" no_merge gate
expect "the ticket is blocked on main" test "$(status_of "${d}/issues/01-demo.md")" = blocked
expect "one lead session, no retry" test "$(calls gate lead)" = 1
expect "no Ralph agent ran" test "$(calls gate agent)" = 0

# ------------------------------------------------------------------- failure: stop, never fall back
for kind in fail limit; do
  scenario "a lead session that fails (${kind}) stops safely: no retry, no fallback, ticket kept"
  d="$(new_repo "stop-${kind}")"
  base="$(base_of "stop-${kind}")"
  code=0
  STUB_LEAD="${kind}" run_lead "${d}" --ticket 01 >"${d}.out" 2>&1 || code=$?
  expect "non-zero exit" test "${code}" != 0
  expect "main did not move" test "$(base_of "stop-${kind}")" = "${base}"
  expect "the ticket is NOT blocked" test "$(status_of "${d}/issues/01-demo.md")" = ready-for-agent
  expect "no quarantine branch" bash -c "! git -C '${d}' branch --list 'rejected/*' | grep -q ."
  expect "exactly one lead session" test "$(calls "stop-${kind}" lead)" = 1
  expect "no Ralph agent or reviewer ran (no fallback)" test "$(calls "stop-${kind}" agent)" = 0
  expect "the work is kept as a patch in the logs" bash -c \
    "grep -q 'partial.ts' '${d}'/.ralph/logs/*/01-demo.lead-work.patch"
  expect "the work is kept on the slice branch" bash -c \
    "git -C '${d}' show slice/01-demo:partial.ts | grep -q partial"
done
expect "a provider limit is named as the provider's" grep -q 'provider usage-limit' "${WORK}/stop-limit.out"

# ------------------------------------------------------------------------- premature exit (pilot 56)
scenario "a lead that ends its turn without handing off is not judged, merged or blocked"
d="$(new_repo premature)"
base="$(base_of premature)"
code=0
STUB_LEAD=premature run_lead "${d}" --ticket 01 >"${d}.out" 2>&1 || code=$?
expect "non-zero exit" test "${code}" != 0
expect "the missing handoff is named, with the likely cause" grep -q 'background' "${d}.out"
expect "main did not move, nothing merged" test "$(base_of premature)" = "${base}"
expect "the ticket is NOT blocked" test "$(main_status premature)" = ready-for-agent
expect "no quarantine branch" bash -c "! git -C '${d}' branch --list 'rejected/*' | grep -q ."
expect "RED and the gate were never asked to judge it" bash -c   "test ! -e '${d}.calls.red-tree' && test ! -e '${d}.calls.gate-ran'"
expect "exactly one lead session, no retry, no Ralph agent" test   "$(calls premature lead)-$(calls premature agent)" = 1-0
expect "the partial checklist is still exported as evidence" bash -c   "grep -q 'AC1' '${d}'/.ralph/logs/*/01-demo.lead-handoff/checklist.md"
expect "the half-done work is kept as a patch" bash -c   "grep -q 'partial.ts' '${d}'/.ralph/logs/*/01-demo.lead-work.patch"

probe="$(mktemp -d "${WORK}/probe.XXXXXX")"
mkdir "${probe}/target"
ln -s "${probe}/target" "${probe}/link" 2>/dev/null || true
if [[ -L "${probe}/link" ]]; then
scenario "a handoff directory that is a symlink is neither accepted nor exported"
d="$(new_repo symlinked)"
code=0
STUB_LEAD=symlinked run_lead "${d}" --ticket 01 >"${d}.out" 2>&1 || code=$?
expect "non-zero exit" test "${code}" != 0
expect "treated as no handoff" grep -q 'without handing off' "${d}.out"
expect "nothing outside the clone was copied into the logs" bash -c \
  "! grep -rq 'TOP-SECRET' '${d}'/.ralph/logs 2>/dev/null"
expect "nothing merged, ticket not blocked" test "$(main_status symlinked)" = ready-for-agent
else
  echo "  skip  symlinks are unavailable on this host (the Linux gate runs this scenario)"
fi

scenario "the lead's prompt orders foreground subagents and names the handoff files"
expect "foreground rule" bash -c "grep -q 'SUBAGENTS RUN IN THE FOREGROUND ONLY' '${SOURCE_ROOT}/scripts/ralph-lead.sh' && grep -q 'Never start one with run_in_background' '${SOURCE_ROOT}/scripts/ralph-lead.sh'"

# ---------------------------------------------------------------------------------- git tampering
scenario "a lead that moves git is not trusted: the candidate is not merged or judged"
d="$(new_repo tamper)"
code=0
STUB_LEAD=tamper run_lead "${d}" --ticket 01 >"${d}.out" 2>&1 || code=$?
expect "non-zero exit" test "${code}" != 0
expect "nothing merged" no_merge tamper
expect "the gate and RED were never asked to approve it" test ! -e "${d}.calls.red-tree"
expect "the ticket is not blocked" test "$(status_of "${d}/issues/01-demo.md")" != blocked
expect "one lead session" test "$(calls tamper lead)" = 1

# ------------------------------------------------------------------------------------- timeout
scenario "a lead session that times out stops like any failed one"
d="$(new_repo timeout)"
code=0
STUB_LEAD=slow STUB_LEAD_TIMEOUT=2 run_lead "${d}" --ticket 01 >"${d}.out" 2>&1 || code=$?
expect "non-zero exit" test "${code}" != 0
expect "the timeout is named" grep -q 'timed out' "${d}.out"
expect "the session is recorded as timed-out" bash -c   "grep -q 'timed-out' '${d}'/.ralph/logs/*/sessions.tsv"
expect "the ticket is NOT blocked, nothing merged" test "$(main_status timeout)" = ready-for-agent
expect "exactly one lead session" test "$(calls timeout lead)" = 1

# ---------------------------------------------------------------------------------- interruption
scenario "an interrupted run stops the lead, keeps the work and starts nothing else"
d="$(new_repo interrupt)"
base="$(base_of interrupt)"
# The subshell below IS the driver process, so the signal reaches the driver itself.
(STUB_LEAD=slow run_lead_body "${d}" --ticket 01 >"${d}.out" 2>&1) &
runner=$!
for _ in $(seq 1 100); do
  [[ -e "${d}.calls.started" ]] && break
  sleep 0.2
done
expect "the lead started" test -e "${d}.calls.started"
kill -TERM "${runner}" 2>/dev/null || true
code=0
wait "${runner}" || code=$?
expect "the run exits non-zero" test "${code}" != 0
expect "the lead process is gone" bash -c "! kill -0 \"\$(cat '${d}.calls.pid')\" 2>/dev/null"
expect "main did not move" test "$(base_of interrupt)" = "${base}"
expect "nothing merged" no_merge interrupt
expect "the ticket is NOT blocked" test "$(status_of "${d}/issues/01-demo.md")" = ready-for-agent
expect "exactly one lead session, no Ralph agent" test \
  "$(calls interrupt lead)-$(calls interrupt agent)" = 1-0
expect "the session is recorded as interrupted" bash -c \
  "grep -q 'interrupted' '${d}'/.ralph/logs/*/sessions.tsv"
expect "the work is kept as a patch in the logs" bash -c \
  "grep -q 'partial.ts' '${d}'/.ralph/logs/*/01-demo.lead-work.patch"

scenario "a signal after the session saves the candidate and judges nothing"
d="$(new_repo late)"
base="$(base_of late)"
(STUB_LEAD=ok STUB_RED=slow run_lead_body "${d}" --ticket 01 >"${d}.out" 2>&1) &
runner=$!
for _ in $(seq 1 100); do
  [[ -e "${d}.calls.red-started" ]] && break
  sleep 0.2
done
expect "the RED proof started" test -e "${d}.calls.red-started"
kill -TERM "${runner}" 2>/dev/null || true
code=0
wait "${runner}" || code=$?
expect "the run exits non-zero" test "${code}" != 0
expect "main did not move, nothing merged" test "$(base_of late)" = "${base}"
expect "the candidate is on the slice branch again, not lost at the base" bash -c   "git -C '${d}' show slice/01-demo:feature.ts | grep -q feature"
expect "the candidate is saved as a patch" bash -c   "grep -q 'feature.ts' '${d}'/.ralph/logs/*/01-demo.lead-work.patch"
expect "the ticket is NOT blocked on main" test "$(main_status late)" = ready-for-agent
expect "the gate was never asked to approve it" test ! -e "${d}.calls.gate-ran"

# --------------------------------------------------------------------------- never starts unasked
scenario "the lead runs nothing it was not asked to: no ticket, an unready ticket, a Ralph pause"
d="$(new_repo notask)"
code=0
run_lead "${d}" >"${d}.out" 2>&1 || code=$?
expect "no --ticket is refused" test "${code}" != 0
code=0
sed -i 's/ready-for-agent/blocked/' "${d}/issues/01-demo.md"
git -C "${d}" -c user.name=t -c user.email=t@t commit --quiet -am "block"
STUB_LEAD=ok run_lead "${d}" --ticket 01 >"${d}.out" 2>&1 || code=$?
expect "a ticket that is not ready-for-agent is refused" test "${code}" != 0
expect "no lead session was started for either" test "$(calls notask lead)" = 0
sed -i 's/blocked/ready-for-agent/' "${d}/issues/01-demo.md"
git -C "${d}" -c user.name=t -c user.email=t@t commit --quiet -am "ready"
mkdir -p "${d}/.ralph/state"
echo "ticket=01" >"${d}/.ralph/state/01-demo.pause"
code=0
STUB_LEAD=ok run_lead "${d}" --ticket 01 >"${d}.out" 2>&1 || code=$?
expect "a ticket paused by the Ralph driver is not taken over" test "${code}" != 0
expect "still no lead session" test "$(calls notask lead)" = 0

# -------------------------------------------------------------------------------- readiness (ADR 0019)
scenario "the check before RED stops a candidate the base cannot load: no RED, no block, work kept"
d="$(new_repo notready)"
code=0
STUB_LEAD=undeclared run_lead "${d}" --ticket 01 >"${d}.out" 2>&1 || code=$?
expect "exit non-zero" test "${code}" != 0
expect "says what is needed" grep -q 'NEEDS PREPARATION' "${d}.out"
expect "names the import" grep -q 'brand-new' "${d}.out"
expect "RED and the gate never ran" test ! -e "${d}.calls.red-ran" -a ! -e "${d}.calls.gate-ran"
expect "nothing merged" no_merge notready
expect "the ticket is not blocked" test "$(main_status notready)" = ready-for-agent
expect "no quarantine branch" test -z "$(git -C "${d}" for-each-ref 'refs/heads/rejected/')"
expect "the work is kept as a patch" bash -c \
  "grep -q 'brand-new' '${d}'/.ralph/logs/*/01-demo.lead-work.patch"
expect "the session's lack of a hook is reported, and did not matter" \
  grep -q 'hook never fired' "${d}.out"

scenario "a check that cannot run stops the run; it is never read as a pass"
d="$(new_repo checkbroken)"
code=0
STUB_LEAD=check-broken run_lead "${d}" --ticket 01 >"${d}.out" 2>&1 || code=$?
expect "exit non-zero" test "${code}" != 0
expect "says so" grep -q 'could not run' "${d}.out"
expect "RED never ran" test ! -e "${d}.calls.red-ran"
expect "nothing merged" no_merge checkbroken
expect "the ticket is not blocked" test "$(main_status checkbroken)" = ready-for-agent

scenario "a candidate that passes the check still has to pass RED"
d="$(new_repo stillred)"
code=0
STUB_LEAD=ok STUB_RED=fail run_lead "${d}" --ticket 01 >"${d}.out" 2>&1 || code=$?
expect "RED ran and rejected it" test -e "${d}.calls.red-ran" -a "${code}" != 0
expect "the ticket is blocked as before" test "$(main_status stillred)" = blocked

scenario "a base the host already verified is not run again"
d="$(new_repo reuse)"
code=0
STUB_LEAD=ok STUB_BASELINE_KEY=current run_lead "${d}" --ticket 01 >"${d}.out" 2>&1 || code=$?
expect "merged" test "${code}" = 0
expect "no baseline run" test "$(calls reuse baseline)" = 0

scenario "a verification of other code is not reused"
d="$(new_repo stale)"
code=0
STUB_LEAD=ok STUB_BASELINE_KEY=stale run_lead "${d}" --ticket 01 >"${d}.out" 2>&1 || code=$?
expect "merged" test "${code}" = 0
expect "exactly one baseline run" test "$(calls stale baseline)" = 1

scenario "a red base stops before the session and blocks nothing"
d="$(new_repo redbase)"
code=0
STUB_LEAD=ok STUB_BASELINE=fail run_lead "${d}" --ticket 01 >"${d}.out" 2>&1 || code=$?
expect "exit non-zero" test "${code}" != 0
expect "says BLOCKED" grep -q 'BLOCKED' "${d}.out"
expect "tried once more" test "$(calls redbase baseline)" = 2
expect "no lead session" test "$(calls redbase lead)" = 0
expect "the ticket is untouched" test "$(main_status redbase)" = ready-for-agent

scenario "a flaky base is reported and the ticket goes on"
d="$(new_repo flaky)"
code=0
STUB_LEAD=ok STUB_BASELINE=flaky run_lead "${d}" --ticket 01 >"${d}.out" 2>&1 || code=$?
expect "merged" test "${code}" = 0
expect "reported" grep -q 'FLAKY' "${d}.out"

scenario "a ticket a test cannot verify never starts, and --dry-run says so without running anything"
d="$(new_repo docsonly)"
printf -- '- [ ] The limits are documented in `docs/limits.md`.\n' >>"${d}/issues/01-demo.md"
git -C "${d}" -c user.name=t -c user.email=t@t commit --quiet -am "criterion"
code=0
STUB_LEAD=ok run_lead "${d}" --ticket 01 >"${d}.out" 2>&1 || code=$?
expect "exit 5" test "${code}" = 5
expect "says what to change" grep -q 'Documentation deliverable' "${d}.out"
expect "no baseline, no lead session" test "$(calls docsonly baseline)$(calls docsonly lead)" = 00
code=0
run_lead "${d}" --ticket 01 --dry-run >"${d}.out" 2>&1 || code=$?
expect "dry run: exit 5" test "${code}" = 5
sed -i '$d' "${d}/issues/01-demo.md"
sed -i 's/ready-for-agent/blocked/' "${d}/issues/01-demo.md"
git -C "${d}" -c user.name=t -c user.email=t@t commit --quiet -am "block"
code=0
run_lead "${d}" --ticket 01 --dry-run >"${d}.out" 2>&1 || code=$?
expect "dry run on a blocked ticket: exit 1" test "${code}" = 1
expect "dry run says BLOCKED" grep -q 'BLOCKED' "${d}.out"

# ------------------------------------------------------------------------- the host's half
# sandbox.sh with Docker and its two trusted steps stubbed: what is under test is what the host
# does around them, with the default lead command, because that is what a real run has.
scenario "the host checks readiness without the lead's command, and records only a passed verification"
d="$(new_repo hostside)"
cp "${SOURCE_ROOT}/scripts/sandbox.sh" "${d}/scripts/"
echo 'process.exit(Number(process.env.STUB_VERIFY ?? 0));' >"${d}/scripts/ralph-verify.mjs"
echo 'process.exit(0);' >"${d}/scripts/ralph-accept.mjs"
git -C "${d}" -c user.name=t -c user.email=t@t add -A
git -C "${d}" -c user.name=t -c user.email=t@t commit --quiet -m "host scripts"
mkdir -p "${WORK}/hostbin"
cat >"${WORK}/hostbin/docker" <<'EOF'
#!/usr/bin/env bash
[[ "$1" != run ]] || printf '%s\n' "$@" >>"${STUB_DOCKER_ARGS}"
exit 0
EOF
# On PATH so the guard, not a missing binary, is what refuses it below. It must never run.
cat >"${WORK}/hostbin/claude" <<'EOF'
#!/usr/bin/env bash
: >"${STUB_DOCKER_ARGS}.claude-ran"
EOF
chmod +x "${WORK}/hostbin/docker" "${WORK}/hostbin/claude"

# Runs in a subshell so that clearing RALPH_* (the default lead command) stays here.
on_host() {
  (
    cd "${d}"
    while read -r name; do unset "${name}"; done < <(compgen -e | grep '^RALPH_' || true)
    export PATH="${WORK}/hostbin:${PATH}" STUB_DOCKER_ARGS="${d}.docker"
    export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@t GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@t
    "$@"
  )
}
baseline_records() { find "${d}/.ralph/baseline" -type f 2>/dev/null | wc -l | tr -d ' '; }
passed_to_container() { sed -n 's/^RALPH_BASELINE_VERIFIED=//p' "${d}.docker" | tail -n 1; }
# Ralph's own agents are set to harmless commands, so the guard reached is the lead's.
run_real_lead() {
  RALPH_AGENT_CMD=true RALPH_REVIEW_CMD=true ANTHROPIC_API_KEY=stub bash scripts/ralph-lead.sh --ticket 01
}
run_sandbox_lead() {
  RALPH_DRIVER=lead ANTHROPIC_API_KEY=stub bash scripts/sandbox.sh --ticket 01
}

code=0
on_host run_sandbox_lead >"${d}.out" 2>&1 || code=$?
expect "the default lead command passes the host's readiness step" test "${code}" = 0
expect "the container ran" grep -q '^run$' "${d}.docker"
expect "an unverified base is not reported as verified" test -z "$(passed_to_container)"

code=0
STUB_VERIFY=1 on_host bash scripts/sandbox.sh --verify >"${d}.out" 2>&1 || code=$?
expect "a failed verification fails" test "${code}" = 1
expect "a failed verification records nothing" test "$(baseline_records)" = 0

code=0
STUB_VERIFY=0 on_host bash scripts/sandbox.sh --verify >"${d}.out" 2>&1 || code=$?
expect "a passed verification passes" test "${code}" = 0
expect "a passed verification is recorded once" test "$(baseline_records)" = 1

key="$(cd "${d}" && source scripts/ralph-driver.sh && ralph_baseline_key "${PWD}/scripts/ralph-preflight.mjs" HEAD)"
on_host run_sandbox_lead >"${d}.out" 2>&1
expect "the container is told the verified key" test "$(passed_to_container)" = "${key}"

code=0
on_host run_real_lead >"${d}.out" 2>&1 || code=$?
expect "a real run outside the sandbox is still refused" test "${code}" != 0
expect "the permission guard says why" grep -q 'refusing to run a permission-skipping lead' "${d}.out"
expect "the lead never started" test ! -e "${d}.docker.claude-ran"

if ((failures > 0)); then
  echo "${failures} check(s) failed" >&2
  exit 1
fi
echo "all lead driver scenarios passed"
