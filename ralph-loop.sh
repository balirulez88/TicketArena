#!/usr/bin/env bash
#
# ralph-loop.sh: autonomous Red -> Green -> Refactor harness for the tickets in issues/.
#
# For every ticket that is `ready-for-agent` with all blockers `done`, in number order:
#
#   RED       agent writes failing test(s) only     -> gate: lint passes AND tests FAIL
#   GREEN     agent implements until the gate passes -> gate: lint + typecheck + test pass
#   REFACTOR  agent cleans up without behaviour change; discarded if it breaks the gate
#   DOCS      agent runs skills/update-docs.md       -> gate must pass again
#   REVIEW    two independent, read-only reviewers (skills/code-review: Standards and Spec)
#             judge the whole changeset against the base branch, in parallel
#   FIX       blocking findings go back to the agent  -> gate, then a fresh review round
#   VERIFY    the full gate runs once more on the approved tree
#
# A green, approved slice is squashed into ONE Conventional Commit on `slice/<NN>-<slug>` (ticket
# marked `done` in the same commit) and merged --no-ff into the base branch so dependent tickets
# build on it. A ticket that cannot reach RED or GREEN, or that the review does not approve, is
# quarantined on `rejected/<slug>-<ts>`, marked `blocked`, and the loop stops: later tickets may
# depend on it, so guessing onward is unsafe.
#
# The agent never touches git. The harness is the only writer, so every commit on a slice branch
# is guaranteed to have passed the gate.
#
# Usage: ./ralph-loop.sh [--once] [--ticket NN] [--dry-run]
#
# Environment:
#   RALPH_AGENT_CMD      agent invocation; the prompt is appended as the last argument
#                        (default: claude -p --dangerously-skip-permissions)
#   RALPH_MAX_ATTEMPTS   attempts per phase before rejecting (default: 5)
#   RALPH_REVIEW_CMD     reviewer invocation; `--json-schema <schema>` and the prompt are
#                        appended. Must print Claude Code's JSON result or a bare report.
#                        (default: read-only claude -p, see REVIEW_CMD below)
#   RALPH_MAX_REVIEW_ROUNDS  review rounds, each but the last followed by a fix (default: 3)
#   RALPH_REVIEW_BLOCKING    severities that block the merge (default: CRITICAL,HIGH)
#   RALPH_REVIEW_TIMEOUT     seconds per reviewer process (default: 1800)
#   RALPH_BASE_BRANCH    integration branch (default: main)
#   RALPH_PUSH_REMOTE    if set, push slice + base branch there after each merge
#   RALPH_SANDBOX=1      set by the Docker image; required for permission-skipping agents
#   RALPH_ALLOW_HOST=1   explicit, conscious override of the sandbox requirement

set -Eeuo pipefail
IFS=$'\n\t'

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly REPO_ROOT
readonly ISSUES_DIR="issues"
readonly BASE_BRANCH="${RALPH_BASE_BRANCH:-main}"
readonly MAX_ATTEMPTS="${RALPH_MAX_ATTEMPTS:-5}"
readonly AGENT_CMD="${RALPH_AGENT_CMD:-claude -p --dangerously-skip-permissions}"
readonly PUSH_REMOTE="${RALPH_PUSH_REMOTE:-}"
# Reviewers are read-only by construction: only the Read/Grep/Glob tools, no MCP servers, no
# settings files that could grant more. The harness still checks the tree after every review.
readonly REVIEW_CMD="${RALPH_REVIEW_CMD:-claude -p --restricted --strict-mcp-config --tools=Read,Grep,Glob --no-session-persistence --output-format=json}"
readonly MAX_REVIEW_ROUNDS="${RALPH_MAX_REVIEW_ROUNDS:-3}"
readonly REVIEW_BLOCKING="${RALPH_REVIEW_BLOCKING:-CRITICAL,HIGH}"
readonly REVIEW_TIMEOUT="${RALPH_REVIEW_TIMEOUT:-1800}"
readonly REVIEW_SCHEMA="${REPO_ROOT}/skills/code-review/report.schema.json"
readonly REVIEW_GATE="${REPO_ROOT}/scripts/ralph-review.mjs"
RUN_ID="$(date +%Y%m%d-%H%M%S)"
readonly RUN_ID
readonly LOG_DIR="${REPO_ROOT}/.ralph/logs/${RUN_ID}"
readonly FEEDBACK_LINES=150
readonly ALLOWED_COMMIT_TYPES="feat fix refactor perf test docs chore"

