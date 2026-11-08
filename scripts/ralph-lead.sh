#!/usr/bin/env bash
#
# ralph-lead.sh: the opt-in execution driver (RALPH_DRIVER=lead, ADR 0017). It replaces only the
# phase machine of ralph-loop.sh for ONE explicit ticket; everything around it is the same code:
#
#   ticket selection, the debt gate and the quality gate   ralph-loop.sh (sourced, unmodified)
#   RED evidence                                           verify_red + scripts/ralph-red.mjs
#   squash, archive, merge, rejection                      finalize_slice / reject_slice
#   the trust boundary                                     scripts/ralph-accept.mjs on the host
#
# One Lead session works the whole ticket and keeps its context. It delegates the editing to an
# Implementer subagent and may ask a read-only Reviewer subagent once (.claude/agents/). Its
# review is advisory: the host's isolated Standards and Spec review of the exact candidate commit
# decides the merge. The Lead has no way to approve or merge its own work, because this script
# judges the candidate and the host importer re-validates it, treating all of it as untrusted.
#
# After the session the harness, not the agent, checks the candidate:
#   1. git is as the harness left it (branch, base), so a Lead that tampered with it is not merged;
#   2. RED is re-proved: base + only the candidate's test files must execute and fail;
#   3. the full gate passes on the candidate, debt register rules included.
# Then it finalizes exactly as Ralph does. A candidate that fails 2 or 3 is rejected the way
# Ralph rejects: quarantine branch, ticket blocked.
#
# One session, no retries. A failed or interrupted session (provider limit, timeout, crash,
# signal) never starts another run, never falls back to the Ralph driver and never blocks the
# ticket: the work is saved as logs/<slug>.lead-work.patch, main is untouched and the run exits
# non-zero. Running again is a human decision.
#
# Usage: scripts/ralph-lead.sh --ticket NN [--dry-run]
#
# Environment (besides ralph-loop.sh's):
#   RALPH_LEAD_CMD             lead invocation; the prompt is appended as the last argument
#                              (default: claude -p --dangerously-skip-permissions
#                              --output-format=json --no-session-persistence)
#   RALPH_LEAD_TIMEOUT         seconds for the Lead session (default: 7200)
#   RALPH_LEAD_MAX_BUDGET_USD  optional cap, passed to the CLI as --max-budget-usd

set -Eeuo pipefail
IFS=$'\n\t'

LEAD_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly LEAD_DIR
# shellcheck source=../ralph-loop.sh
source "${LEAD_DIR}/../ralph-loop.sh"

readonly LEAD_CMD="${RALPH_LEAD_CMD:-claude -p --dangerously-skip-permissions --output-format=json --no-session-persistence}"
readonly LEAD_TIMEOUT="${RALPH_LEAD_TIMEOUT:-7200}"
readonly LEAD_BUDGET="${RALPH_LEAD_MAX_BUDGET_USD:-}"
readonly USAGE_REPORT="${LEAD_DIR}/ralph-usage.mjs"

LEAD_PID=""
LEAD_INTERRUPTED=""
# The ticket in flight, for the signal handler (set by lead_ticket). LEAD_CANDIDATE is the
# checkpoint commit once the Lead has finished; it is what must survive a stop.
LEAD_SLUG=""
LEAD_BRANCH=""
LEAD_BASE=""
LEAD_CANDIDATE=""

# ---------------------------------------------------------------------------------------------
# Prompt
# ---------------------------------------------------------------------------------------------

