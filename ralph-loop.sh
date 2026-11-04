#!/usr/bin/env bash
#
# ralph-loop.sh: autonomous Red -> Green -> Refactor harness for the tickets in issues/.
#
# For every ticket that is `ready-for-agent` with all blockers `done`, in number order:
#
#   RED       agent writes failing test(s) only     -> gate: lint passes AND tests FAIL, run
#             uncached, and every new test file executed and at least one test failing
#   GREEN     agent implements until the gate passes -> gate: lint + typecheck + test pass
#   REFACTOR  agent cleans up without behaviour change; discarded if it breaks the gate
#   DOCS      agent runs skills/update-docs.md       -> gate must pass again
#   REVIEW    two independent, read-only reviewers (skills/code-review: Standards and Spec)
#             judge the whole changeset against the base branch, in parallel; a reviewer
#             whose report the gate finds invalid is asked once more within the round
#   FIX       blocking findings go back to the agent  -> gate, then a fresh review round
#   DEBT      the approved round's deferred (non-blocking) findings are recorded in the
#             technical debt register, docs/technical-debt.md (scripts/ralph-debt.mjs)
#   VERIFY    the full gate runs once more on the approved tree, register included
#
# A green, approved slice is squashed into ONE Conventional Commit on `slice/<NN>-<slug>` (ticket
# marked `done` and moved to issues/done/ in the same commit) and merged --no-ff into the base
# branch so dependent tickets build on it. Every agent and reviewer process is a fresh Claude
# session (fresh_session): context passes between phases and tickets only through the repository. A ticket that cannot reach RED or GREEN, or that the review does not approve, is
# quarantined on `rejected/<slug>-<ts>`, marked `blocked`, and the loop stops: later tickets may
# depend on it, so guessing onward is unsafe.
#
# The agent never touches git. The harness is the only writer, so every commit on a slice branch
# is guaranteed to have passed the gate.
#
# Provider failures are not the ticket's fault (scripts/ralph-provider.mjs classifies them from
# the CLI's own messages, and only in a session that failed). A rate limit, an overload or an
# outage is retried in a fresh session, bounded; a usage limit, refused credentials or a provider
# that stays down PAUSES the run (exit 75): the work in progress is parked on
# `ralph/paused/<slug>` with a state file in RALPH_STATE_DIR, nothing is rejected or blocked, and
# no implementation attempt or review round is spent. Running the harness again resumes the
# ticket at the interrupted phase and attempt; an interrupted review round is redone from scratch
# and never judged. Anything not confidently a provider failure is judged as before.
#
# Batches with CI between tickets: scripts/ralph-batch.mjs (`pnpm sandbox --max-tickets N`).
#
# Usage: ./ralph-loop.sh [--once] [--ticket NN] [--dry-run]
#
# Environment:
#   RALPH_AGENT_CMD      agent invocation; the prompt is appended as the last argument
#                        (default: claude -p --dangerously-skip-permissions
#                        --no-session-persistence)
#   RALPH_MAX_ATTEMPTS   attempts per phase before rejecting (default: 5)
#   RALPH_REVIEW_CMD     reviewer invocation; `--json-schema <schema>` and the prompt are
#                        appended. Must print Claude Code's JSON result or a bare report.
#                        (default: read-only claude -p, see REVIEW_CMD below)
#   RALPH_MAX_REVIEW_ROUNDS  review rounds, each but the last followed by a fix (default: 3)
#   RALPH_REVIEW_BLOCKING    severities that block the merge (default: CRITICAL,HIGH)
#   RALPH_REVIEW_TIMEOUT     seconds per reviewer process (default: 1800)
#   RALPH_TEST_RUNNER    runs Vitest inside one package, for the RED check (default:
#                        pnpm exec vitest)
#   RALPH_BASE_BRANCH    integration branch (default: main)
#   RALPH_PUSH_REMOTE    if set, push slice + base branch there after each merge, and the
#                        quarantine branch + blocked status after a rejection
#   RALPH_LOG_ROOT       where run logs go (default: .ralph/logs); the sandbox mounts the host's
#   RALPH_STATE_DIR      where a paused ticket's resume state goes (default: .ralph/state); the
#                        sandbox mounts the host's
#   RALPH_PROVIDER_RETRIES  fresh-session retries of a transient provider failure (default: 2)
#   RALPH_PROVIDER_BACKOFF  seconds before the first such retry, doubled each time (default: 60)
#   RALPH_SANDBOX=1      set by the Docker image; required for permission-skipping agents
#   RALPH_ALLOW_HOST=1   explicit, conscious override of the sandbox requirement

set -Eeuo pipefail
IFS=$'\n\t'

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly REPO_ROOT
readonly ISSUES_DIR="issues"
readonly DONE_DIR="${ISSUES_DIR}/done"
readonly BASE_BRANCH="${RALPH_BASE_BRANCH:-main}"
readonly MAX_ATTEMPTS="${RALPH_MAX_ATTEMPTS:-5}"
readonly AGENT_CMD="${RALPH_AGENT_CMD:-claude -p --dangerously-skip-permissions --no-session-persistence}"
readonly PUSH_REMOTE="${RALPH_PUSH_REMOTE:-}"
# Reviewers are read-only by construction: only the Read/Grep/Glob tools, no MCP servers, no
# settings files that could grant more. The harness still checks the tree after every review.
readonly REVIEW_CMD="${RALPH_REVIEW_CMD:-claude -p --restricted --strict-mcp-config --tools=Read,Grep,Glob --no-session-persistence --output-format=json}"
readonly MAX_REVIEW_ROUNDS="${RALPH_MAX_REVIEW_ROUNDS:-3}"
readonly REVIEW_BLOCKING="${RALPH_REVIEW_BLOCKING:-CRITICAL,HIGH}"
readonly REVIEW_TIMEOUT="${RALPH_REVIEW_TIMEOUT:-1800}"
readonly REVIEW_SCHEMA="${REPO_ROOT}/skills/code-review/report.schema.json"
readonly REVIEW_GATE="${REPO_ROOT}/scripts/ralph-review.mjs"
readonly ARTIFACTS="${REPO_ROOT}/scripts/ralph-artifacts.mjs"
readonly DEBT="${REPO_ROOT}/scripts/ralph-debt.mjs"
readonly DEBT_REGISTER="docs/technical-debt.md"
readonly RED_CHECK="${REPO_ROOT}/scripts/ralph-red.mjs"
readonly PROVIDER="${REPO_ROOT}/scripts/ralph-provider.mjs"
readonly TEST_RUNNER="${RALPH_TEST_RUNNER:-pnpm exec vitest}"
readonly STATE_DIR="${RALPH_STATE_DIR:-${REPO_ROOT}/.ralph/state}"
readonly PROVIDER_RETRIES="${RALPH_PROVIDER_RETRIES:-2}"
readonly PROVIDER_BACKOFF="${RALPH_PROVIDER_BACKOFF:-60}"
# EX_TEMPFAIL: the run stopped for the provider, not for the code; run again to resume.
readonly PAUSED_EXIT=75
RUN_ID="$(date +%Y%m%d-%H%M%S)"
readonly RUN_ID
# Temporary: changesets for the reviewers, inside the workspace they are confined to.
readonly REVIEW_ROOT="${REPO_ROOT}/.ralph/review"
# Persistent: everything needed to investigate a run later (scripts/ralph-artifacts.mjs).
readonly LOG_ROOT="${RALPH_LOG_ROOT:-${REPO_ROOT}/.ralph/logs}"
readonly LOG_DIR="${LOG_ROOT}/${RUN_ID}"
readonly FEEDBACK_LINES=150
readonly ALLOWED_COMMIT_TYPES="feat fix refactor perf test docs chore"

