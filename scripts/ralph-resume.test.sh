#!/usr/bin/env bash
#
# Provider-failure scenarios for ralph-loop.sh: usage limits, rate limits and outages must never
# cost the ticket an attempt, a review round or a rejection; a paused ticket must resume exactly
# where it stopped, through every gate it has not passed, and never from stale or forged state;
# anything not confidently a provider failure must still be judged as before.
#
# Each scenario runs the real harness (`main --once`) in a throwaway repo with a stub agent and
# the stub reviewer. Unlike scripts/ralph-loop.test.sh the gate is not a blanket pass: it fails
# until the agent has written the feature, so an attempt lost to the provider shows as a failure.
# RALPH_UNDER_TEST=<path> runs the scenarios against another harness (e.g. an older one).
set -Eeuo pipefail

SOURCE_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
readonly SOURCE_ROOT
readonly HARNESS="${RALPH_UNDER_TEST:-${SOURCE_ROOT}/ralph-loop.sh}"
WORK="$(mktemp -d)"
readonly WORK
trap 'rm -rf "${WORK}"' EXIT
failures=0

readonly USAGE_LIMIT='Claude AI usage limit reached|1762300800'
readonly OVERLOADED='API Error: 529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}'
readonly UNAUTHORIZED='API Error: 401 {"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}'

# Provider failure injection: STUB_FAIL="<phase or axis>:<usage|overload|genuine>:<times>" makes
# that phase's agent (or that axis's reviewer) fail the given number of times, counted in
# <repo>.fails, before behaving normally. Every agent run is logged as "<phase> <session>".
cat >"${WORK}/fail.sh" <<EOF
inject() {
  local target=\$1 counter="\${STUB_CALLS%.calls}.fails" spec kind times seen
  IFS=: read -r spec kind times <<<"\${STUB_FAIL:-}"
  [[ "\${spec}" == "\${target}" ]] || return 1
  seen=\$(grep -cx "\${target}" "\${counter}" 2>/dev/null || true)
  ((seen < times)) || return 1
  echo "\${target}" >>"\${counter}"
  case "\${kind}" in
    usage) echo '${USAGE_LIMIT}' ;;
    overload) echo '${OVERLOADED}' ;;
    auth) echo '${UNAUTHORIZED}' ;;
    *) echo "Error: the agent crashed" ;;
  esac
  return 0
}
EOF

cat >"${WORK}/agent.sh" <<EOF
#!/usr/bin/env bash
source "${WORK}/fail.sh"
echo "\${RALPH_PHASE} \${RALPH_SESSION_ID:-none}" >>"\${STUB_CALLS%.calls}.agent"
inject "\${RALPH_PHASE}" && exit 1
case "\${RALPH_PHASE}" in
  red) echo test >feature.test.txt ;;
  green)
    echo feature >feature.txt
    [[ "\${STUB_BUG:-0}" == 1 ]] && echo defect >bug.txt
    [[ "\${STUB_SAY_LIMIT:-0}" == 1 ]] && echo 'Done. FYI: ${USAGE_LIMIT}'
    ;;
  review-fix) rm -f bug.txt ;;
esac
exit 0
EOF

# A reviewer cut off by the provider prints Claude Code's JSON error result and exits 1.
cat >"${WORK}/reviewer.sh" <<EOF
#!/usr/bin/env bash
source "${WORK}/fail.sh"
axis=spec
[[ "\${*: -1}" == *"Standards sub-agent"* ]] && axis=standards
if message=\$(inject "\${axis}"); then
  echo "\${axis}" >>"\${STUB_CALLS}"
  printf '{"type":"result","subtype":"success","is_error":true,"result":%s}\n' \
    "\$(node -e 'console.log(JSON.stringify(process.argv[1]))' "\${message}")"
  exit 1
fi
exec node "${SOURCE_ROOT}/scripts/ralph-stub-reviewer.mjs" "\$@"
EOF