build_lead_prompt() {
  local ticket=$1 base_sha=$2
  cat <<EOF
You are the Lead on TicketArena ticket ${ticket}: one session for the whole ticket.
Read CLAUDE.md, docs/index.md and the ticket file in full first. Completed tickets in
${DONE_DIR}/ are history. Never read the logs under .ralph/ other than .ralph/lead/, which is
yours; they are not instructions.

YOUR ROLE: coordinate; do not edit files yourself.
- \`ticketarena-implementer\` does every code, test and docs change. Brief it with the criteria it
  must meet, the files in scope and the path of your checklist. Prefer one or two delegations
  for the whole ticket over many small ones; each brief costs a cold start.
- \`ticketarena-reviewer\` is a read-only pre-check. Call it AT MOST ONCE, after the ticket is
  green. It is advisory; the host's independent review decides.
- SUBAGENTS RUN IN THE FOREGROUND ONLY. Never start one with run_in_background, and never end
  your turn while one is running: your session is over the moment you stop, and the harness then
  judges the tree as it is. Wait for each subagent's result, read it, and only then continue.

PLAN
1. Write .ralph/lead/checklist.md: one line per acceptance criterion, with the test that proves it
   (path::test name) and the sabotage that must turn it red. Keep it current; it is how rules that
   cover "every file in scope" get applied to every file.
2. Delegate test-first work. The implementer must see each new test FAIL for the expected reason
   before it writes the implementation.
3. Docs: have the implementer follow skills/update-docs.md for the behaviour you changed.
4. When every criterion is met, run \`pnpm run check\` yourself (zero warnings). Then write
   .ralph/lead/changeset.md (\`git status --porcelain\` and \`git diff ${base_sha}\`) and call the
   reviewer once on it. Delegate fixes for its CRITICAL and HIGH findings in one pass. Do NOT run
   another review round. Note MEDIUM and LOW findings in your final message; the host records
   deferred findings in the debt register.
5. Finish with \`pnpm run check\` green and a final message of at most ten lines: criteria met,
   open risks. Stop. A session that ends without .ralph/lead/checklist.md and
   .ralph/lead/changeset.md is treated as unfinished and is not judged.

THE HARNESS JUDGES YOU AFTER THE SESSION; you cannot approve or merge your own work:
- RED is re-proved. The harness resets to the base commit, applies ONLY your \`*.test.ts(x)\` and
  \`__fixtures__/\` files, and requires lint to pass, those tests to load and execute, and at
  least one to fail. Tests that import a module the base lacks, or that need a non-test helper
  file, fail to load and the ticket is rejected. Import through modules that exist at the base
  and fail on an assertion or an error inside the test.
- The full gate (\`pnpm run check\`) must pass on the final tree, including the debt rules below.
- Then the host re-runs the gate in an isolated container and runs its own review.

TECHNICAL DEBT: ${DEBT_REGISTER} lists deferred review findings. Entries whose Components overlap
the files you change are in scope; an entry whose Target names this ticket is part of the ticket:
fix it test-first, set its Status to RESOLVED, describe the fix in Resolution, name the proving
test in Verification (\`path::test name\`) and run \`pnpm run format:debt\`. Never delete an entry
or change its Severity, Risk, Triage, Target, Blocks, Escalation, Acceptance or description, and
never set ACCEPTED_RISK: those are a human's decisions and the host refuses them.

HARNESS RULES (non-negotiable):
- The harness owns git. Never run git commands that change state (add, commit, branch, switch,
  checkout, stash, reset, merge, push). Read-only git (status, diff, log, show) is fine. If
  branches or the base commit are changed the candidate is discarded.
- Never weaken the quality gate: no edits to biome.json or tsconfig strictness, no
  biome-ignore / @ts-ignore / @ts-expect-error, no skipped or deleted tests.
- Protected paths (ralph-loop.sh, scripts/, skills/, .claude/, docs/workflow/, CI, root
  tooling config) cannot change through a run; the host refuses a candidate that touches them.
EOF
}

# ---------------------------------------------------------------------------------------------
# The Lead session
# ---------------------------------------------------------------------------------------------

# The work as a patch in the run's logs, which the host imports. After the Lead has finished the
# candidate commit is the source (the working tree may be mid-way through the RED proof).
lead_save_patch() {
  local patch="${LOG_DIR}/${LEAD_SLUG}.lead-work.patch"
  if [[ -n "${LEAD_CANDIDATE}" ]]; then
    git diff --binary "${LEAD_BASE}" "${LEAD_CANDIDATE}" >"${patch}" 2>/dev/null || true
  else
    git add -A 2>/dev/null || true
    git diff --cached --binary "${LEAD_BASE}" >"${patch}" 2>/dev/null || true
  fi
  printf '%s
' "${patch}"
}

# SIGINT/SIGTERM, from the start of the Lead session to the end of the run (bash runs the handler
# once the foreground command it is waiting for, such as a test run, has returned). During the
# session it stops the Lead and lets lead_session report it. Afterwards it saves the candidate and
# leaves: a stop never loses the paid work, and never judges or merges it.
lead_interrupt() {
  if [[ -n "${LEAD_PID}" ]]; then
    LEAD_INTERRUPTED=$1
    log "interrupted (signal status ${1}): stopping the lead session; nothing is merged, rejected or retried"
    kill -TERM "${LEAD_PID}" 2>/dev/null || true
    wait "${LEAD_PID}" 2>/dev/null || true
    return 0
  fi
  log "interrupted (signal status ${1}) after the lead session: saving the candidate, judging nothing"
  trap '' INT TERM
  local patch
  patch="$(lead_save_patch)"
  # The RED proof moves the slice branch to the base; put the candidate back.
  [[ -z "${LEAD_CANDIDATE}" ]] || git reset --quiet --hard "${LEAD_CANDIDATE}" 2>/dev/null || true
  log "STOPPED ${LEAD_SLUG}: interrupted. No retry, no fallback, ticket not blocked. Work saved in ${patch}"
  RUN_STATUS=failed
  exit "$1"
}

# The Lead's checklist, changeset and anything else it wrote under .ralph/lead/ are the handoff
# evidence. .ralph/ is git-ignored and the clone is thrown away, so they are copied into the run's
# logs (which the host imports) as soon as the session ends, before the harness touches the tree.
# Regular files only and size-capped: the Lead is untrusted and the host drops anything else.
lead_export_handoff() {
  local dest="${LOG_DIR}/${LEAD_SLUG}.lead-handoff" file
  [[ -d .ralph/lead ]] || return 0
  mkdir -p "${dest}"
  while IFS= read -r -d '' file; do
    head -c 2097152 "${file}" >"${dest}/$(basename "${file}")" 2>/dev/null || true
  done < <(find .ralph/lead -maxdepth 1 -type f -not -type l -print0)
}

# A Lead that stops while a subagent still runs (a background delegation) ends its session with
# the work unfinished. Both handoff files are written only in the plan's last steps, so their
# absence is how the harness tells a finished session from an abandoned one.
lead_handed_off() {
  [[ -s .ralph/lead/checklist.md && -s .ralph/lead/changeset.md ]]
}

# Like fresh_session (ralph-loop.sh), with one deliberate difference: compaction stays on. One
# session carries the whole ticket, so it must be able to compact instead of failing as a
# single-phase session may. The Lead's context stays small anyway, because the subagents do the
# reading and the editing. Still an empty config dir (no memory, no earlier sessions) and
# credentials from the environment. Returns the session's exit status: 124 timed out, 130/143
# interrupted.
# Usage: lead_session <ticket> <json out> <stderr out> <prompt>
lead_session() {
  local ticket=$1 out=$2 err=$3 prompt=$4 session config status=0 started record outcome=ok
  local -a argv
  IFS=' ' read -r -a argv <<<"${LEAD_CMD}"
  session="$(node -e 'console.log(require("node:crypto").randomUUID())')"
  config="$(mktemp -d "${TMPDIR:-/tmp}/ralph-lead.XXXXXX")"
  [[ "${argv[0]##*/}" == claude ]] && argv+=(--session-id "${session}")
  [[ -z "${LEAD_BUDGET}" ]] || argv+=(--max-budget-usd "${LEAD_BUDGET}")
  # -k: a Lead that ignores SIGTERM is killed 30 s later instead of hanging the run.
  ((LEAD_TIMEOUT > 0)) && argv=(timeout -k 30 "${LEAD_TIMEOUT}" "${argv[@]}")
  started="$(date -u +%FT%TZ)"
  record="${LOG_DIR}/sessions/$(date -u +%Y%m%dT%H%M%S%N)-${session}.tsv"
  mkdir -p "${record%/*}"
  session_record "${record}" "${started}" "$(ticket_number "${ticket}") lead" "${session}" running - -
  # In the background so a signal reaches this shell's trap while the Lead is running; the trap
  # (installed by lead_ticket) stops the Lead and this function reports 130/143.
  CLAUDE_CONFIG_DIR="${config}" CLAUDE_CODE_DISABLE_AUTO_MEMORY=1 RALPH_SESSION_ID="${session}" \
    RALPH_TICKET="$(ticket_number "${ticket}")" RALPH_PHASE=lead \
    "${argv[@]}" "${prompt}" >"${out}" 2>"${err}" &
  LEAD_PID=$!
  wait "${LEAD_PID}" || status=$?
  [[ -z "${LEAD_INTERRUPTED}" ]] || status=${LEAD_INTERRUPTED}
  LEAD_PID=""
  rm -rf "${config}"
  if [[ -n "${LEAD_INTERRUPTED}" ]]; then
    outcome=interrupted
  elif ((status == 124)); then
    outcome=timed-out
  elif ((status != 0)); then
    outcome=failed
  fi
  session_record "${record}" "${started}" "$(ticket_number "${ticket}") lead" "${session}" \
    "${outcome}" "${status}" "$(date -u +%FT%TZ)"
  return "${status}"
}

# ---------------------------------------------------------------------------------------------
# Stopping without a verdict on the ticket
# ---------------------------------------------------------------------------------------------

# A session that did not finish says nothing about the ticket, so it is not rejected or blocked
# and nothing is retried. The work is parked as a patch in the run's logs (the host copies them)
# and, on the slice branch, as one commit; main is untouched.
# Usage: lead_stop <ticket> <branch> <base sha> <why>
lead_stop() {
  local ticket=$1 branch=$2 base_sha=$3 why=$4 slug patch
  slug="$(ticket_slug "${ticket}")"
  patch="$(lead_save_patch)"
  if git symbolic-ref --quiet --short HEAD >/dev/null 2>&1; then
    # A Lead that moved git is not trusted to leave a branch worth keeping.
    if [[ "$(git symbolic-ref --short HEAD)" == "${branch}" ]]; then
      git commit --quiet --allow-empty -m "wip(ralph): lead stopped: ${why}" || true
      git switch --quiet "${BASE_BRANCH}" || true
    else
      # On the base branch (the Lead switched there): leave it as the harness found it.
      git reset --quiet --hard HEAD 2>/dev/null || true
      git clean --quiet -fd 2>/dev/null || true
    fi
  fi
  log "STOPPED ${slug}: ${why}"
  log "  no retry, no fallback, ticket not blocked. Work saved in ${patch}"
  log "  (and on ${branch} if this clone survives). Session logs: ${LOG_DIR}"
  RUN_STATUS=failed
}

# Why a failed session failed, in the CLI's own words where the classifier knows them.
lead_failure_reason() {
  local status=$1 out=$2 err=$3 class
  if [[ -n "${LEAD_INTERRUPTED}" ]]; then
    echo "interrupted"
  elif ((status == 124)); then
    echo "the lead session timed out after ${LEAD_TIMEOUT}s"
  else
    class="$(provider_failure "${status}" "${out}" "${err}")"
    case "${class}" in
      usage-limit | auth) echo "provider ${class}: wait or fix the credentials, then run again" ;;
      transient) echo "the provider failed (${class}); run again when it is back" ;;
      *) echo "the lead session exited with status ${status}" ;;
    esac
  fi
}

# ---------------------------------------------------------------------------------------------
# Judging the candidate
# ---------------------------------------------------------------------------------------------

# The harness owns git, so after the session the branch must be the slice branch, still built on
# the base commit the harness started from, and the base branch must not have moved.
lead_git_intact() {
  local branch=$1 base_sha=$2
  [[ "$(git symbolic-ref --quiet --short HEAD || true)" == "${branch}" ]] &&
    [[ "$(git rev-parse "refs/heads/${BASE_BRANCH}")" == "${base_sha}" ]] &&
    git merge-base --is-ancestor "${base_sha}" HEAD
}

# RED is re-proved by the harness, because the Lead writes tests and code in one session: base +
# ONLY the candidate's test files must pass verify_red (ralph-loop.sh), the check Ralph applies to
# its RED phase. The tree is restored to the candidate afterwards.
# Usage: lead_prove_red <base sha> <candidate sha> <log file>
lead_prove_red() {
  local base_sha=$1 candidate=$2 logfile=$3 status=0
  local -a tests
  mapfile -d '' -t tests < <(
    git diff -z --name-only --diff-filter=d "${base_sha}" "${candidate}" |
      grep -zE '\.test\.tsx?$|(^|/)__fixtures__/' || true
  )
  # The branch moves to the base for the proof; this ref keeps the candidate reachable meanwhile.
  git update-ref refs/ralph/lead-candidate "${candidate}"
  git reset --quiet --hard "${base_sha}"
  git clean --quiet -fd
  if ((${#tests[@]} > 0)); then
    git checkout --quiet "${candidate}" -- "${tests[@]}"
  fi
  verify_red "${logfile}" || status=$?
  git reset --quiet --hard "${candidate}"
  git clean --quiet -fd
  return "${status}"
}

# What lands: the same message shape as Ralph's (the importer pins only the subject), but it says
# what this driver actually established.
write_commit_message() {
  local ticket=$1 type title number
  type="$(commit_type_for "${ticket}")"
  title="$(ticket_title "${ticket}")"
  number="$(ticket_number "${ticket}")"
  cat <<EOF
${type}(slice-${number}): ${title}

Implements ${ticket} through the lead driver (scripts/ralph-lead.sh, ADR 0017).

Checked on this exact tree by the harness, not by the agent:
- RED re-proved: the candidate's test files alone, applied to the base commit, load, execute
  and fail (scripts/ralph-red.mjs)
- biome ci --error-on-warnings, tsc --noEmit (strict), vitest run, debt register rules
The host re-runs the gate and runs its own independent Standards and Spec review before it
merges (ADR 0014, ADR 0015); deferred findings are recorded there.

Refs: ${ticket}
Co-Authored-By: Claude <noreply@anthropic.com>
EOF
}

# ---------------------------------------------------------------------------------------------
# One ticket
# ---------------------------------------------------------------------------------------------

# Tokens and the cost the CLI reports, per session file. The cost is the CLI's API-price
# arithmetic, not subscription usage (scripts/ralph-usage.mjs says so in its output).
report_usage() {
  node "${USAGE_REPORT}" "${LOG_DIR}" >"${LOG_DIR}/usage.md" 2>>"${LOG_DIR}/usage.stderr.log" ||
    log "  usage report unavailable, see ${LOG_DIR}/usage.stderr.log"
  [[ ! -s "${LOG_DIR}/usage.md" ]] || sed 's/^/  /' "${LOG_DIR}/usage.md" >&2
}

# Returns 0 when merged; otherwise the session's status (stopped) or 1 (rejected).
lead_ticket() {
  local ticket=$1 slug branch base_sha candidate status=0 out err
  slug="$(ticket_slug "${ticket}")"
  branch="slice/${slug}"
  GATE_TICKET="$(ticket_number "${ticket}")" GATE_TICKET_FILE="${ticket}"
  log "Ticket ${ticket}: $(ticket_title "${ticket}") (lead driver)"

  [[ ! -e "${DONE_DIR}/$(basename "${ticket}")" ]] ||
    die "${ticket} is already archived in ${DONE_DIR}/; refusing to process it again"
  git show-ref --quiet "refs/heads/${branch}" && die "branch ${branch} already exists"
  [[ ! -e "${STATE_DIR}/${slug}.pause" ]] ||
    die "${slug} is paused by the Ralph driver: resume it with that driver, not the lead driver"

  # lead_ticket runs under `|| exit`, where errexit is off: every step that matters is checked.
  base_sha="$(git rev-parse HEAD)"
  git switch --quiet -c "${branch}" "${BASE_BRANCH}" || die "could not create ${branch}"
  CURRENT_BRANCH="${branch}"
  LEAD_SLUG="${slug}" LEAD_BRANCH="${branch}" LEAD_BASE="${base_sha}" LEAD_CANDIDATE=""
  trap 'lead_interrupt 130' INT
  trap 'lead_interrupt 143' TERM
  set_status "${ticket}" "in-progress"
  mkdir -p .ralph/lead

  out="${LOG_DIR}/${slug}.lead.json"
  err="${LOG_DIR}/${slug}.lead.stderr.log"
  log "  running the lead session (timeout ${LEAD_TIMEOUT}s); it is the only agent run for this ticket"
  lead_session "${ticket}" "${out}" "${err}" "$(build_lead_prompt "${ticket}" "${base_sha}")" ||
    status=$?
  lead_export_handoff
  report_usage
  if grep -qiE "${CONTEXT_EXHAUSTED}" "${out}" "${err}" 2>/dev/null; then
    log "  the lead session ran out of context: the ticket is probably too large; split it"
  fi
  if ((status != 0)); then
    lead_stop "${ticket}" "${branch}" "${base_sha}" \
      "$(lead_failure_reason "${status}" "${out}" "${err}")"
    return "${status}"
  fi
  if ! lead_handed_off; then
    lead_stop "${ticket}" "${branch}" "${base_sha}" \
      "the lead ended its session without handing off (no checklist.md and changeset.md); a subagent was probably left running in the background"
    return 1
  fi
  if ! lead_git_intact "${branch}" "${base_sha}"; then
    lead_stop "${ticket}" "${branch}" "${base_sha}" \
      "the lead changed git (branch or base moved); the candidate is not trusted"
    return 1
  fi

  if ! checkpoint "lead candidate"; then
    lead_stop "${ticket}" "${branch}" "${base_sha}" "could not commit the candidate"
    return 1
  fi
  candidate="$(git rev-parse HEAD)"
  LEAD_CANDIDATE="${candidate}"
  if ! lead_prove_red "${base_sha}" "${candidate}" "${LOG_DIR}/${slug}.lead.red.log"; then
    reject_slice "${ticket}" "${branch}" "RED not re-proved: the candidate's tests do not fail on the base"
    return 1
  fi
  if ! run_gate "${LOG_DIR}/${slug}.lead.gate.log"; then
    reject_slice "${ticket}" "${branch}" "the candidate failed the quality gate"
    return 1
  fi
  finalize_slice "${ticket}" "${branch}"
  # finalize_slice also runs with errexit off: a merge that failed must not be reported as one.
  if ! git merge-base --is-ancestor "${branch}" "${BASE_BRANCH}" ||
    [[ ! -f "${DONE_DIR}/$(basename "${ticket}")" ]]; then
    log "ERROR: ${branch} is not merged into ${BASE_BRANCH}; the candidate is kept on ${branch}"
    return 1
  fi
  CURRENT_BRANCH=""
  RUN_STATUS=succeeded
}

lead_main() {
  parse_args "$@"
  [[ -n "${ONLY_TICKET}" ]] ||
    die "the lead driver runs exactly one explicit ticket: pass --ticket NN"
  [[ "${LEAD_TIMEOUT}" =~ ^[0-9]+$ ]] || die "RALPH_LEAD_TIMEOUT must be a whole number of seconds"
  [[ -z "${LEAD_BUDGET}" || "${LEAD_BUDGET}" =~ ^[0-9]+(\.[0-9]+)?$ ]] ||
    die "RALPH_LEAD_MAX_BUDGET_USD must be a number"
  preflight
  local -a lead_argv
  IFS=' ' read -r -a lead_argv <<<"${LEAD_CMD}"
  command -v "${lead_argv[0]}" >/dev/null || die "lead command not found: ${lead_argv[0]}"
  if [[ "${LEAD_CMD}" == *dangerously-skip-permissions* &&
    "${RALPH_SANDBOX:-0}" != 1 && "${RALPH_ALLOW_HOST:-0}" != 1 ]]; then
    die "refusing to run a permission-skipping lead outside the sandbox; use ./scripts/sandbox.sh"
  fi

  local ticket
  if [[ "${DRY_RUN}" == true ]]; then
    if ticket="$(next_ticket)"; then
      log "dry run: the lead would work ${ticket}"
    else
      log "dry run: ticket ${ONLY_TICKET} is not ready"
    fi
    return 0
  fi
  start_run
  # Refused before any agent runs: not ready-for-agent, blocked, or held by the debt gate.
  ticket="$(next_ticket)" ||
    die "ticket ${ONLY_TICKET} is not ready: status, blockers or the debt gate (nothing was run)"
  lead_ticket "${ticket}" || exit $?
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  lead_main "$@"
fi