ONCE=false
DRY_RUN=false
ONLY_TICKET=""
CURRENT_BRANCH=""
REVIEW_FEEDBACK=""

# ---------------------------------------------------------------------------------------------
# Utilities
# ---------------------------------------------------------------------------------------------

log() { printf '[ralph %s] %s\n' "$(date +%H:%M:%S)" "$*" >&2; }
die() {
  log "ERROR: $*"
  exit 1
}

usage() {
  sed -n '2,/^$/s/^# \{0,1\}//p' "${BASH_SOURCE[0]}"
  exit "${1:-0}"
}

on_error() {
  local exit_code=$? line=$1
  log "Unexpected failure (exit ${exit_code}) at line ${line}."
  if [[ -n "${CURRENT_BRANCH}" ]]; then
    log "Work in progress is left on branch '${CURRENT_BRANCH}' for inspection."
  fi
  exit "${exit_code}"
}
trap 'on_error ${LINENO}' ERR

parse_args() {
  while (($# > 0)); do
    case "$1" in
      --once) ONCE=true ;;
      --dry-run) DRY_RUN=true ;;
      --ticket)
        [[ $# -ge 2 && "$2" =~ ^[0-9]{2}$ ]] || die "--ticket needs a two-digit number"
        ONLY_TICKET="$2"
        shift
        ;;
      -h | --help) usage 0 ;;
      *) die "Unknown argument: $1 (see --help)" ;;
    esac
    shift
  done
}

# ---------------------------------------------------------------------------------------------
# Preflight: refuse to start in any state where a commit could be wrong or unsafe.
# ---------------------------------------------------------------------------------------------

preflight() {
  cd "${REPO_ROOT}"
  [[ "${MAX_ATTEMPTS}" =~ ^[1-9][0-9]*$ ]] || die "RALPH_MAX_ATTEMPTS must be a positive integer"
  [[ "${MAX_REVIEW_ROUNDS}" =~ ^[1-9][0-9]*$ ]] ||
    die "RALPH_MAX_REVIEW_ROUNDS must be a positive integer"
  [[ "${REVIEW_TIMEOUT}" =~ ^[1-9][0-9]*$ ]] || die "RALPH_REVIEW_TIMEOUT must be a positive integer"
  command -v git >/dev/null || die "git is not installed"
  command -v pnpm >/dev/null || die "pnpm is not installed"
  command -v node >/dev/null || die "node is not installed"
  command -v timeout >/dev/null || die "timeout (coreutils) is not installed"
  [[ -f "${REVIEW_SCHEMA}" && -f "${REVIEW_GATE}" ]] || die "review skill or gate script missing"
  git rev-parse --is-inside-work-tree >/dev/null 2>&1 || die "not a git repository"

  local branch
  branch="$(git symbolic-ref --short HEAD)"
  [[ "${branch}" == "${BASE_BRANCH}" ]] || die "must start on '${BASE_BRANCH}' (on '${branch}')"
  [[ -z "$(git status --porcelain)" ]] || die "working tree is not clean; commit or stash first"
  [[ -d "${ISSUES_DIR}" ]] || die "no ${ISSUES_DIR}/ directory"

  if [[ "${DRY_RUN}" == false ]]; then
    local -a agent_argv
    IFS=' ' read -r -a agent_argv <<<"${AGENT_CMD}"
    command -v "${agent_argv[0]}" >/dev/null || die "agent command not found: ${agent_argv[0]}"
    local -a review_argv
    IFS=' ' read -r -a review_argv <<<"${REVIEW_CMD}"
    command -v "${review_argv[0]}" >/dev/null ||
      die "review command not found: ${review_argv[0]}"
    # Fails fast on a bad policy instead of after a whole GREEN phase.
    node "${REVIEW_GATE}" --check-block "${REVIEW_BLOCKING}" ||
      die "RALPH_REVIEW_BLOCKING is invalid: ${REVIEW_BLOCKING}"

    # An agent with permission prompts disabled can run arbitrary commands. That is only
    # acceptable inside the disposable container, never on a developer machine by accident.
    if [[ "${AGENT_CMD}" == *dangerously-skip-permissions* &&
      "${RALPH_SANDBOX:-0}" != 1 && "${RALPH_ALLOW_HOST:-0}" != 1 ]]; then
      die "refusing to run a permission-skipping agent outside the sandbox; use ./scripts/sandbox.sh"
    fi
  fi
  mkdir -p "${LOG_DIR}"
}