ONCE=false
DRY_RUN=false
ONLY_TICKET=""
CURRENT_BRANCH=""
REVIEW_FEEDBACK=""
RUN_STATUS=failed
# Agent sessions of the current ticket that ran out of context (see fresh_session).
CONTEXT_EXHAUSTIONS=0
# Why and where the current ticket paused (pause_ticket), and where a resumed one continues
# (resume_ticket). RESUME_PHASE is consumed by the phase it names.
PROVIDER_PAUSE=""
PAUSE_PHASE=""
PAUSE_ATTEMPT=1
PAUSE_ROUND=1
PAUSE_FEEDBACK=""
RESUME_PHASE=""
RESUME_ATTEMPT=1
RESUME_ROUND=1
RESUME_FEEDBACK=""
RESUME_BLOCKING=""

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
      --max-tickets)
        die "--max-tickets runs a batch with GitHub CI between tickets, which the sandbox cannot" \
          "reach: use 'pnpm sandbox --max-tickets N' (scripts/ralph-batch.mjs) on the host"
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
  [[ "${PROVIDER_RETRIES}" =~ ^[0-9]+$ ]] || die "RALPH_PROVIDER_RETRIES must be a whole number"
  [[ "${PROVIDER_BACKOFF}" =~ ^[0-9]+$ ]] || die "RALPH_PROVIDER_BACKOFF must be a whole number"
  command -v git >/dev/null || die "git is not installed"
  command -v pnpm >/dev/null || die "pnpm is not installed"
  command -v node >/dev/null || die "node is not installed"
  command -v timeout >/dev/null || die "timeout (coreutils) is not installed"
  [[ -f "${REVIEW_SCHEMA}" && -f "${REVIEW_GATE}" && -f "${ARTIFACTS}" && -f "${DEBT}" &&
    -f "${RED_CHECK}" && -f "${PROVIDER}" ]] ||
    die "review skill, review gate, artifact, debt, RED or provider script missing"
  [[ -f "${DEBT_REGISTER}" ]] || die "technical debt register ${DEBT_REGISTER} is missing"
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
    # Every Claude process gets a fresh, empty config dir (fresh_session), so a login stored in
    # the user's config is invisible to it: credentials must come from the environment.
    if [[ "${agent_argv[0]##*/}" == claude || "${review_argv[0]##*/}" == claude ]] &&
      [[ -z "${ANTHROPIC_API_KEY:-}" && -z "${CLAUDE_CODE_OAUTH_TOKEN:-}" ]]; then
      die "export ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN: each agent runs in a fresh session"
    fi
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
}

# ---------------------------------------------------------------------------------------------
# Run artifacts (retention policy: scripts/ralph-artifacts.mjs)
# ---------------------------------------------------------------------------------------------

# Expired artifacts of earlier runs go first; this run is marked active, which protects it from
# any concurrent cleanup until it finishes.
start_run() {
  node "${ARTIFACTS}" init --root "${REVIEW_ROOT}"
  node "${ARTIFACTS}" init --root "${LOG_ROOT}"
  node "${ARTIFACTS}" cleanup --review-root "${REVIEW_ROOT}" --log-root "${LOG_ROOT}" \
    --keep "${RUN_ID}"
  mkdir -p "${LOG_DIR}"
  node "${ARTIFACTS}" mark --run "${LOG_DIR}" --status active
  trap finish_run EXIT
}

# EXIT trap: records the outcome, scrubs secrets from the logs and, only for a successful run,
# drops the temporary review files (every changeset was copied into the logs when reviewed).
# Failed runs keep them for debugging until the retention period ends.
finish_run() {
  combine_sessions || true
  node "${ARTIFACTS}" mark --run "${LOG_DIR}" --status "${RUN_STATUS}" || true
  node "${ARTIFACTS}" redact --run "${LOG_DIR}" || true
  if [[ "${RUN_STATUS}" == succeeded ]]; then
    node "${ARTIFACTS}" remove --root "${REVIEW_ROOT}" --run-id "${RUN_ID}" || true
  fi
}

# ---------------------------------------------------------------------------------------------
# Ticket parsing (contract: issues/README.md)
# ---------------------------------------------------------------------------------------------

ticket_field() { sed -n "s/^\*\*$2:\*\* *//p" "$1" | head -n 1 | tr -d '\r'; }
ticket_number() { basename "$1" | cut -c1-2; }
ticket_slug() { basename "$1" .md; }
ticket_title() { sed -n 's/^# [0-9][0-9]: *//p' "$1" | head -n 1 | tr -d '\r'; }

