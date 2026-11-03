#!/usr/bin/env bash
#
# Scenario tests for the review stage of ralph-loop.sh. Each scenario runs the real harness
# (`main --once`) in a throwaway git repo with a stub agent and a stub reviewer, then checks
# what reached the base branch. The quality gate is stubbed to pass: this file tests the merge
# policy around the review, not the project's own tests.
set -Eeuo pipefail

SOURCE_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
readonly SOURCE_ROOT
WORK="$(mktemp -d)"
readonly WORK
trap 'rm -rf "${WORK}"' EXIT
failures=0

# Agent stub. GREEN writes the feature and, with STUB_BUG=1, a defect. REVIEW FIX removes the
# defect only with STUB_FIX=1. STUB_DROP_DEBT=1 makes GREEN delete the register's entries.
cat >"${WORK}/agent.sh" <<'EOF'
#!/usr/bin/env bash
case "${RALPH_PHASE}" in
  green)
    echo feature >feature.txt
    [[ "${STUB_BUG:-0}" == 1 ]] && echo defect >bug.txt
    [[ "${STUB_DROP_DEBT:-0}" == 1 ]] && sed -i '/^### TD-/,/^<!-- ralph-debt:end -->/{/^<!--/!d}' docs/technical-debt.md
    ;;
  review-fix) [[ "${STUB_FIX:-0}" == 1 ]] && rm -f bug.txt ;;
esac
exit 0
EOF