# ---------------------------------------------------------------------------------------------
# Ticket parsing (contract: issues/README.md)
# ---------------------------------------------------------------------------------------------

ticket_field() { sed -n "s/^\*\*$2:\*\* *//p" "$1" | head -n 1 | tr -d '\r'; }
ticket_number() { basename "$1" | cut -c1-2; }
ticket_slug() { basename "$1" .md; }
ticket_title() { sed -n 's/^# [0-9][0-9]: *//p' "$1" | head -n 1 | tr -d '\r'; }

ticket_file_for() {
  local matches=("${ISSUES_DIR}/$1"-*.md)
  [[ -f "${matches[0]}" ]] || return 1
  printf '%s\n' "${matches[0]}"
}

set_status() {
  sed -i "s/^\*\*Status:\*\* .*/**Status:** $2/" "$1"
}

commit_type_for() {
  local type
  type="$(ticket_field "$1" "Type")"
  type="${type:-feat}"
  [[ " ${ALLOWED_COMMIT_TYPES} " == *" ${type} "* ]] || die "$1: invalid **Type:** '${type}'"
  printf '%s\n' "${type}"
}

blockers_done() {
  local file=$1 line number blocker
  line="$(ticket_field "${file}" "Blocked by")"
  [[ -n "${line}" ]] || die "${file}: missing '**Blocked by:**' line"
  [[ "${line}" == None* ]] && return 0

  # Parenthesised titles may contain digits; only the bare two-digit numbers are references.
  line="$(sed 's/([^)]*)//g' <<<"${line}")"
  while read -r number; do
    [[ -n "${number}" ]] || continue
    blocker="$(ticket_file_for "${number}")" || die "${file}: unknown blocker ${number}"
    [[ "$(ticket_field "${blocker}" "Status")" == "done" ]] || return 1
  done < <(grep -oE '\b[0-9]{2}\b' <<<"${line}" || true)
  return 0
}

next_ticket() {
  local file
  for file in "${ISSUES_DIR}"/[0-9][0-9]-*.md; do
    [[ -f "${file}" ]] || continue
    if [[ -n "${ONLY_TICKET}" && "$(ticket_number "${file}")" != "${ONLY_TICKET}" ]]; then
      continue
    fi
    [[ "$(ticket_field "${file}" "Status")" == "ready-for-agent" ]] || continue
    blockers_done "${file}" || continue
    printf '%s\n' "${file}"
    return 0
  done
  return 1
}

# ---------------------------------------------------------------------------------------------
# Quality gate
# ---------------------------------------------------------------------------------------------

run_step() {
  local logfile=$1
  shift
  printf '\n$ %s\n' "$*" >>"${logfile}"
  "$@" >>"${logfile}" 2>&1
}

# Full gate: Biome (warnings are errors), strict tsc, Vitest. Stops at the first failure so the
# feedback handed to the agent is about the most fundamental problem.
run_gate() {
  local logfile=$1
  : >"${logfile}"
  run_step "${logfile}" pnpm run lint &&
    run_step "${logfile}" pnpm run typecheck &&
    run_step "${logfile}" pnpm run test
}