# Active tickets live in issues/, completed ones in issues/done/; a number names exactly one file
# across both, so blockers keep resolving after their ticket is archived.
ticket_file_for() {
  local matches=() file
  for file in "${ISSUES_DIR}/$1"-*.md "${DONE_DIR}/$1"-*.md; do
    [[ -f "${file}" ]] && matches+=("${file}")
  done
  ((${#matches[@]} > 0)) || return 1
  ((${#matches[@]} == 1)) || die "ticket number $1 is ambiguous: ${matches[*]}"
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

# Ready tickets that cannot start because a blocker is not done (scripts/ralph-batch.mjs reports
# them when nothing is eligible).
waiting_tickets() {
  local file
  for file in "${ISSUES_DIR}"/[0-9][0-9]-*.md; do
    [[ -f "${file}" && "$(ticket_field "${file}" "Status")" == "ready-for-agent" ]] || continue
    blockers_done "${file}" || printf '%s\n' "${file}"
  done
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

# Full gate: Biome (warnings are errors), strict tsc, Vitest, and the technical debt register's
# rules (a resolution needs its verifying test). Stops at the first failure so the feedback
# handed to the agent is about the most fundamental problem.
run_gate() {
  local logfile=$1
  : >"${logfile}"
  run_step "${logfile}" pnpm run lint &&
    run_step "${logfile}" pnpm run typecheck &&
    run_step "${logfile}" pnpm run test &&
    run_step "${logfile}" pnpm run check:debt
}

# RED is proven only if the new tests are lint-clean AND the suite fails AND the new tests are
# what fails. A test that passes before any implementation exists asserts nothing about the
# ticket; so does one that never ran: a file outside every workspace package, unmatched by its
# package's Vitest config, failing to load, or all skipped. A cached result (Turbo replays a
# package's last run when its inputs look unchanged) must never stand in for executing them.
verify_red() {
  local logfile=$1 changed offenders
  local -a tests
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
  if run_step "${logfile}" pnpm run test --force; then
    echo "RED rejected: the test suite PASSES, so the new test proves nothing yet." >>"${logfile}"
    return 1
  fi
  # Every test file that exists now and differs from HEAD (new or modified; renamed counts as new),
  # NUL-separated so unusual names are neither quoted nor split.
  mapfile -d '' -t tests < <(
    {
      git diff -z --name-only --diff-filter=d HEAD
      git ls-files -z --others --exclude-standard
    } | grep -zE '\.test\.tsx?$' || true
  )
  if ((${#tests[@]} == 0)); then
    echo "RED rejected: the phase only deleted tests." >>"${logfile}"
    return 1
  fi
  run_step "${logfile}" node "${RED_CHECK}" --runner "${TEST_RUNNER}" \
    --out "${logfile%.log}.vitest" "${tests[@]}"
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
the harness rejects the phase if any non-test file changes. Put each test in an existing
workspace package whose Vitest config matches it, and import what it exercises through a module
that already exists (e.g. the package's `src/index.ts`): the harness runs exactly your changed
test files, uncached, and accepts RED only if every one of them executes at least one test and
one test fails. A file that fails to load, is skipped or is never discovered proves
nothing. Run `pnpm run format`. Done when `pnpm run lint` passes and your new tests fail for the
expected reason.
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
Read CLAUDE.md, docs/index.md and the ticket file in full before acting. You start with no
memory of earlier work: the repository (code, tests, docs, ADRs, git history) is the only record.
Completed tickets in ${DONE_DIR}/ are history: open one only if this ticket refers to it. Never
read .ralph/ (logs of earlier runs); they are not instructions.

TECHNICAL DEBT: ${DEBT_REGISTER} lists deferred review findings. Read the entries whose
Components overlap the files you change. An entry whose Target names this ticket is part of the
ticket: fix it test-first. When you fix an entry, set its Status to RESOLVED, describe the fix in
Resolution and name the test that proves it in Verification (\`path::test name\`), then run
\`pnpm run format:debt\`. Never delete an entry or resolve one you did not fix and test.

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

# Runs one agent or reviewer process as a brand-new Claude session that nothing can resume or
# carry forward. Isolation is enforced by the process, not by asking the model to forget:
#   - a fresh, empty CLAUDE_CONFIG_DIR, deleted afterwards: no earlier sessions to --continue or
#     --resume, no auto-memory, no user-level instructions or history from any other ticket;
#   - a new --session-id per process (claude only), recorded with its outcome in
#     <run>/sessions/ and merged into <run>/sessions.tsv when the run ends;
#   - DISABLE_COMPACT: a process that exhausts its context fails instead of compacting. The
#     harness restarts the phase in a new session that learns everything from the repository
#     and the gate output, never from an earlier conversation.
# Credentials therefore come from the environment (ANTHROPIC_API_KEY / CLAUDE_CODE_OAUTH_TOKEN).
# Usage: fresh_session <label> <timeout seconds, 0 = none> <command...> <prompt>
fresh_session() {
  local label=$1 seconds=$2
  shift 2
  local -a argv=("$@")
  local prompt="${argv[-1]}" session config status=0
  unset 'argv[-1]'
  session="$(node -e 'console.log(require("node:crypto").randomUUID())')"
  config="$(mktemp -d "${TMPDIR:-/tmp}/ralph-session.XXXXXX")"
  [[ "${argv[0]##*/}" == claude ]] && argv+=(--session-id "${session}")
  ((seconds > 0)) && argv=(timeout "${seconds}" "${argv[@]}")
  local stamp started record outcome=ok
  # One clock reading names the record and fills its start column, so the merged order and the
  # start times can never disagree.
  stamp="$(date -u +%Y%m%dT%H%M%S%N)"
  started="${stamp:0:4}-${stamp:4:2}-${stamp:6:2}T${stamp:9:2}:${stamp:11:2}:${stamp:13:2}Z"
  record="${LOG_DIR}/sessions/${stamp}-${session}.tsv"
  mkdir -p "${record%/*}"
  # Recorded before launch, so a session whose harness dies still has its record (`running`).
  session_record "${record}" "${started}" "${label}" "${session}" running - -
  CLAUDE_CONFIG_DIR="${config}" DISABLE_COMPACT=1 CLAUDE_CODE_DISABLE_AUTO_MEMORY=1 \
    RALPH_SESSION_ID="${session}" "${argv[@]}" "${prompt}" || status=$?
  rm -rf "${config}"
  if ((status == 124 && seconds > 0)); then
    outcome=timed-out
  elif ((status != 0)); then
    outcome=failed
  fi
  session_record "${record}" "${started}" "${label}" "${session}" "${outcome}" "${status}" \
    "$(date -u +%FT%TZ)"
  return "${status}"
}

# One record file per session, only ever written by that session's own fresh_session call, and
# replaced atomically: parallel reviewers never share a file, so no record is lost to interleaved
# appends. Fields: started, label, session, status, exit code, finished.
session_record() {
  local file=$1
  shift
  printf '%s\t%s\t%s\t%s\t%s\t%s\n' "$@" >"${file}.tmp"
  mv "${file}.tmp" "${file}"
}

# Merges the session records into <run>/sessions.tsv in launch order (record names start with a
# nanosecond timestamp). A session still `running` when its run ends was cut off: `interrupted`.
combine_sessions() {
  local records=("${LOG_DIR}"/sessions/*.tsv)
  [[ -f "${records[0]}" ]] || return 0
  {
    printf 'started\tlabel\tsession\tstatus\texit\tfinished\n'
    cat "${records[@]}" | sed 's/\trunning\t-\t-$/\tinterrupted\t-\t-/'
  } >"${LOG_DIR}/sessions.tsv"
}

# What Claude Code prints when a session runs out of context (compaction is disabled).
readonly CONTEXT_EXHAUSTED='Prompt is too long|context window|context length'

# The provider-failure class of a finished session: usage-limit, auth, transient or none.
# Anything the classifier cannot answer is `none`: a genuine failure, judged as before.
# Usage: provider_failure <exit code> <output file>...
provider_failure() {
  local class
  class="$(node "${PROVIDER}" classify --exit "$@" 2>/dev/null)" || class=none
  case "${class}" in
    usage-limit | auth | transient) printf '%s\n' "${class}" ;;
    *) echo none ;;
  esac
}

# What a provider failure costs: nothing. A transient one is retried in a new fresh session after
# a doubling backoff, at most RALPH_PROVIDER_RETRIES times. A usage limit or refused credentials
# cannot clear up within the run, and neither can a provider that stays down, so those pause it
# (returns 1, PROVIDER_PAUSE set). Usage: provider_retry <class> <retries so far>
provider_retry() {
  local class=$1 retry=$2 wait
  if [[ "${class}" == transient ]] && ((retry < PROVIDER_RETRIES)); then
    wait=$((PROVIDER_BACKOFF * (1 << retry)))
    log "  provider failure (${class}), not counted: retrying in a fresh session in ${wait}s" \
      "($((retry + 1))/${PROVIDER_RETRIES})"
    sleep "${wait}"
    return 0
  fi
  PROVIDER_PAUSE="${class}"
  log "  provider failure (${class}): pausing the run; nothing is counted against the ticket"
  return 1
}

# Returns 0 whatever the agent did (the gate decides), or PAUSED_EXIT after a provider failure.
run_agent() {
  local phase=$1 ticket=$2 feedback_file=$3 attempt=$4 slug output status class retry=0
  slug="$(ticket_slug "${ticket}")"
  output="${LOG_DIR}/${slug}.${phase}-${attempt}.agent.out"
  local -a agent_argv
  IFS=' ' read -r -a agent_argv <<<"${AGENT_CMD}"
  while :; do
    log "  ${phase} attempt ${attempt}/${MAX_ATTEMPTS}: running agent in a fresh session"
    status=0
    RALPH_TICKET="$(ticket_number "${ticket}")" RALPH_PHASE="${phase}" \
      fresh_session "$(ticket_number "${ticket}") ${phase}#${attempt}" 0 "${agent_argv[@]}" \
      "$(build_prompt "${phase}" "${ticket}" "${feedback_file}")" >"${output}" 2>&1 || status=$?
    cat "${output}" >>"${LOG_DIR}/${slug}.agent.log"
    class="$(provider_failure "${status}" "${output}")"
    [[ "${class}" == none ]] && break
    rm -f "${output}"
    provider_retry "${class}" "${retry}" || return "${PAUSED_EXIT}"
    retry=$((retry + 1))
  done
  # A non-zero agent exit is not fatal: the gate, not the agent's self-report, decides.
  ((status == 0)) || log "  agent exited non-zero; deferring to the gate"
  if grep -qiE "${CONTEXT_EXHAUSTED}" "${output}"; then
    CONTEXT_EXHAUSTIONS=$((CONTEXT_EXHAUSTIONS + 1))
    log "  agent ran out of context; its work stays in the tree, the next attempt starts fresh"
  fi
  rm -f "${output}"
}

# Runs `phase` until `check` succeeds, feeding each failed gate log into the next attempt.
# Returns 0 once it does, 1 when the attempts run out, PAUSED_EXIT on a provider pause (the
# interrupted attempt is recorded in PAUSE_*, to be run again, not counted).
run_phase_until() {
  local phase=$1 ticket=$2 check=$3 slug attempt=1 status
  slug="$(ticket_slug "${ticket}")"
  local gate_log="${LOG_DIR}/${slug}.${phase}.gate.log"
  local feedback="${LOG_DIR}/${slug}.${phase}.feedback.log"
  : >"${feedback}"
  # A resumed phase continues at the attempt the pause interrupted, with the gate output that
  # attempt was given: a pause never grants extra attempts.
  if [[ "${RESUME_PHASE}" == "${phase}" ]]; then
    attempt="${RESUME_ATTEMPT}"
    [[ -z "${RESUME_FEEDBACK}" ]] || cp "${RESUME_FEEDBACK}" "${feedback}"
    RESUME_PHASE=""
  fi
  for (( ; attempt <= MAX_ATTEMPTS; attempt++)); do
    status=0
    run_agent "${phase}" "${ticket}" "${feedback}" "${attempt}" || status=$?
    if ((status != 0)); then
      PAUSE_PHASE="${phase}" PAUSE_ATTEMPT="${attempt}" PAUSE_FEEDBACK="${feedback}"
      return "${status}"
    fi
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

# The acceptance criteria as the review gate numbers them (scripts/ralph-review.mjs).
numbered_criteria() {
  grep -E '^- \[[ xX]\] ' "$1" | awk '{ print "  AC" NR ": " substr($0, 7) }' || true
}

axis_brief() {
  case "$1" in
    standards)
      cat <<'EOF'
- Standards brief: judge architecture (ADRs, module boundaries, dependency direction),
  correctness (concurrency, transactions, idempotency), security (validation, authz, secrets),
  error handling, maintainability and test quality, and name integration problems with the
  existing code. `criteria` stays empty.
EOF
      ;;
    spec)
      cat <<'EOF'
- Spec brief: give every acceptance criterion above exactly one outcome in `criteria`, with the
  implementation evidence and the tests that verify it. A criterion with no test proving it is
  `unverifiable`, not `met`. Report missing or insufficient coverage and scope creep as findings.
EOF
      ;;
  esac
}

build_review_prompt() {
  local axis=$1 ticket=$2 diff_file=$3 base=$4 head=$5
  cat <<EOF
You are the ${axis^} sub-agent of the two-axis code review in skills/code-review/SKILL.md, in
its non-interactive mode, reviewing ticket ${ticket}. Read that skill file first and follow the
brief for the ${axis^} axis. You run in a fresh context, independent of the other axis.

- Commit range: base ${base}, head ${head} (copy both into \`changeset\`). The complete
  candidate changeset, \`git diff ${BASE_BRANCH}...HEAD\` annotated with source line numbers,
  is saved in full in the changeset file below. Read all of it, then whatever surrounding code
  you need.
- Changeset file: ${diff_file#"${REPO_ROOT}/"}
  Its last line is \`review-token: <value>\`; put that value in \`changeset.token\`. If you
  cannot open the file, review nothing else: say so in the summary and leave the token empty.
- Changed files (account for every one in \`files\`):
$(git diff --name-only "${BASE_BRANCH}...HEAD" | sed 's/^/  /')
- Every finding names one of those files and a line inside one of its hunks (0: whole file).
  Each hunk line of the changeset is prefixed with its OLD and NEW source line numbers: cite
  those (NEW for added or unchanged lines), never a line's position within the changeset file.
- Commits: $(git log --oneline "${BASE_BRANCH}..HEAD" | tr '\n' ';')
- Spec: the ticket ${ticket} and the spec and ADRs it references. Acceptance criteria:
$(numbered_criteria "${ticket}")
$(axis_brief "${axis}")
- Standards: discover the sources as the skill describes, starting from CLAUDE.md.
- Technical debt: ${DEBT_REGISTER} is the register of findings deferred by earlier reviews.
  Read the entries whose Components overlap the changed files. If a finding of yours is the same
  problem as an entry, set \`debt\` to its id (else ""); do not lower its severity because it
  is known. If this change makes a deferred problem worse or newly reachable, rate it by its real
  impact now, which may be HIGH or CRITICAL. If the changeset marks an entry RESOLVED, check the
  fix and its test: a resolution its Verification test does not prove is a HIGH finding.
  Cite a RESOLVED entry with an Escalation only at a blocking severity (its problem is back or
  unproven); a different, remaining concern about its fix is a new finding with \`debt\` "".
- You are read-only: do not modify any file. Return only the report matching the JSON schema.
EOF
}

# Never fails: whatever the process printed (or nothing) goes to the review gate, which judges
# anything but a valid report as invalid. A reviewer can therefore not approve by crashing.
# The one exception is a session the provider cut off: what it printed is incomplete evidence,
# so it is set aside as `<axis>.provider-<n>.json` and never judged. A transient failure is
# retried in a fresh session; otherwise the `<axis>.provider` marker makes run_review abandon
# the round unjudged (it runs in the background, so it cannot set PROVIDER_PAUSE itself).
run_reviewer() {
  local axis=$1 ticket=$2 diff_file=$3 base=$4 head=$5 out=$6 rejected=${7:-}
  local status class retry=0
  local -a review_argv
  IFS=' ' read -r -a review_argv <<<"${REVIEW_CMD}"
  while :; do
    status=0
    # Each reviewer is its own fresh session, isolated from the agent and from the other axis.
    fresh_session "$(ticket_number "${ticket}") review-${axis}" "${REVIEW_TIMEOUT}" \
      "${review_argv[@]}" --json-schema "$(cat "${REVIEW_SCHEMA}")" \
      "$(build_review_prompt "${axis}" "${ticket}" "${diff_file}" "${base}" "${head}"
        [[ -z "${rejected}" ]] || rejected_report_note "${rejected}")" \
      >"${out}" 2>"${out%.json}.stderr.log" || status=$?
    class="$(provider_failure "${status}" "${out}" "${out%.json}.stderr.log")"
    [[ "${class}" == none ]] && return 0
    mv "${out}" "${out%.json}.provider-$((retry + 1)).json"
    if ! provider_retry "${class}" "${retry}"; then
      printf '%s\n' "${class}" >"${out%.json}.provider"
      return 0
    fi
    retry=$((retry + 1))
  done
}

# True if a reviewer of this round was cut off by the provider (run_reviewer); sets PROVIDER_PAUSE.
review_paused() {
  local marker
  for marker in "$1".*.provider; do
    [[ -f "${marker}" ]] || continue
    PROVIDER_PAUSE="$(cat "${marker}")"
    return 0
  done
  return 1
}

rejected_report_note() {
  cat <<EOF
- Your previous report on this exact changeset was rejected by the review gate as invalid, for
  these reasons. Review again from scratch and return a report that follows the schema and the
  rules above; the gate's rules have not changed.
$(sed 's/^/  /' "$1")
EOF
}

# The axes whose report the gate found invalid, one per line, from the decision file.
invalid_axes() {
  node -e '
    const { errors = {} } = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
    for (const [axis, list] of Object.entries(errors)) if (list.length > 0) console.log(axis);
  ' "$1" 2>/dev/null || true
}

run_gate_on_round() {
  local ticket=$1 prefix=$2 diff_file=$3 base=$4 head=$5 slug
  slug="$(ticket_slug "${ticket}")"
  node "${REVIEW_GATE}" --block "${REVIEW_BLOCKING}" --register "${DEBT_REGISTER}" \
    --changeset "${diff_file}" --base "${base}" --head "${head}" --ticket "${ticket}" \
    --standards "${prefix}.standards.json" --spec "${prefix}.spec.json" \
    --report "${prefix}.md" --feedback "${REVIEW_FEEDBACK}" --decision "${prefix}.decision.json" \
    2>>"${LOG_DIR}/${slug}.review.log"
}

# Reviewers must not change the implementation. Anything they left behind is evidence of a
# broken sandbox, so it is discarded and the round counts as a failed review.
reviewers_tampered() {
  local head=$1 prefix=$2
  if [[ "$(git rev-parse HEAD)" != "${head}" || -n "$(git status --porcelain)" ]]; then
    git status --porcelain >"${prefix}.tampered.log"
    log "  review: a reviewer modified the repository; discarding and failing the round"
    git reset --quiet --hard "${head}"
    git clean --quiet -fd
    return 0
  fi
  return 1
}

# One review round over the committed changeset. Returns the review gate's verdict:
# 0 approved, 1 blocked (findings in REVIEW_FEEDBACK), 2 invalid; or 3 when the provider cut a
# reviewer off: the round is abandoned before the gate sees it, so it can neither approve nor
# count, and a resumed run redoes it from scratch (new changeset token, both axes).
run_review() {
  local ticket=$1 round=$2 slug prefix base head diff_file token verdict=0
  slug="$(ticket_slug "${ticket}")"
  prefix="${LOG_DIR}/${slug}.review-${round}"
  base="$(git merge-base "${BASE_BRANCH}" HEAD)"
  head="$(git rev-parse HEAD)"
  REVIEW_FEEDBACK="${prefix}.blocking.md"

  # Uncommitted work would be invisible to the reviewers and would look like tampering afterwards.
  if [[ -n "$(git status --porcelain)" ]]; then
    log "  review: the working tree is not clean before the review"
    return 2
  fi
  # The changeset goes inside the workspace (git-ignored): read-only reviewers are confined to it,
  # while LOG_DIR may be outside (the sandbox mounts the host's logs). A copy stays in the logs.
  diff_file="${REVIEW_ROOT}/${RUN_ID}/${slug}.review-${round}.diff"
  mkdir -p "${diff_file%/*}"
  git diff "${BASE_BRANCH}...HEAD" >"${diff_file}.raw"
  if [[ ! -s "${diff_file}.raw" ]]; then
    rm -f "${diff_file}.raw"
    log "  review: the changeset is empty"
    return 2
  fi
  # Every hunk line labelled with its source line numbers (see annotateChangeset), so reviewers
  # cite real lines; the gate parses the same file.
  node "${REVIEW_GATE}" --annotate "${diff_file}.raw" >"${diff_file}"
  rm -f "${diff_file}.raw"
  token="$(od -An -tx1 -N8 /dev/urandom | tr -d ' \n')"
  printf '\nreview-token: %s\n' "${token}" >>"${diff_file}"
  cp "${diff_file}" "${prefix}.diff"

  log "  review round ${round}/${MAX_REVIEW_ROUNDS}: Standards and Spec reviewers in parallel"
  run_reviewer standards "${ticket}" "${diff_file}" "${base}" "${head}" "${prefix}.standards.json" &
  local standards_pid=$!
  run_reviewer spec "${ticket}" "${diff_file}" "${base}" "${head}" "${prefix}.spec.json" &
  local spec_pid=$!
  wait "${standards_pid}" "${spec_pid}"
  reviewers_tampered "${head}" "${prefix}" && return 2
  review_paused "${prefix}" && return 3

  # The gate checks the reports' evidence against the real changeset (token, commit range, file
  # and hunk references, file coverage) and the ticket's acceptance criteria.
  run_gate_on_round "${ticket}" "${prefix}" "${diff_file}" "${base}" "${head}" || verdict=$?
  ((verdict == 2)) || return "${verdict}"

  # An invalid report says nothing about the code, yet failing the round would discard the other
  # axis's valid findings and spend a fix round on an unchanged tree. So each invalid reviewer is
  # asked once more, in a fresh session, with the gate's reasons; its first report is kept. The
  # gate then judges the new pair exactly as before: a second invalid report fails the round.
  local axis
  local -a retried=()
  for axis in $(invalid_axes "${prefix}.decision.json"); do
    node -e '
      const d = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
      console.log(d.errors[process.argv[2]].map((e) => `- ${e}`).join("\n"));
    ' "${prefix}.decision.json" "${axis}" >"${prefix}.${axis}.rejected.txt"
    mv "${prefix}.${axis}.json" "${prefix}.${axis}.invalid.json"
    log "  review: the ${axis} report is invalid; asking that reviewer once more"
    run_reviewer "${axis}" "${ticket}" "${diff_file}" "${base}" "${head}" \
      "${prefix}.${axis}.json" "${prefix}.${axis}.rejected.txt" &
    retried+=("$!")
  done
  ((${#retried[@]} > 0)) || return 2
  wait "${retried[@]}"
  reviewers_tampered "${head}" "${prefix}" && return 2
  review_paused "${prefix}" && return 3
  verdict=0
  run_gate_on_round "${ticket}" "${prefix}" "${diff_file}" "${base}" "${head}" || verdict=$?
  return "${verdict}"
}

# Review rounds until approval. Blocking findings go to a fix phase (gated like GREEN) and the
# fixed tree gets a fresh review. A failed or invalid review is never an approval; it uses up a
# round without a fix, because the code is not known to be at fault. A provider pause uses up
# nothing: it returns PAUSED_EXIT with the round to resume at in PAUSE_ROUND, and a resumed run
# re-enters at that round's review, or at its fix with the same blocking findings.
review_slice() {
  local ticket=$1 round=1 verdict status=0
  [[ "${RESUME_PHASE}" != review* ]] || round="${RESUME_ROUND}"
  [[ "${RESUME_PHASE}" != review ]] || RESUME_PHASE=""
  for (( ; round <= MAX_REVIEW_ROUNDS; round++)); do
    if [[ "${RESUME_PHASE}" == review-fix ]]; then
      REVIEW_FEEDBACK="${RESUME_BLOCKING}"
    else
      verdict=0
      run_review "${ticket}" "${round}" || verdict=$?
      case "${verdict}" in
        0)
          log "  review: approved (no ${REVIEW_BLOCKING} findings)"
          record_debt "${ticket}" "${round}" || return 1
          return 0
          ;;
        1) log "  review: blocking findings, see ${REVIEW_FEEDBACK%.blocking.md}.md" ;;
        3)
          log "  review: a reviewer was cut off by the provider; round ${round} is NOT judged"
          PAUSE_PHASE=review PAUSE_ROUND="${round}"
          return "${PAUSED_EXIT}"
          ;;
        *)
          log "  review: a reviewer failed or returned an invalid report; NOT an approval"
          continue
          ;;
      esac
      ((round < MAX_REVIEW_ROUNDS)) || break
    fi
    run_phase_until review-fix "${ticket}" run_gate || status=$?
    if ((status != 0)); then
      PAUSE_ROUND="${round}"
      return "${status}"
    fi
    checkpoint "review-fix ${round}"
  done
  return 1
}

# Records the approved round's deferred findings in the register, so they stay visible to every
# later ticket. Only the final, approved round is recorded: earlier rounds' findings were either
# fixed or are reported again in it. It runs before VERIFY, so the register change passes the
# same gate and lands in the slice's squashed commit. The base branch's register lets the script
# refuse lost entries and attest resolutions made in this slice.
record_debt() {
  local ticket=$1 round=$2 slug base_register
  slug="$(ticket_slug "${ticket}")"
  base_register="${LOG_DIR}/${slug}.debt-base.md"
  git show "${BASE_BRANCH}:${DEBT_REGISTER}" >"${base_register}"
  if ! node "${DEBT}" record --register "${DEBT_REGISTER}" \
    --decision "${LOG_DIR}/${slug}.review-${round}.decision.json" --ticket "${ticket}" \
    --run "${RUN_ID}" --round "${round}" --date "$(date -u +%F)" --base "${base_register}" \
    2>>"${LOG_DIR}/${slug}.review.log"; then
    log "  debt: could not record the review's findings, see ${LOG_DIR}/${slug}.review.log"
    return 1
  fi
  checkpoint "debt register"
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
- deferred findings recorded in ${DEBT_REGISTER}

Refs: ${ticket}
Co-Authored-By: Claude <noreply@anthropic.com>
EOF
}

# Completion happens only here, after REVIEW and VERIFY, inside the slice's own commit: the
# ticket is marked done, stamped and moved to issues/done/, so the base branch never has it
# completed without the code, and it leaves the queue (next_ticket only scans issues/).
archive_ticket() {
  local ticket=$1 branch=$2 archived
  archived="${DONE_DIR}/$(basename "${ticket}")"
  set_status "${ticket}" "done"
  sed -i "s|^\*\*Status:\*\* done.*|&\n\n**Completed:** $(date -u +%F) by ${branch} (run ${RUN_ID})|" \
    "${ticket}"
  mkdir -p "${DONE_DIR}"
  mv "${ticket}" "${archived}"
  printf '%s\n' "${archived}"
}

finalize_slice() {
  local ticket=$1 branch=$2 title archived
  title="$(ticket_title "${ticket}")"
  archived="$(archive_ticket "${ticket}" "${branch}")"
  # Squash the WIP checkpoints so the slice lands as one atomic, reviewable commit.
  git reset --quiet --soft "${BASE_BRANCH}"
  git add -A
  write_commit_message "${archived}" | git commit --quiet -F -
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
  if ((CONTEXT_EXHAUSTIONS > 0)); then
    log "  ${CONTEXT_EXHAUSTIONS} agent session(s) ran out of context: the ticket is probably" \
      "too large for one session; split it into smaller tickets (issues/README.md)"
  fi
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
  [[ -z "${PUSH_REMOTE}" ]] || push_rejection "${quarantine}"
}

# In the sandbox the clone dies with the container, so the evidence must reach the host. The
# quarantine branch is new and cannot clobber anything. The base branch only moves by fast-forward,
# and a non-bare host repo (receive.denyCurrentBranch=updateInstead) refuses it while the host has
# local changes; the blocked status then goes to a side branch instead of being lost.
push_rejection() {
  local quarantine=$1 side="ralph/blocked-${RUN_ID}"
  git push --quiet "${PUSH_REMOTE}" "${quarantine}" ||
    log "  ERROR: could not push ${quarantine} to ${PUSH_REMOTE}"
  if git push --quiet "${PUSH_REMOTE}" "${BASE_BRANCH}"; then
    log "  pushed ${quarantine} and the blocked status on ${BASE_BRANCH} to ${PUSH_REMOTE}"
  elif git push --quiet "${PUSH_REMOTE}" "${BASE_BRANCH}:refs/heads/${side}"; then
    log "  ${PUSH_REMOTE} refused ${BASE_BRANCH} (local changes or diverged); blocked status" \
      "is on ${side}: merge it into ${BASE_BRANCH} when ready"
  else
    log "  ERROR: could not push the blocked status to ${PUSH_REMOTE}"
  fi
}

# ---------------------------------------------------------------------------------------------
# Pause and resume (provider failures; see the header)
# ---------------------------------------------------------------------------------------------

state_field() { sed -n "s/^$2=//p" "$1" | head -n 1; }

# Nothing is wrong with the ticket, so it is neither rejected nor blocked: `main` is untouched and
# still shows it `ready-for-agent`. The work in progress is committed on ralph/paused/<slug>,
# directly on top of the last gated checkpoint (so the resume can tell the two apart), and pushed
# with the slice branch's other evidence so it survives the sandbox. The state file is written
# last: without it a rerun starts the ticket from scratch, which is always safe.
pause_ticket() {
  local ticket=$1 branch=$2 slug ref state gated
  slug="$(ticket_slug "${ticket}")"
  ref="ralph/paused/${slug}"
  state="${STATE_DIR}/${slug}.pause"
  gated="$(git rev-parse HEAD)"
  git add -A
  git commit --quiet --allow-empty -m "wip(ralph): paused in ${PAUSE_PHASE} (${PROVIDER_PAUSE})"
  git branch --quiet --force "${ref}" HEAD
  mkdir -p "${STATE_DIR}"
  rm -f "${state}" "${STATE_DIR}/${slug}.feedback.log" "${STATE_DIR}/${slug}.blocking.md"
  [[ ! -s "${PAUSE_FEEDBACK}" ]] || cp "${PAUSE_FEEDBACK}" "${STATE_DIR}/${slug}.feedback.log"
  [[ "${PAUSE_PHASE}" != review-fix ]] || cp "${REVIEW_FEEDBACK}" "${STATE_DIR}/${slug}.blocking.md"
  git switch --quiet "${BASE_BRANCH}"
  git branch --quiet -D "${branch}"
  CURRENT_BRANCH=""
  if [[ -n "${PUSH_REMOTE}" ]] && ! git push --quiet --force "${PUSH_REMOTE}" "${ref}"; then
    log "  ERROR: could not push ${ref} to ${PUSH_REMOTE}; the ticket will restart from scratch"
    return 0
  fi
  printf '%s\n' "ticket=$(ticket_number "${ticket}")" "ref=${ref}" \
    "base=$(git rev-parse "${BASE_BRANCH}")" "gated=${gated}" "paused=$(git rev-parse "${ref}")" \
    "phase=${PAUSE_PHASE}" "attempt=${PAUSE_ATTEMPT}" "round=${PAUSE_ROUND}" \
    "reason=${PROVIDER_PAUSE}" "run=${RUN_ID}" >"${state}.tmp"
  mv "${state}.tmp" "${state}"
  log "PAUSED ${slug} in ${PAUSE_PHASE} (${PROVIDER_PAUSE}): work parked on ${ref}, state in ${state}"
}

# Re-creates the slice branch exactly as the pause left it: the gated checkpoint committed, the
# interrupted phase's work uncommitted on top (as it was mid-phase), so that phase and every later
# one run through their gates as if never interrupted. Fails closed: the parked work is used only
# if it is precisely what the pause recorded and `main` has not moved since; otherwise a human
# decides (deleting the state file restarts the ticket from scratch).
resume_ticket() {
  local ticket=$1 branch=$2 state=$3 slug ref tip base gated paused phase attempt round
  slug="$(ticket_slug "${ticket}")"
  ref="$(state_field "${state}" ref)"
  base="$(state_field "${state}" base)"
  gated="$(state_field "${state}" gated)"
  paused="$(state_field "${state}" paused)"
  phase="$(state_field "${state}" phase)"
  attempt="$(state_field "${state}" attempt)"
  round="$(state_field "${state}" round)"
  [[ "$(state_field "${state}" ticket)" == "$(ticket_number "${ticket}")" &&
    "${ref}" == "ralph/paused/${slug}" ]] || die "${state} does not belong to ${ticket}"
  [[ "${phase}" =~ ^(red|green|refactor|docs|review|review-fix)$ &&
    "${attempt}" =~ ^[1-9][0-9]*$ && "${round}" =~ ^[1-9][0-9]*$ &&
    "${base}${gated}${paused}" =~ ^[0-9a-f]{120}$ ]] || die "${state} is malformed"
  ((attempt <= MAX_ATTEMPTS && round <= MAX_REVIEW_ROUNDS)) ||
    die "${state}: attempt ${attempt} or round ${round} exceeds the configured limits"
  tip="$(git rev-parse --verify --quiet "refs/heads/${ref}")" ||
    { [[ -n "${PUSH_REMOTE}" ]] && tip="$(git rev-parse --verify --quiet "refs/remotes/${PUSH_REMOTE}/${ref}")"; } ||
    die "${ticket} is paused, but its work ${ref} is missing; see ${state}"
  [[ "${tip}" == "${paused}" ]] || die "${ref} is at ${tip}, but the pause recorded ${paused}"
  [[ "$(git rev-parse "${paused}^")" == "${gated}" ]] ||
    die "${ref}: the parked work does not sit on the recorded checkpoint ${gated}"
  [[ "$(git rev-parse "${BASE_BRANCH}")" == "${base}" ]] ||
    die "${BASE_BRANCH} moved since ${slug} was paused on ${base}; its parked work on ${ref} is" \
      "stale. Delete ${state} to restart the ticket from scratch"
  git merge-base --is-ancestor "${base}" "${gated}" || die "${ref} does not build on ${base}"

  git switch --quiet -c "${branch}" "${paused}"
  git reset --quiet --mixed "${gated}"
  CURRENT_BRANCH="${branch}"
  RESUME_PHASE="${phase}" RESUME_ATTEMPT="${attempt}" RESUME_ROUND="${round}"
  [[ ! -f "${STATE_DIR}/${slug}.feedback.log" ]] || RESUME_FEEDBACK="${STATE_DIR}/${slug}.feedback.log"
  if [[ "${phase}" == review-fix ]]; then
    RESUME_BLOCKING="${LOG_DIR}/${slug}.resumed.blocking.md"
    cp "${STATE_DIR}/${slug}.blocking.md" "${RESUME_BLOCKING}" ||
      die "${state}: the blocking findings to fix are missing"
  fi
  log "  resuming at ${phase} (attempt ${attempt}, review round ${round}); paused by run" \
    "$(state_field "${state}" run): $(state_field "${state}" reason)"
}

# The parked work of a resumed ticket is history once it merges or is rejected.
clear_pause() {
  local slug ref
  slug="$(ticket_slug "$1")"
  ref="ralph/paused/${slug}"
  [[ -f "${STATE_DIR}/${slug}.pause" ]] || return 0
  rm -f "${STATE_DIR}/${slug}.pause" "${STATE_DIR}/${slug}.feedback.log" \
    "${STATE_DIR}/${slug}.blocking.md"
  git branch --quiet -D "${ref}" 2>/dev/null || true
  if [[ -n "${PUSH_REMOTE}" ]]; then
    git push --quiet "${PUSH_REMOTE}" --delete "${ref}" ||
      log "  could not delete ${ref} on ${PUSH_REMOTE}; it is obsolete, delete it by hand"
  fi
}

# ---------------------------------------------------------------------------------------------
# Main loop
# ---------------------------------------------------------------------------------------------

phase_rank() {
  case "$1" in
    red) echo 1 ;;
    green) echo 2 ;;
    refactor) echo 3 ;;
    docs) echo 4 ;;
    *) echo 5 ;; # review, review-fix
  esac
}
# True if the ticket still has to pass `phase`: a resumed ticket skips the phases it passed.
phase_due() { (($(phase_rank "$1") >= $(phase_rank "${2:-red}"))); }

# Ends a ticket that did not get through a phase: a provider pause parks it, anything else
# rejects it. Always returns non-zero (PAUSED_EXIT or 1).
stop_ticket() {
  local ticket=$1 branch=$2 status=$3 reason=$4
  if ((status == PAUSED_EXIT)); then
    pause_ticket "${ticket}" "${branch}"
    return "${PAUSED_EXIT}"
  fi
  reject_slice "${ticket}" "${branch}" "${reason}"
  clear_pause "${ticket}"
  return 1
}

# Runs a phase command the ticket must pass; stops the ticket if it does not.
# Usage: must_pass <ticket> <branch> <rejection reason> <command...>
must_pass() {
  local ticket=$1 branch=$2 reason=$3 status=0
  shift 3
  "$@" || status=$?
  ((status != 0)) || return 0
  stop_ticket "${ticket}" "${branch}" "${status}" "${reason}"
}

# Returns 0 when merged, 1 when rejected, PAUSED_EXIT when parked for a provider failure.
process_ticket() {
  local ticket=$1 slug branch from status=0
  slug="$(ticket_slug "${ticket}")"
  branch="slice/${slug}"
  log "Ticket ${ticket}: $(ticket_title "${ticket}")"

  # A ticket merges once: an archived copy means it already did.
  [[ ! -e "${DONE_DIR}/$(basename "${ticket}")" ]] ||
    die "${ticket} is already archived in ${DONE_DIR}/; refusing to process it again"
  git show-ref --quiet "refs/heads/${branch}" && die "branch ${branch} already exists"
  PROVIDER_PAUSE="" PAUSE_PHASE="" PAUSE_ATTEMPT=1 PAUSE_ROUND=1 PAUSE_FEEDBACK=""
  RESUME_PHASE="" RESUME_ATTEMPT=1 RESUME_ROUND=1 RESUME_FEEDBACK="" RESUME_BLOCKING=""
  CONTEXT_EXHAUSTIONS=0
  if [[ -f "${STATE_DIR}/${slug}.pause" ]]; then
    resume_ticket "${ticket}" "${branch}" "${STATE_DIR}/${slug}.pause"
  else
    git switch --quiet -c "${branch}" "${BASE_BRANCH}"
    CURRENT_BRANCH="${branch}"
    set_status "${ticket}" "in-progress"
  fi
  from="${RESUME_PHASE:-red}"

  if phase_due red "${from}"; then
    must_pass "${ticket}" "${branch}" "could not produce a valid failing test" \
      run_phase_until red "${ticket}" verify_red || return $?
  fi
  if phase_due green "${from}"; then
    must_pass "${ticket}" "${branch}" "gate still failing after ${MAX_ATTEMPTS} attempts" \
      run_phase_until green "${ticket}" run_gate || return $?
    checkpoint "green"
  fi

  # Refactoring is optional polish: if it cannot stay green it is dropped, not the slice.
  if phase_due refactor "${from}"; then
    run_phase_until refactor "${ticket}" run_gate || status=$?
    if ((status == 0)); then
      checkpoint "refactor"
    elif ((status == PAUSED_EXIT)); then
      stop_ticket "${ticket}" "${branch}" "${status}" "" || return $?
    else
      log "  refactor could not stay green; discarding it and keeping the green state"
      discard_uncommitted
    fi
  fi

  if phase_due docs "${from}"; then
    must_pass "${ticket}" "${branch}" "docs update broke the gate" \
      run_phase_until docs "${ticket}" run_gate || return $?
    # Committed so the reviewers see the complete changeset, including new files, as one diff.
    checkpoint "docs"
  fi

  must_pass "${ticket}" "${branch}" "independent review did not approve the slice" \
    review_slice "${ticket}" || return $?
  # VERIFY never runs a Claude session, so it can only pass or reject.
  if ! run_gate "${LOG_DIR}/${slug}.verify.gate.log"; then
    reject_slice "${ticket}" "${branch}" "the approved tree failed the final gate"
    clear_pause "${ticket}"
    return 1
  fi

  finalize_slice "${ticket}" "${branch}"
  clear_pause "${ticket}"
  CURRENT_BRANCH=""
}

main() {
  parse_args "$@"
  preflight

  if [[ "${DRY_RUN}" == true ]]; then
    local ticket
    if ticket="$(next_ticket)"; then
      log "dry run: next ticket would be ${ticket}"
    else
      log "dry run: no ticket is ready"
    fi
    return 0
  fi
  start_run

  local ticket processed=0 status
  while ticket="$(next_ticket)"; do
    status=0
    process_ticket "${ticket}" || status=$?
    if ((status == PAUSED_EXIT)); then
      RUN_STATUS=paused
      log "Paused: ${processed} slice(s) merged; $(ticket_slug "${ticket}") is parked" \
        "(${PROVIDER_PAUSE}). Fix the cause or wait for the limit to reset, then run the same" \
        "command again to resume it."
      exit "${PAUSED_EXIT}"
    fi
    ((status == 0)) || die "stopping: a rejected ticket needs human attention"
    processed=$((processed + 1))
    [[ "${ONCE}" == true || -n "${ONLY_TICKET}" ]] && break
  done
  RUN_STATUS=succeeded
  log "Done: ${processed} slice(s) merged. No further ticket is ready."
}

# Sourcing the script (scripts/ralph-loop.test.sh) defines the functions without running them.
if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  main "$@"
fi
