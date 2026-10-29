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
# defect only with STUB_FIX=1.
cat >"${WORK}/agent.sh" <<'EOF'
#!/usr/bin/env bash
case "${RALPH_PHASE}" in
  green)
    echo feature >feature.txt
    [[ "${STUB_BUG:-0}" == 1 ]] && echo defect >bug.txt
    ;;
  review-fix) [[ "${STUB_FIX:-0}" == 1 ]] && rm -f bug.txt ;;
esac
exit 0
EOF

# Reviewer stub: prints a Claude Code JSON result per STUB_REVIEW. The axis is read from the
# prompt (last argument), the way a real reviewer learns it.
cat >"${WORK}/reviewer.sh" <<'EOF'
#!/usr/bin/env bash
prompt="${*: -1}"
axis=spec
[[ "${prompt}" == *"Standards sub-agent"* ]] && axis=standards
echo "${axis}" >>"${STUB_CALLS}"
finding() {
  printf '{"severity":"%s","file":"feature.txt","line":1,"rule":"r","title":"t","problem":"p","impact":"i","recommendation":"fix it"}' "$1"
}
findings=""
status=reviewed
case "${STUB_REVIEW}:${axis}" in
  crash:standards) exit 1 ;;
  garbage:standards) echo "LGTM, ship it"; exit 0 ;;
  error:standards)
    echo '{"type":"result","subtype":"error_max_turns","is_error":true}'
    exit 0
    ;;
  tamper:standards) echo sneaky >tampered.txt ;;
  skip:spec) status=skipped ;;
  medium:standards) findings="$(finding MEDIUM)" ;;
  critical:spec) findings="$(finding CRITICAL)" ;;
  bug:standards) [[ -f bug.txt ]] && findings="$(finding HIGH)" ;;
esac
printf '{"type":"result","subtype":"success","is_error":false,"structured_output":{"axis":"%s","status":"%s","summary":"ok","findings":[%s]}}\n' \
  "${axis}" "${status}" "${findings}"
EOF

new_repo() {
  local dir="${WORK}/$1"
  mkdir -p "${dir}/scripts" "${dir}/skills/code-review" "${dir}/issues"
  cp "${SOURCE_ROOT}/ralph-loop.sh" "${dir}/"
  cp "${SOURCE_ROOT}/scripts/ralph-review.mjs" "${dir}/scripts/"
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
    export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@t GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@t
    export RALPH_AGENT_CMD="bash ${WORK}/agent.sh" RALPH_REVIEW_CMD="bash ${WORK}/reviewer.sh"
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

merged() { git -C "$1" log --oneline main | grep -q "Merge slice/01-demo"; }
status_on_main() { git -C "$1" show main:issues/01-demo.md | sed -n 's/^\*\*Status:\*\* //p'; }
quarantined() { git -C "$1" branch --list 'rejected/*' | grep -q rejected/01-demo; }
calls() { wc -l <"$1.calls" | tr -d ' '; }

scenario() {
  local name=$1 expect=$2 expected_calls=$3
  shift 3
  local dir code
  dir="$(new_repo "${name}")"
  code="$(run_harness "${dir}" "$@")"
  echo "${name}:"
  if [[ "${expect}" == merge ]]; then
    check "harness exits 0" "[[ ${code} == 0 ]]"
    check "slice merged into main" "merged '${dir}'"
    check "ticket done on main" "[[ \$(status_on_main '${dir}') == done ]]"
    check "review report logged" "ls '${dir}'/.ralph/logs/*/01-demo.review-*.md >/dev/null 2>&1"
    check "no defect on main" "! git -C '${dir}' cat-file -e main:bug.txt 2>/dev/null"
  else
    check "harness exits non-zero" "[[ ${code} != 0 ]]"
    check "nothing merged into main" "! merged '${dir}'"
    check "feature not on main" "! git -C '${dir}' cat-file -e main:feature.txt 2>/dev/null"
    check "ticket blocked on main" "[[ \$(status_on_main '${dir}') == blocked ]]"
    check "work quarantined" "quarantined '${dir}'"
  fi
  check "${expected_calls} reviewer runs" "[[ \$(calls '${dir}') == ${expected_calls} ]]"
  if ((failures > 0)); then
    sed 's/^/      | /' "${dir}.out"
  fi
}

# Both axes run once per round, so reviewer runs = 2 x rounds.
scenario clean-passes merge 2 STUB_REVIEW=clean
scenario medium-is-not-blocking merge 2 STUB_REVIEW=medium
scenario high-blocks-until-rounds-exhausted reject 4 STUB_REVIEW=bug STUB_BUG=1 RALPH_MAX_REVIEW_ROUNDS=2
scenario critical-blocks reject 2 STUB_REVIEW=critical RALPH_MAX_REVIEW_ROUNDS=1
scenario fixed-slice-passes-re-review merge 4 STUB_REVIEW=bug STUB_BUG=1 STUB_FIX=1
scenario crashed-reviewer-is-not-approval reject 4 STUB_REVIEW=crash RALPH_MAX_REVIEW_ROUNDS=2
scenario garbage-report-is-not-approval reject 2 STUB_REVIEW=garbage RALPH_MAX_REVIEW_ROUNDS=1
scenario error-result-is-not-approval reject 2 STUB_REVIEW=error RALPH_MAX_REVIEW_ROUNDS=1
scenario skipped-axis-is-not-approval reject 2 STUB_REVIEW=skip RALPH_MAX_REVIEW_ROUNDS=1
scenario tampering-reviewer-is-not-approval reject 2 STUB_REVIEW=tamper RALPH_MAX_REVIEW_ROUNDS=1

tamper_dir="${WORK}/tampering-reviewer-is-not-approval"
echo "tampering reviewer leaves no trace:"
check "tampered file not on quarantine branch" \
  "! git -C '${tamper_dir}' log --all --name-only --format= | grep -q tampered.txt"

if ((failures > 0)); then
  echo "ralph-loop review scenarios: ${failures} check(s) failed" >&2
  exit 1
fi
echo "ralph-loop review scenarios: all passed"