# RED is proven only if the new tests are lint-clean AND the suite fails. A test that passes
# before any implementation exists asserts nothing about the ticket.
verify_red() {
  local logfile=$1 changed offenders
  : >"${logfile}"

  changed="$(git status --porcelain --untracked-files=all | cut -c4-)"
  if ! grep -qE '\.test\.tsx?$' <<<"${changed}"; then
    echo "RED rejected: no test file was added or modified." >>"${logfile}"
    return 1
  fi
  offenders="$(grep -vE '\.test\.tsx?$|/__fixtures__/|^issues/' <<<"${changed}" || true)"
  if [[ -n "${offenders}" ]]; then
    printf 'RED rejected: only tests may change in this phase. Revert:\n%s\n' \
      "${offenders}" >>"${logfile}"
    return 1
  fi
  run_step "${logfile}" pnpm run lint || return 1
  if run_step "${logfile}" pnpm run test; then
    echo "RED rejected: the test suite PASSES, so the new test proves nothing yet." >>"${logfile}"
    return 1
  fi
  return 0
}

# ---------------------------------------------------------------------------------------------
# Agent
# ---------------------------------------------------------------------------------------------

phase_instructions() {
  case "$1" in
    red)
      cat <<'EOF'
PHASE: RED. Follow skills/tdd.md. Write ONLY the failing test(s) for the ticket's first unmet
acceptance criterion, at a seam agreed in the spec. Do NOT write or change implementation code;
the harness rejects the phase if any non-test file changes. Run `pnpm run format`. Done when
`pnpm run lint` passes and `pnpm run test` fails for the expected reason.
EOF
      ;;
    green)
      cat <<'EOF'
PHASE: GREEN. Follow skills/implement.md and skills/tdd.md. Make the failing tests pass, then
cover every remaining acceptance criterion with further red -> green cycles. Write only the code
the tests demand. Done when `pnpm run check` passes with zero warnings.
EOF
      ;;
    refactor)
      cat <<'EOF'
PHASE: REFACTOR. The slice is green. Review your changes (`git diff main` is allowed) for Clean
Code and SOLID issues: naming, duplication, function size, module depth, missing "why" comments
on non-obvious decisions. Improve structure WITHOUT changing behaviour or tests' intent.
`pnpm run check` must still pass.
EOF
      ;;
    docs)
      cat <<'EOF'
PHASE: DOCS. Follow skills/update-docs.md for this slice. `pnpm run check` must still pass.
EOF
      ;;
    review-fix)
      cat <<'EOF'
PHASE: REVIEW FIX. Two independent reviewers (skills/code-review) blocked this slice. Fix every
finding below at its cause, with a test first where it is a behaviour bug (skills/tdd.md). Do not
argue with a finding by weakening tests or the gate, and change nothing unrelated. Keep docs
current if behaviour changes. A fresh review follows. Done when `pnpm run check` passes.

BLOCKING FINDINGS:
EOF
      cat "${REVIEW_FEEDBACK}"
      ;;
    *) die "unknown phase $1" ;;
  esac
}

build_prompt() {
  local phase=$1 ticket=$2 feedback_file=$3
  cat <<EOF
You are an autonomous engineer on TicketArena, working on ticket ${ticket}.
Read CLAUDE.md, docs/index.md and the ticket file in full before acting.

HARNESS RULES (non-negotiable):
- The harness owns git. Never run git commands that change state (commit, add, branch, switch,
  checkout, stash, reset, merge, push). Read-only git (status, diff, log) is fine.
- Never weaken the quality gate: no edits to biome.json or tsconfig strictness, no
  biome-ignore / @ts-ignore / @ts-expect-error, no skipped or deleted tests.

$(phase_instructions "${phase}")
EOF
  if [[ -s "${feedback_file}" ]]; then
    printf '\nYOUR PREVIOUS ATTEMPT FAILED THE GATE. Last %s lines of output:\n```\n' \
      "${FEEDBACK_LINES}"
    tail -n "${FEEDBACK_LINES}" "${feedback_file}"
    printf '```\nFix the cause; do not work around the check.\n'
  fi
}