new_repo() {
  local dir="${WORK}/$1"
  mkdir -p "${dir}/scripts" "${dir}/skills/code-review" "${dir}/issues" "${dir}/docs"
  cp "${SOURCE_ROOT}/ralph-loop.sh" "${dir}/"
  cp "${SOURCE_ROOT}"/scripts/{ralph-review.mjs,ralph-artifacts.mjs,ralph-debt.mjs,ralph-red.mjs} "${dir}/scripts/"
  # A register with one deferred finding from an earlier ticket.
  cat >"${dir}/docs/technical-debt.md" <<'REGISTER'
# Technical Debt Register

<!-- ralph-debt:begin -->
### TD-001: Earlier deferred finding
- **Status:** OPEN
- **Severity:** LOW
- **Source:** ticket 00
- **Evidence:** earlier review
- **Components:** `old.txt`
- **Problem:** p
- **Impact:** i
- **Justification:** non-blocking
- **Remediation:** r
<!-- ralph-debt:end -->
REGISTER
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

# Runs one harness pass; prints its exit code. Gate and RED check are stubbed to pass.
run_harness() {
  local dir=$1
  shift
  (
    cd "${dir}"
    # The caller's harness settings (e.g. RALPH_BASE_BRANCH inside the sandbox) must not leak in.
    while read -r name; do unset "${name}"; done < <(compgen -e | grep '^RALPH_' || true)
    export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@t GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@t
    export RALPH_AGENT_CMD="bash ${WORK}/agent.sh" RALPH_REVIEW_CMD="node ${SOURCE_ROOT}/scripts/ralph-stub-reviewer.mjs"
    export RALPH_MAX_ATTEMPTS=1 STUB_CALLS="${dir}.calls" "$@"
    # shellcheck source=../ralph-loop.sh
    source ./ralph-loop.sh
    run_gate() { : >"$1"; }
    verify_red() { : >"$1"; }
    main --once
  ) >"${dir}.out" 2>&1 && echo 0 || echo $?
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

merged() { git -C "$1" log --oneline main | grep "Merge slice/01-demo" >/dev/null; }
debt_on_main() { git -C "$1" show main:docs/technical-debt.md | grep -c '^### TD-' || true; }
debt_field_count() { git -C "$1" show main:docs/technical-debt.md | grep -c "$2" || true; }
status_on_main() { git -C "$1" show "main:${2:-issues}/01-demo.md" | sed -n 's/^\*\*Status:\*\* //p'; }
quarantined() { git -C "$1" branch --list 'rejected/*' | grep rejected/01-demo >/dev/null; }
calls() { wc -l <"$1.calls" | tr -d ' '; }
# The run's log dir (RALPH_LOG_ROOT=<repo>.logs in some scenarios) and temporary review dir.
run_logs() { compgen -G "$1.logs/2*" || compgen -G "$1/.ralph/logs/2*"; }
json_field() { node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"))[process.argv[2]])' "$1" "$2"; }
run_status() { json_field "$(run_logs "$1")/run.json" status; }
review_dirs() { { compgen -G "$1/.ralph/review/2*" || true; } | wc -l | tr -d ' '; }
last_verdict() {
  local decision
  decision="$(compgen -G "$(run_logs "$1")/01-demo.review-*.decision.json" | sort | tail -n 1)"
  [[ -n "${decision}" ]] && json_field "${decision}" verdict
}

scenario() {
  local name=$1 expect=$2 expected_calls=$3 verdict=$4
  shift 4
  local dir code
  dir="$(new_repo "${name}")"
  code="$(run_harness "${dir}" "$@")"
  echo "${name}:"
  if [[ "${expect}" == merge ]]; then
    check "harness exits 0" "[[ ${code} == 0 ]]"
    check "slice merged into main" "merged '${dir}'"
    check "ticket done and archived on main" "[[ \$(status_on_main '${dir}' issues/done) == done ]]"
    check "ticket left the active queue" \
      "! git -C '${dir}' cat-file -e main:issues/01-demo.md 2>/dev/null"
    check "completion recorded" \
      "git -C '${dir}' show main:issues/done/01-demo.md | grep '^\*\*Completed:\*\* .* by slice/01-demo' >/dev/null"
    check "review report logged" \
      "compgen -G '${dir}/.ralph/logs/*/01-demo.review-*.md' >/dev/null ||
        compgen -G '${dir}.logs/*/01-demo.review-*.md' >/dev/null"
    check "no defect on main" "! git -C '${dir}' cat-file -e main:bug.txt 2>/dev/null"
    check "run recorded as succeeded" "[[ \$(run_status '${dir}') == succeeded ]]"
    check "temporary review files deleted" "[[ \$(review_dirs '${dir}') == 0 ]]"
    check "reviewed changesets archived in the logs" \
      "compgen -G \"\$(run_logs '${dir}')/01-demo.review-*.diff\" >/dev/null"
  else
    check "harness exits non-zero" "[[ ${code} != 0 ]]"
    check "nothing merged into main" "! merged '${dir}'"
    check "feature not on main" "! git -C '${dir}' cat-file -e main:feature.txt 2>/dev/null"
    check "ticket blocked on main" "[[ \$(status_on_main '${dir}') == blocked ]]"
    check "work quarantined" "quarantined '${dir}'"
    check "run recorded as failed" "[[ \$(run_status '${dir}') == failed ]]"
    check "temporary review files kept for debugging" "[[ \$(review_dirs '${dir}') == 1 ]]"
  fi
  if [[ "${verdict}" != - ]]; then
    check "last review ${verdict}" "[[ \$(last_verdict '${dir}') == ${verdict} ]]"
  fi
  check "${expected_calls} reviewer runs" "[[ \$(calls '${dir}') == ${expected_calls} ]]"
  if ((failures > 0)); then
    sed 's/^/      | /' "${dir}.out"
  fi
}

# Both axes run once per round, so reviewer runs = 2 x rounds, plus one more run in each round
# for an axis whose report the gate found invalid. The fourth argument is the gate's
# verdict on the last round ("-": the gate never ran).
scenario clean-passes merge 2 approved STUB_REVIEW=clean
scenario medium-is-not-blocking merge 2 approved STUB_REVIEW=medium
scenario high-blocks-until-rounds-exhausted reject 4 blocked STUB_REVIEW=bug STUB_BUG=1 RALPH_MAX_REVIEW_ROUNDS=2
scenario critical-blocks reject 2 blocked STUB_REVIEW=critical RALPH_MAX_REVIEW_ROUNDS=1
scenario fixed-slice-passes-re-review merge 4 approved STUB_REVIEW=bug STUB_BUG=1 STUB_FIX=1
scenario unmet-criterion-blocks reject 2 blocked STUB_REVIEW=unmet RALPH_MAX_REVIEW_ROUNDS=1
scenario crashed-reviewer-is-not-approval reject 6 invalid STUB_REVIEW=crash RALPH_MAX_REVIEW_ROUNDS=2
scenario garbage-report-is-not-approval reject 3 invalid STUB_REVIEW=garbage RALPH_MAX_REVIEW_ROUNDS=1
scenario error-result-is-not-approval reject 3 invalid STUB_REVIEW=error RALPH_MAX_REVIEW_ROUNDS=1
scenario skipped-axis-is-not-approval reject 3 invalid STUB_REVIEW=skip RALPH_MAX_REVIEW_ROUNDS=1
scenario tampering-reviewer-is-not-approval reject 2 - STUB_REVIEW=tamper RALPH_MAX_REVIEW_ROUNDS=1
scenario unread-changeset-is-not-approval reject 3 invalid STUB_REVIEW=noread RALPH_MAX_REVIEW_ROUNDS=1
# Evidence that cannot be right is an invalid review, never an approval.
scenario invented-file-is-not-approval reject 3 invalid STUB_REVIEW=badfile RALPH_MAX_REVIEW_ROUNDS=1
scenario line-outside-hunks-is-not-approval reject 3 invalid STUB_REVIEW=badline RALPH_MAX_REVIEW_ROUNDS=1
scenario uncovered-file-is-not-approval reject 3 invalid STUB_REVIEW=uncovered RALPH_MAX_REVIEW_ROUNDS=1
scenario wrong-commit-range-is-not-approval reject 3 invalid STUB_REVIEW=range RALPH_MAX_REVIEW_ROUNDS=1
scenario missing-criterion-is-not-approval reject 3 invalid STUB_REVIEW=nocriteria RALPH_MAX_REVIEW_ROUNDS=1
scenario invented-test-is-not-approval reject 3 invalid STUB_REVIEW=faketest RALPH_MAX_REVIEW_ROUNDS=1
# As in the sandbox: logs outside the workspace must not take the changeset out of reach.
scenario logs-outside-workspace-still-reviewed merge 2 approved STUB_REVIEW=clean \
  RALPH_LOG_ROOT="${WORK}/logs-outside-workspace-still-reviewed.logs"
# An invalid report is asked for once more within its round, with the gate's reasons; the gate
# judges the second report as strictly as the first (a second invalid one fails the round, see
# the scenarios above). The first report stays in the logs.
scenario invalid-report-is-asked-again-once merge 3 approved STUB_REVIEW=flaky
flaky_logs="$(run_logs "${WORK}/invalid-report-is-asked-again-once")"
check "the rejected report is kept as evidence" "[[ -s '${flaky_logs}/01-demo.review-1.spec.invalid.json' ]]"
check "the second reviewer was told why" \
  "grep -q 'is met but names no test' '${flaky_logs}/01-demo.review-1.spec.rejected.txt'"
# The other axis's blocking finding is fixed after round 1, not a round later: without the second
# request, round 1 would be lost and round 2 would still find the HIGH.
scenario invalid-report-does-not-waste-the-fix merge 6 approved STUB_REVIEW=flakybug STUB_BUG=1 \
  STUB_FIX=1 RALPH_MAX_REVIEW_ROUNDS=2
# Technical debt register: deferred findings are recorded once, blockers and failures never.
scenario repeated-medium-across-rounds merge 4 approved STUB_REVIEW=bugmedium STUB_BUG=1 STUB_FIX=1
scenario unknown-debt-id-is-not-approval reject 3 invalid STUB_REVIEW=baddebt RALPH_MAX_REVIEW_ROUNDS=1
scenario dropped-debt-entry-rejects reject 2 approved STUB_REVIEW=clean STUB_DROP_DEBT=1

echo "technical debt register:"
dir="${WORK}/medium-is-not-blocking"
check "a deferred MEDIUM is recorded on main" "[[ \$(debt_on_main '${dir}') == 2 ]]"
check "it is OPEN at its original severity" \
  "git -C '${dir}' show main:docs/technical-debt.md | grep -A3 '^### TD-002' | grep -q 'Severity:\*\* MEDIUM'"
check "the register on main is canonical and valid" \
  "git -C '${dir}' show main:docs/technical-debt.md >'${dir}.register.md' &&
   node '${SOURCE_ROOT}/scripts/ralph-debt.mjs' check '${dir}.register.md' --root '${dir}'"
dir="${WORK}/repeated-medium-across-rounds"
check "one problem reported in two rounds and by both axes is one entry" \
  "[[ \$(debt_on_main '${dir}') == 2 ]]"
check "only the approved round is in its history" \
  "[[ \$(debt_field_count '${dir}' 'review-2 ') == 2 && \$(debt_field_count '${dir}' 'review-1 ') == 0 ]]"
check "the fixed HIGH blocker is not recorded" "[[ \$(debt_field_count '${dir}' 'stub HIGH') == 0 ]]"
dir="${WORK}/critical-blocks"
check "a rejected slice records nothing" "[[ \$(debt_on_main '${dir}') == 1 ]]"
dir="${WORK}/dropped-debt-entry-rejects"
check "a slice that deletes register entries keeps them on main" "[[ \$(debt_on_main '${dir}') == 1 ]]"

retry_dir="${WORK}/high-blocks-until-rounds-exhausted"
echo "review retries keep every round's evidence:"
check "both rounds' changesets still in the temporary review dir" \
  "[[ \$(compgen -G '${retry_dir}/.ralph/review/2*/01-demo.review-*.diff' | wc -l) == 2 ]]"
check "both rounds' decisions logged" \
  "[[ \$(compgen -G \"\$(run_logs '${retry_dir}')/01-demo.review-*.decision.json\" | wc -l) == 2 ]]"

# Artifacts of earlier runs, as ralph-loop.sh leaves them: a log dir with run.json and,
# unless it succeeded, a temporary review dir.
seed_run() {
  local dir=$1 id=$2 status=$3 days_ago=$4 finished
  finished="$(node -e 'console.log(new Date(Date.now() - process.argv[1] * 864e5).toISOString())' "${days_ago}")"
  mkdir -p "${dir}/.ralph/logs/${id}" "${dir}/.ralph/review/${id}"
  printf 'evidence\n' >"${dir}/.ralph/review/${id}/01-demo.review-1.diff"
  [[ "${status}" == active ]] && finished=null || finished="\"${finished}\""
  printf '{"run_id":"%s","status":"%s","started_at":"2026-01-01T00:00:00.000Z","finished_at":%s}\n' \
    "${id}" "${status}" "${finished}" >"${dir}/.ralph/logs/${id}/run.json"
}

echo "a new run cleans up expired artifacts of earlier runs only:"
life_dir="$(new_repo artifact-retention)"
seed_run "${life_dir}" 20200101-000000 failed 40   # logs expired, review files expired
seed_run "${life_dir}" 20200102-000000 failed 10   # review files expired, logs kept
seed_run "${life_dir}" 20200103-000000 failed 2    # both kept
seed_run "${life_dir}" 20200104-000000 active 400  # possibly still running: never touched
mkdir -p "${life_dir}/.ralph/logs/keep-me" "${life_dir}/.ralph/logs/20200105-000000-notes"
code="$(run_harness "${life_dir}" STUB_REVIEW=clean)"
check "harness exits 0" "[[ ${code} == 0 ]]"
check "expired logs removed" "[[ ! -e '${life_dir}/.ralph/logs/20200101-000000' ]]"
check "expired failed-run review files removed" "[[ ! -e '${life_dir}/.ralph/review/20200102-000000' ]]"
check "logs within 30 days kept" "[[ -f '${life_dir}/.ralph/logs/20200102-000000/run.json' ]]"
check "failed-run review files within 7 days kept" \
  "[[ -f '${life_dir}/.ralph/review/20200103-000000/01-demo.review-1.diff' ]]"
check "active run untouched" \
  "[[ -f '${life_dir}/.ralph/review/20200104-000000/01-demo.review-1.diff' &&
     -f '${life_dir}/.ralph/logs/20200104-000000/run.json' ]]"
check "non-run entries untouched" \
  "[[ -d '${life_dir}/.ralph/logs/keep-me' && -d '${life_dir}/.ralph/logs/20200105-000000-notes' ]]"
check "the new run's review files deleted after success" "[[ \$(review_dirs '${life_dir}') == 2 ]]"
((failures == 0)) || sed 's/^/      | /' "${life_dir}.out"

# The real RED check with stubs: the suite always fails (as it would for any unrelated reason),
# and the test runner reports the files it is given as failing on an assertion, or as failing to
# load with STUB_VITEST_LOAD_ERROR set. Only discovery and execution may decide RED then.
mkdir -p "${WORK}/bin"
cat >"${WORK}/bin/pnpm" <<'EOF'
#!/usr/bin/env bash
echo "$*" >>"${PNPM_LOG}"
case "$1 $2" in
  "run lint") exit 0 ;;
  *) exit 1 ;;