new_repo() {
  local dir="${WORK}/$1"
  mkdir -p "${dir}/scripts" "${dir}/skills/code-review" "${dir}/issues" "${dir}/docs"
  cp "${HARNESS}" "${dir}/ralph-loop.sh"
  cp "${SOURCE_ROOT}"/scripts/{ralph-review.mjs,ralph-artifacts.mjs,ralph-debt.mjs,ralph-red.mjs,ralph-provider.mjs} "${dir}/scripts/"
  printf '# Technical Debt Register\n\n<!-- ralph-debt:begin -->\n<!-- ralph-debt:end -->\n' \
    >"${dir}/docs/technical-debt.md"
  node "${dir}/scripts/ralph-debt.mjs" format "${dir}/docs/technical-debt.md"
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

# Runs one harness pass in <dir> (default: the scenario repo); prints its exit code.
run_harness() {
  local dir=$1
  shift
  (
    cd "${dir}"
    while read -r name; do unset "${name}"; done < <(compgen -e | grep '^RALPH_' || true)
    export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@t GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@t
    export RALPH_AGENT_CMD="bash ${WORK}/agent.sh" RALPH_REVIEW_CMD="bash ${WORK}/reviewer.sh"
    export RALPH_MAX_ATTEMPTS=1 RALPH_PROVIDER_RETRIES=1 RALPH_PROVIDER_BACKOFF=0
    export STUB_CALLS="${SCENARIO}.calls" "$@"
    # shellcheck source=../ralph-loop.sh
    source ./ralph-loop.sh
    # The gate fails until the feature exists; RED only needs the agent's test.
    run_gate() { : >"$1" && [[ -f feature.txt ]]; }
    verify_red() { : >"$1" && [[ -f feature.test.txt ]]; }
    main --once
  ) >>"${SCENARIO}.out" 2>&1 && echo 0 || echo $?
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

begin() {
  echo "$1:"
  SCENARIO="$(new_repo "$1")"
  scenario_failures=${failures}
}
end() { ((failures == scenario_failures)) || sed 's/^/      | /' "${SCENARIO}.out"; }

merged() { git -C "${1:-${SCENARIO}}" log --oneline main | grep -c "Merge slice/01-demo" || true; }
status_on_main() { git -C "${SCENARIO}" show "main:issues/01-demo.md" 2>/dev/null | sed -n 's/^\*\*Status:\*\* //p'; }
has_ref() { git -C "${2:-${SCENARIO}}" show-ref --quiet "refs/heads/$1"; }
quarantined() { [[ -n "$(git -C "${SCENARIO}" branch --list 'rejected/*')" ]]; }
pause_field() { sed -n "s/^$1=//p" "${SCENARIO}/.ralph/state/01-demo.pause"; }
agent_runs() { grep -c "^$1 " "${SCENARIO}.agent" || true; }
reviewer_runs() { grep -cx "$1" "${SCENARIO}.calls" || true; }
latest_run() { compgen -G "${SCENARIO}/.ralph/logs/2*" | sort | tail -n 1; }
run_status() { node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).status)' "$(latest_run)/run.json"; }
paused_cleanly() {
  check "harness exits 75 (paused)" "[[ ${1} == 75 ]]"
  check "nothing merged" "[[ \$(merged) == 0 ]]"
  check "ticket neither blocked nor done on main" "[[ \$(status_on_main) == ready-for-agent ]]"
  check "no rejection, no quarantine" "! quarantined"
  check "work parked on ralph/paused/01-demo" "has_ref ralph/paused/01-demo"
  check "run recorded as paused" "[[ \$(run_status) == paused ]]"
  check "back on main with a clean tree" \
    "[[ \$(git -C '${SCENARIO}' symbolic-ref --short HEAD) == main && -z \$(git -C '${SCENARIO}' status --porcelain) ]]"
}
resumed_and_merged() {
  check "resumed run exits 0" "[[ ${1} == 0 ]]"
  check "merged exactly once" "[[ \$(merged) == 1 ]]"
  check "ticket archived as done" \
    "git -C '${SCENARIO}' show main:issues/done/01-demo.md | grep -q '^\*\*Status:\*\* done'"
  check "pause state and parked ref cleared" \
    "[[ ! -e '${SCENARIO}/.ralph/state/01-demo.pause' ]] && ! has_ref ralph/paused/01-demo"
}

begin usage-limit-in-green-pauses-then-resumes
code="$(run_harness "${SCENARIO}" STUB_FAIL=green:usage:1)"
paused_cleanly "${code}"
check "the pause records phase green, attempt 1" \
  "[[ \$(pause_field phase) == green && \$(pause_field attempt) == 1 && \$(pause_field reason) == usage-limit ]]"
check "the parked work holds the verified RED test" \
  "git -C '${SCENARIO}' cat-file -e ralph/paused/01-demo:feature.test.txt"
code="$(run_harness "${SCENARIO}")"
resumed_and_merged "${code}"
check "RED was not rerun: it had passed its gate" "[[ \$(agent_runs red) == 1 ]]"
check "GREEN ran once more, as the same attempt 1" \
  "[[ \$(agent_runs green) == 2 ]] && grep -q 'green attempt 1/1' '${SCENARIO}.out'"
check "the resumed run still ran the final VERIFY gate" "[[ -e '$(latest_run)/01-demo.verify.gate.log' ]]"
end

# A pause in any other agent phase resumes at that phase: earlier phases are never rerun, later
# ones and every gate (review, VERIFY) always run.
for phase in red refactor docs; do
  begin "usage-limit-in-${phase}-resumes-at-${phase}"
  code="$(run_harness "${SCENARIO}" "STUB_FAIL=${phase}:usage:1")"
  paused_cleanly "${code}"
  check "the pause records phase ${phase}" "[[ \$(pause_field phase) == ${phase} ]]"
  sleep 1 # a new run id
  code="$(run_harness "${SCENARIO}")"
  resumed_and_merged "${code}"
  check "${phase} ran once more" "[[ \$(agent_runs ${phase}) == 2 ]]"
  for earlier in red green refactor; do
    [[ "${earlier}" != "${phase}" ]] || break
    check "${earlier} was not rerun" "[[ \$(agent_runs ${earlier}) == 1 ]]"
  done
  check "the resumed run was reviewed and passed VERIFY" \
    "grep -q '\"verdict\": \"approved\"' '$(latest_run)/01-demo.review-1.decision.json' &&
     [[ -e '$(latest_run)/01-demo.verify.gate.log' ]]"
  end
done

begin pause-that-cannot-park-keeps-the-work
printf '#!/bin/sh\n! grep -q "^wip(ralph): paused" "$1"\n' >"${SCENARIO}/.git/hooks/commit-msg"
chmod +x "${SCENARIO}/.git/hooks/commit-msg"
code="$(run_harness "${SCENARIO}" STUB_FAIL=green:usage:1)"
check "a failure (exit 1), never reported as paused" "[[ ${code} == 1 ]] && ! grep -q 'is parked' '${SCENARIO}.out'"
check "nothing merged, nothing rejected" "[[ \$(merged) == 0 ]] && ! quarantined"
check "no resume state is written for work that was not parked" \
  "[[ ! -e '${SCENARIO}/.ralph/state/01-demo.pause' ]] && ! has_ref ralph/paused/01-demo"
check "the work stays on the slice branch, verified RED test included" \
  "[[ \$(git -C '${SCENARIO}' symbolic-ref --short HEAD) == slice/01-demo && -f '${SCENARIO}/feature.test.txt' ]]"
check "the failure is reported" "grep -q 'could not park 01-demo' '${SCENARIO}.out'"
end

begin refused-credentials-pause-without-retrying
code="$(run_harness "${SCENARIO}" STUB_FAIL=green:auth:9)"
paused_cleanly "${code}"
check "no retry: one GREEN session" "[[ \$(agent_runs green) == 1 ]]"
check "the pause names the refused credentials" "[[ \$(pause_field reason) == auth ]]"
end

begin transient-overload-is-retried-not-counted
code="$(run_harness "${SCENARIO}" STUB_FAIL=green:overload:1)"
check "harness exits 0" "[[ ${code} == 0 ]]"
check "merged with RALPH_MAX_ATTEMPTS=1 although one session failed" "[[ \$(merged) == 1 ]]"
check "the retry was a new, separate session" \
  "[[ \$(grep '^green ' '${SCENARIO}.agent' | cut -d' ' -f2 | sort -u | wc -l) == 2 ]]"
check "the failed session is in the session log" \
  "grep -q \$'\\t01 green#1\\t.*\\tfailed\\t1\\t' '$(latest_run)/sessions.tsv'"
end

begin persistent-overload-pauses-after-bounded-retries
code="$(run_harness "${SCENARIO}" STUB_FAIL=green:overload:9)"
paused_cleanly "${code}"
check "1 retry, then the pause (2 GREEN sessions)" "[[ \$(agent_runs green) == 2 ]]"
check "the pause names the transient failure" "[[ \$(pause_field reason) == transient ]]"
end

begin genuine-agent-failure-still-counts
code="$(run_harness "${SCENARIO}" STUB_FAIL=green:genuine:1)"
check "harness exits 1" "[[ ${code} == 1 ]]"
check "rejected and quarantined as before" "quarantined && [[ \$(status_on_main) == blocked ]]"
check "nothing parked" "! has_ref ralph/paused/01-demo && [[ ! -e '${SCENARIO}/.ralph/state/01-demo.pause' ]]"
end

begin succeeding-agent-that-quotes-a-limit-is-not-paused
code="$(run_harness "${SCENARIO}" STUB_SAY_LIMIT=1)"
check "harness exits 0 and merges" "[[ ${code} == 0 && \$(merged) == 1 ]]"
check "one GREEN session" "[[ \$(agent_runs green) == 1 ]]"
end

begin reviewer-usage-limit-is-never-judged
code="$(run_harness "${SCENARIO}" STUB_FAIL=spec:usage:9 RALPH_MAX_REVIEW_ROUNDS=1)"
paused_cleanly "${code}"
first_run="$(latest_run)"
check "the round never reached the gate (no decision)" \
  "! compgen -G '${first_run}/01-demo.review-1.decision.json' >/dev/null"
check "the cut-off output is kept aside, not as a report" \
  "[[ -s '${first_run}/01-demo.review-1.spec.provider-1.json' && ! -e '${first_run}/01-demo.review-1.spec.json' ]]"
check "the pause records review round 1" "[[ \$(pause_field phase) == review && \$(pause_field round) == 1 ]]"
sleep 1 # a new run id
code="$(run_harness "${SCENARIO}" RALPH_MAX_REVIEW_ROUNDS=1)"
resumed_and_merged "${code}"
second_run="$(latest_run)"
check "no agent phase reran" "[[ \$(wc -l <'${SCENARIO}.agent') == 4 ]]"
check "round 1 was redone by both axes" \
  "[[ \$(reviewer_runs standards) == 2 && \$(reviewer_runs spec) == 2 ]]"
check "with a fresh changeset token" \
  "[[ \$(tail -n 1 '${first_run}/01-demo.review-1.diff') != \$(tail -n 1 '${second_run}/01-demo.review-1.diff') ]]"
check "and approved by the gate" \
  "grep -q '\"verdict\": \"approved\"' '${second_run}/01-demo.review-1.decision.json'"
end

begin reviewer-overload-is-retried-within-the-round
code="$(run_harness "${SCENARIO}" STUB_FAIL=spec:overload:1 RALPH_MAX_REVIEW_ROUNDS=1)"
check "harness exits 0 and merges" "[[ ${code} == 0 && \$(merged) == 1 ]]"
check "the spec axis ran twice, standards once" \
  "[[ \$(reviewer_runs spec) == 2 && \$(reviewer_runs standards) == 1 ]]"
check "only the complete report was judged" \
  "[[ -s '$(latest_run)/01-demo.review-1.spec.provider-1.json' ]] &&
   ! compgen -G '$(latest_run)/01-demo.review-1.spec.invalid.json' >/dev/null"
end

begin usage-limit-in-review-fix-resumes-with-the-findings
code="$(run_harness "${SCENARIO}" STUB_REVIEW=bug STUB_BUG=1 STUB_FAIL=review-fix:usage:9 RALPH_MAX_REVIEW_ROUNDS=2)"
paused_cleanly "${code}"
check "the pause records the fix of round 1 and its findings" \
  "[[ \$(pause_field phase) == review-fix && \$(pause_field round) == 1 ]] &&
   grep -q 'stub HIGH' '${SCENARIO}/.ralph/state/01-demo.blocking.md'"
code="$(run_harness "${SCENARIO}" STUB_REVIEW=bug STUB_BUG=1 RALPH_MAX_REVIEW_ROUNDS=2)"
resumed_and_merged "${code}"
check "the fix prompt carried round 1's findings" \
  "grep -q 'stub HIGH finding' '$(latest_run)/01-demo.resumed.blocking.md'"
check "the defect never reached main" "! git -C '${SCENARIO}' cat-file -e main:bug.txt 2>/dev/null"
check "round 2 approved the fixed tree" \
  "grep -q '\"verdict\": \"approved\"' '$(latest_run)/01-demo.review-2.decision.json'"
end

begin stale-pause-fails-closed
code="$(run_harness "${SCENARIO}" STUB_FAIL=green:usage:1)"
git -C "${SCENARIO}" -c user.name=t -c user.email=t@t commit --quiet --allow-empty -m "main moved"
code="$(run_harness "${SCENARIO}")"
check "the resume refuses (exit 1)" "[[ ${code} == 1 ]] && grep -q 'moved since 01-demo was paused' '${SCENARIO}.out'"
check "nothing merged, nothing rejected, the parked work kept" \
  "[[ \$(merged) == 0 ]] && ! quarantined && has_ref ralph/paused/01-demo && [[ -e '${SCENARIO}/.ralph/state/01-demo.pause' ]]"
end

begin forged-pause-fails-closed
code="$(run_harness "${SCENARIO}" STUB_FAIL=green:usage:1)"
git -C "${SCENARIO}" branch --quiet --force ralph/paused/01-demo main
code="$(run_harness "${SCENARIO}")"
check "a parked ref that is not what the pause recorded is refused" \
  "[[ ${code} == 1 && \$(merged) == 0 ]] && grep -q 'but the pause recorded' '${SCENARIO}.out'"
end

begin archived-ticket-is-never-merged-twice
code="$(run_harness "${SCENARIO}")"
git -C "${SCENARIO}" show main:issues/done/01-demo.md | sed 's/^\*\*Status:\*\* done/**Status:** ready-for-agent/' \
  >"${SCENARIO}/issues/01-demo.md"
git -C "${SCENARIO}" add -A
git -C "${SCENARIO}" -c user.name=t -c user.email=t@t commit --quiet -m "reintroduce 01"
code="$(run_harness "${SCENARIO}" RALPH_MAX_ATTEMPTS=1)"
check "the harness refuses" "[[ ${code} != 0 ]] && grep -q 'refusing to process it again' '${SCENARIO}.out'"
check "still merged exactly once" "[[ \$(merged) == 1 ]]"
end

# As in the sandbox: each run is a fresh clone that pushes to the host; the pause must survive.
begin sandbox-style-pause-survives-the-clone
host="${SCENARIO}"
git -C "${host}" config receive.denyCurrentBranch updateInstead
state_dir="${WORK}/sandbox-state"
git clone --quiet "${host}" "${WORK}/clone-1"
code="$(run_harness "${WORK}/clone-1" STUB_FAIL=green:usage:1 RALPH_PUSH_REMOTE=origin RALPH_STATE_DIR="${state_dir}")"
check "paused (exit 75)" "[[ ${code} == 75 ]]"
check "the parked work reached the host" "has_ref ralph/paused/01-demo '${host}'"
rm -rf "${WORK}/clone-1"
git clone --quiet "${host}" "${WORK}/clone-2"
code="$(run_harness "${WORK}/clone-2" RALPH_PUSH_REMOTE=origin RALPH_STATE_DIR="${state_dir}")"
check "a new clone resumes and merges into the host" "[[ ${code} == 0 && \$(merged '${host}') == 1 ]]"
check "RED was not rerun" "[[ \$(agent_runs red) == 1 ]]"
check "the parked ref is deleted on the host, the state cleared" \
  "! has_ref ralph/paused/01-demo '${host}' && [[ ! -e '${state_dir}/01-demo.pause' ]]"
end

if ((failures > 0)); then
  echo "ralph-loop resume scenarios: ${failures} check(s) failed" >&2
  exit 1
fi
echo "ralph-loop resume scenarios: all passed"