run_agent() {
  local phase=$1 ticket=$2 feedback_file=$3 attempt=$4 slug
  slug="$(ticket_slug "${ticket}")"
  local -a agent_argv
  IFS=' ' read -r -a agent_argv <<<"${AGENT_CMD}"
  log "  ${phase} attempt ${attempt}/${MAX_ATTEMPTS}: running agent"
  # A non-zero agent exit is not fatal: the gate, not the agent's self-report, decides.
  RALPH_TICKET="$(ticket_number "${ticket}")" RALPH_PHASE="${phase}" \
    "${agent_argv[@]}" "$(build_prompt "${phase}" "${ticket}" "${feedback_file}")" \
    >>"${LOG_DIR}/${slug}.agent.log" 2>&1 ||
    log "  agent exited non-zero; deferring to the gate"
}

# Runs `phase` until `check` succeeds, feeding each failed gate log into the next attempt.
run_phase_until() {
  local phase=$1 ticket=$2 check=$3 slug attempt
  slug="$(ticket_slug "${ticket}")"
  local gate_log="${LOG_DIR}/${slug}.${phase}.gate.log"
  local feedback="${LOG_DIR}/${slug}.${phase}.feedback.log"
  : >"${feedback}"
  for ((attempt = 1; attempt <= MAX_ATTEMPTS; attempt++)); do
    run_agent "${phase}" "${ticket}" "${feedback}" "${attempt}"
    if "${check}" "${gate_log}"; then
      log "  ${phase}: gate satisfied"
      return 0
    fi
    cp "${gate_log}" "${feedback}"
  done
  return 1
}

# ---------------------------------------------------------------------------------------------
# Independent review (skills/code-review, run in its non-interactive mode)
# ---------------------------------------------------------------------------------------------