esac
EOF
chmod +x "${WORK}/bin/pnpm"
cat >"${WORK}/vitest.mjs" <<'EOF'
import { appendFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
const args = process.argv.slice(2);
appendFileSync(process.env.PNPM_LOG, `vitest ${args.join(" ")}\n`);
const out = args.find((arg) => arg.startsWith("--outputFile="))?.slice("--outputFile=".length);
const files = args.filter((arg) => !arg.startsWith("--") && arg !== "run");
const failing = [{ status: "failed", fullName: "the missing behaviour" }];
const testResults = files.map((file) =>
  process.env.STUB_VITEST_LOAD_ERROR
    ? { name: resolve(file), status: "failed", message: "Cannot find module", assertionResults: [] }
    : { name: resolve(file), status: "failed", message: "", assertionResults: failing },
);
writeFileSync(out, JSON.stringify({ testResults }));
process.exit(1);
EOF
# Native Windows node does not understand MSYS paths; elsewhere cygpath does not exist.
vitest_stub="$(cygpath -m "${WORK}/vitest.mjs" 2>/dev/null || echo "${WORK}/vitest.mjs")"

# Prints verify_red's exit code after the test files given are added to a fresh repo.
red_verdict() {
  local dir=$1
  shift
  (
    cd "${dir}"
    printf 'packages:\n  - "packages/*"\n' >pnpm-workspace.yaml
    mkdir -p packages/messaging/src
    printf '{"name":"m","scripts":{"test":"vitest run"}}\n' >packages/messaging/package.json
    git add -A && git -c user.name=t -c user.email=t@t commit --quiet -m scaffold
    for file in "$@"; do mkdir -p "$(dirname "${file}")" && echo test >"${file}"; done
    export PATH="${WORK}/bin:${PATH}" PNPM_LOG="${dir}.pnpm" RALPH_TEST_RUNNER="node ${vitest_stub}"
    # shellcheck source=../ralph-loop.sh
    source ./ralph-loop.sh
    verify_red "${dir}.red.log"
  ) >/dev/null 2>&1 && echo 0 || echo $?
}

echo "RED needs new tests that were discovered, executed and failed:"
dir="$(new_repo red-executed)"
check "a failing test in a scaffolded package proves RED" \
  "[[ \$(red_verdict '${dir}' packages/messaging/src/relay.test.ts) == 0 ]]"
check "the suite ran with the Turbo cache bypassed" "grep -qx 'run test --force' '${dir}.pnpm'"
check "the changed test file itself was run" \
  "grep -q '^vitest run .*src/relay.test.ts' '${dir}.pnpm'"
dir="$(new_repo red-undiscovered)"
check "a test in a package that does not exist yet is rejected although the suite fails" \
  "[[ \$(red_verdict '${dir}' packages/newpkg/src/relay.test.ts) != 0 ]] &&
   grep -q 'not inside a workspace package' '${dir}.red.log'"
dir="$(new_repo red-load-error)"
check "a test file that fails to load is rejected" \
  "[[ \$(STUB_VITEST_LOAD_ERROR=1 red_verdict '${dir}' packages/messaging/src/relay.test.ts) != 0 ]] &&
   grep -q 'failed to load' '${dir}.red.log'"

tamper_dir="${WORK}/tampering-reviewer-is-not-approval"
echo "tampering reviewer leaves no trace:"
check "tampered file not on quarantine branch" \
  "! git -C '${tamper_dir}' log --all --name-only --format= | grep -q tampered.txt"

if ((failures > 0)); then
  echo "ralph-loop review scenarios: ${failures} check(s) failed" >&2
  exit 1
fi
echo "ralph-loop review scenarios: all passed"