build_review_prompt() {
  local axis=$1 ticket=$2 diff_file=$3
  cat <<EOF
You are the ${axis^} sub-agent of the two-axis code review in skills/code-review/SKILL.md, in
its non-interactive mode, reviewing ticket ${ticket}. Read that skill file first and follow the
brief for the ${axis^} axis. You run in a fresh context, independent of the other axis.

- Fixed point: ${BASE_BRANCH} ($(git rev-parse --short "${BASE_BRANCH}")). The complete candidate
  changeset is committed on HEAD; \`git diff ${BASE_BRANCH}...HEAD\` is saved in full at
  ${diff_file#"${REPO_ROOT}/"}. Read it, then read whatever surrounding code you need.
- Commits: $(git log --oneline "${BASE_BRANCH}..HEAD" | tr '\n' ';')
- Spec: the ticket ${ticket} and the spec and ADRs it references.
- Standards: discover the sources as the skill describes, starting from CLAUDE.md.
- You are read-only: do not modify any file. Return only the report matching the JSON schema.
EOF
}

# Never fails: whatever the process printed (or nothing) goes to the review gate, which judges
# anything but a valid report as invalid. A reviewer can therefore not approve by crashing.
run_reviewer() {
  local axis=$1 ticket=$2 diff_file=$3 out=$4
  local -a review_argv
  IFS=' ' read -r -a review_argv <<<"${REVIEW_CMD}"
  timeout "${REVIEW_TIMEOUT}" "${review_argv[@]}" --json-schema "$(cat "${REVIEW_SCHEMA}")" \
    "$(build_review_prompt "${axis}" "${ticket}" "${diff_file}")" \
    >"${out}" 2>"${out%.json}.stderr.log" || true
}

# One review round over the committed changeset. Returns the review gate's verdict:
# 0 approved, 1 blocked (findings in REVIEW_FEEDBACK), 2 invalid.
run_review() {
  local ticket=$1 round=$2 slug prefix head verdict=0
  slug="$(ticket_slug "${ticket}")"
  prefix="${LOG_DIR}/${slug}.review-${round}"
  head="$(git rev-parse HEAD)"
  REVIEW_FEEDBACK="${prefix}.blocking.md"

  # Uncommitted work would be invisible to the reviewers and would look like tampering afterwards.
  if [[ -n "$(git status --porcelain)" ]]; then
    log "  review: the working tree is not clean before the review"
    return 2
  fi
  git diff "${BASE_BRANCH}...HEAD" >"${prefix}.diff"
  if [[ ! -s "${prefix}.diff" ]]; then
    log "  review: the changeset is empty"
    return 2
  fi

  log "  review round ${round}/${MAX_REVIEW_ROUNDS}: Standards and Spec reviewers in parallel"
  run_reviewer standards "${ticket}" "${prefix}.diff" "${prefix}.standards.json" &
  local standards_pid=$!
  run_reviewer spec "${ticket}" "${prefix}.diff" "${prefix}.spec.json" &
  local spec_pid=$!
  wait "${standards_pid}" "${spec_pid}"

  # Reviewers must not change the implementation. Anything they left behind is evidence of a
  # broken sandbox, so it is discarded and the round counts as a failed review.
  if [[ "$(git rev-parse HEAD)" != "${head}" || -n "$(git status --porcelain)" ]]; then
    git status --porcelain >"${prefix}.tampered.log"
    log "  review: a reviewer modified the repository; discarding and failing the round"
    git reset --quiet --hard "${head}"
    git clean --quiet -fd
    return 2
  fi

  node "${REVIEW_GATE}" --block "${REVIEW_BLOCKING}" \
    --standards "${prefix}.standards.json" --spec "${prefix}.spec.json" \
    --report "${prefix}.md" --feedback "${REVIEW_FEEDBACK}" 2>>"${LOG_DIR}/${slug}.review.log" ||
    verdict=$?
  return "${verdict}"
}

# Review rounds until approval. Blocking findings go to a fix phase (gated like GREEN) and the
# fixed tree gets a fresh review. A failed or invalid review is never an approval; it uses up a
# round without a fix, because the code is not known to be at fault.
review_slice() {
  local ticket=$1 round verdict
  for ((round = 1; round <= MAX_REVIEW_ROUNDS; round++)); do
    verdict=0
    run_review "${ticket}" "${round}" || verdict=$?
    case "${verdict}" in
      0)
        log "  review: approved (no ${REVIEW_BLOCKING} findings)"
        return 0
        ;;
      1) log "  review: blocking findings, see ${REVIEW_FEEDBACK%.blocking.md}.md" ;;
      *)
        log "  review: a reviewer failed or returned an invalid report; NOT an approval"
        continue
        ;;
    esac
    ((round < MAX_REVIEW_ROUNDS)) || break
    run_phase_until review-fix "${ticket}" run_gate || return 1
    checkpoint "review-fix ${round}"
  done
  return 1
}

# ---------------------------------------------------------------------------------------------
# Git operations (the harness is the only writer)
# ---------------------------------------------------------------------------------------------

checkpoint() {
  git add -A
  git commit --quiet --allow-empty -m "wip(ralph): $1 checkpoint"
}

discard_uncommitted() {
  git reset --quiet --hard HEAD
  git clean --quiet -fd
}

write_commit_message() {
  local ticket=$1 type title number
  type="$(commit_type_for "${ticket}")"
  title="$(ticket_title "${ticket}")"
  number="$(ticket_number "${ticket}")"
  cat <<EOF
${type}(slice-${number}): ${title}

Implements ${ticket} as a tracer-bullet vertical slice.

Quality gate passed on this exact tree:
- RED verified: new tests failed before any implementation existed
- biome ci --error-on-warnings, tsc --noEmit (strict), vitest run
- architecture docs updated (skills/update-docs.md)
- independent two-axis review (skills/code-review): no ${REVIEW_BLOCKING} findings
  in the Standards or Spec report (.ralph/logs/${RUN_ID}/)

Refs: ${ticket}
Co-Authored-By: Claude <noreply@anthropic.com>
EOF
}

finalize_slice() {
  local ticket=$1 branch=$2 title
  title="$(ticket_title "${ticket}")"
  set_status "${ticket}" "done"
  # Squash the WIP checkpoints so the slice lands as one atomic, reviewable commit.
  git reset --quiet --soft "${BASE_BRANCH}"
  git add -A
  write_commit_message "${ticket}" | git commit --quiet -F -
  git switch --quiet "${BASE_BRANCH}"
  git merge --quiet --no-ff "${branch}" -m "Merge ${branch}: ${title}"
  log "  merged ${branch} into ${BASE_BRANCH}"
  if [[ -n "${PUSH_REMOTE}" ]]; then
    git push --quiet "${PUSH_REMOTE}" "${branch}" "${BASE_BRANCH}"
    log "  pushed ${branch} and ${BASE_BRANCH} to ${PUSH_REMOTE}"
  fi
}

reject_slice() {
  local ticket=$1 branch=$2 reason=$3 quarantine
  quarantine="rejected/$(ticket_slug "${ticket}")-${RUN_ID}"
  log "REJECTED $(ticket_slug "${ticket}"): ${reason}"
  # Failing work is preserved on a quarantine branch for a human; it never reaches a slice
  # branch or the base branch.
  git add -A
  git commit --quiet --allow-empty -m "wip(ralph): rejected: ${reason}"
  git branch --quiet -m "${branch}" "${quarantine}"
  git switch --quiet "${BASE_BRANCH}"
  set_status "${ticket}" "blocked"
  git add "${ticket}"
  git commit --quiet -m "chore(issues): block ${ticket} after rejected agent run" \
    -m "Failing attempt preserved on ${quarantine}. Logs: .ralph/logs/${RUN_ID}/"
  log "  evidence on '${quarantine}', logs in ${LOG_DIR}"
}

# ---------------------------------------------------------------------------------------------
# Main loop
# ---------------------------------------------------------------------------------------------

process_ticket() {
  local ticket=$1 slug branch
  slug="$(ticket_slug "${ticket}")"
  branch="slice/${slug}"
  log "Ticket ${ticket}: $(ticket_title "${ticket}")"

  git show-ref --quiet "refs/heads/${branch}" && die "branch ${branch} already exists"
  git switch --quiet -c "${branch}" "${BASE_BRANCH}"
  CURRENT_BRANCH="${branch}"
  set_status "${ticket}" "in-progress"

  if ! run_phase_until red "${ticket}" verify_red; then
    reject_slice "${ticket}" "${branch}" "could not produce a valid failing test"
    return 1
  fi
  if ! run_phase_until green "${ticket}" run_gate; then
    reject_slice "${ticket}" "${branch}" "gate still failing after ${MAX_ATTEMPTS} attempts"
    return 1
  fi
  checkpoint "green"

  # Refactoring is optional polish: if it cannot stay green it is dropped, not the slice.
  if run_phase_until refactor "${ticket}" run_gate; then
    checkpoint "refactor"
  else
    log "  refactor could not stay green; discarding it and keeping the green state"
    discard_uncommitted
  fi

  if ! run_phase_until docs "${ticket}" run_gate; then
    reject_slice "${ticket}" "${branch}" "docs update broke the gate"
    return 1
  fi
  # Committed so the reviewers see the complete changeset, including new files, as one diff.
  checkpoint "docs"

  if ! review_slice "${ticket}"; then
    reject_slice "${ticket}" "${branch}" "independent review did not approve the slice"
    return 1
  fi
  if ! run_gate "${LOG_DIR}/${slug}.verify.gate.log"; then
    reject_slice "${ticket}" "${branch}" "the approved tree failed the final gate"
    return 1
  fi

  finalize_slice "${ticket}" "${branch}"
  CURRENT_BRANCH=""
}

main() {
  parse_args "$@"
  preflight

  local ticket processed=0
  while ticket="$(next_ticket)"; do
    if [[ "${DRY_RUN}" == true ]]; then
      log "dry run: next ticket would be ${ticket}"
      return 0
    fi
    process_ticket "${ticket}" || die "stopping: a rejected ticket needs human attention"
    processed=$((processed + 1))
    [[ "${ONCE}" == true || -n "${ONLY_TICKET}" ]] && break
  done
  log "Done: ${processed} slice(s) merged. No further ticket is ready."
}

# Sourcing the script (scripts/ralph-loop.test.sh) defines the functions without running them.
if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  main "$@"
fi
