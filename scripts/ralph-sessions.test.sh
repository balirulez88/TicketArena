#!/usr/bin/env bash
#
# Context-lifecycle scenarios for ralph-loop.sh: fresh Claude session per process, no resumption,
# no compaction, isolated reviewers, and the completed-ticket lifecycle. The harness runs with
# its DEFAULT agent and reviewer commands against a fake `claude` on PATH
# (scripts/ralph-fake-claude.mjs), so the checks see the real launch configuration: arguments,
# environment and config directory of every process. The quality gate is stubbed to pass.
set -Eeuo pipefail

SOURCE_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
readonly SOURCE_ROOT
WORK="$(mktemp -d)"
readonly WORK
trap 'rm -rf "${WORK}"' EXIT
# Sessions killed on purpose below never remove their config dirs; keep them inside WORK.
mkdir -p "${WORK}/tmp"
export TMPDIR="${WORK}/tmp"
failures=0

mkdir -p "${WORK}/bin"
cat >"${WORK}/bin/claude" <<EOF
#!/usr/bin/env bash
# Simulates a harness that dies mid-ticket (power loss, OOM kill): no traps run.
if [[ -n "\${FAKE_CLAUDE_KILL_PHASE:-}" && "\${FAKE_CLAUDE_KILL_PHASE}" == "\${RALPH_PHASE:-}" ]]; then
  kill -KILL "\${PPID}"
  exit 1
fi
exec node "${SOURCE_ROOT}/scripts/ralph-fake-claude.mjs" "\$@"
EOF
chmod +x "${WORK}/bin/claude"

ticket() {
  local file=$1 title=$2 blocked_by=$3 status=$4
  printf '# %s: %s\n\n**Blocked by:** %s\n\n**Status:** %s\n\n- [ ] %s works\n' \
    "${file:0:2}" "${title}" "${blocked_by}" "${status}" "${title}" >"$5/${file}"
}

# 00 was completed long ago (archived), 01 depends on it, 02 depends on 01, 03 was rejected
# earlier and must stay out of the run.
new_repo() {
  local dir="${WORK}/$1"
  mkdir -p "${dir}/scripts" "${dir}/skills/code-review" "${dir}/issues/done"
  cp "${SOURCE_ROOT}/ralph-loop.sh" "${dir}/"
  cp "${SOURCE_ROOT}"/scripts/{ralph-review.mjs,ralph-artifacts.mjs} "${dir}/scripts/"
  cp "${SOURCE_ROOT}/skills/code-review/report.schema.json" "${dir}/skills/code-review/"
  ticket 00-foundation.md Foundation "None (can start immediately)" done "${dir}/issues/done"
  ticket 01-first.md "First slice" "00" ready-for-agent "${dir}/issues"
  ticket 02-second.md "Second slice" "01 (First slice)" ready-for-agent "${dir}/issues"
  ticket 03-rejected.md "Rejected slice" "None (can start immediately)" blocked "${dir}/issues"
  printf '.ralph/\n' >"${dir}/.gitignore"
  git -C "${dir}" init --quiet --initial-branch=main
  git -C "${dir}" config core.autocrlf false
  git -C "${dir}" -c user.name=t -c user.email=t@t add -A
  git -C "${dir}" -c user.name=t -c user.email=t@t commit --quiet -m init
  printf '%s\n' "${dir}"
}

# Runs the harness loop (not --once) with its default Claude commands; prints the exit code.
run_harness() {
  local dir=$1
  shift
  (
    cd "${dir}"
    while read -r name; do unset "${name}"; done < <(compgen -e | grep '^RALPH_' || true)
    export PATH="${WORK}/bin:${PATH}" FAKE_CLAUDE_LEDGER="${dir}.ledger"
    export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@t GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@t
    # The fake needs no credentials; the harness requires them because sessions start fresh.
    export RALPH_SANDBOX=1 CLAUDE_CODE_OAUTH_TOKEN=placeholder-for-fake-claude RALPH_MAX_ATTEMPTS=1
    (($# == 0)) || export "$@"
    # shellcheck source=../ralph-loop.sh
    source ./ralph-loop.sh
    run_gate() { : >"$1"; }
    verify_red() { : >"$1"; }
    main
  ) >>"${dir}.out" 2>&1 && echo 0 || echo $?
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

# Answers a question about the ledger (one JSON object per Claude process) with a JS expression
# over `runs`; prints the result.
ledger() {
  node -e '
    const runs = require("fs").readFileSync(process.argv[1], "utf8").trim().split("\n").map(JSON.parse);
    console.log(eval(process.argv[2]));' "$1.ledger" "$2"
}
on_main() { git -C "$1" cat-file -e "main:$2" 2>/dev/null; }
status_on_main() { git -C "$1" show "main:$2" | sed -n 's/^\*\*Status:\*\* //p'; }

echo "two consecutive tickets, default Claude commands:"
dir="$(new_repo two-tickets)"
code="$(run_harness "${dir}")"
# Per ticket: RED, GREEN, REFACTOR, DOCS agents and one review round with two reviewers.
check "harness exits 0" "[[ ${code} == 0 ]]"
check "both tickets merged" "grep -q 'Done: 2 slice(s) merged' '${dir}.out'"
check "12 Claude processes (6 per ticket)" "[[ \$(ledger '${dir}' 'runs.length') == 12 ]]"
check "every process is a distinct session" \
  "[[ \$(ledger '${dir}' 'new Set(runs.map((r) => r.session)).size') == 12 ]]"
check "the session id passed to claude is the one the harness recorded" \
  "[[ \$(ledger '${dir}' 'runs.every((r) => r.session && r.session === r.envSession)') == true ]]"
sessions_tsv="$(compgen -G "${dir}/.ralph/logs/2*")/sessions.tsv"
# Parallel reviewers start in no defined order, so the logged and launched sets are compared.
check "the session log records every launched process exactly once" \
  "[[ \$(tail -n +2 '${sessions_tsv}' | cut -f3 | sort | tr '\n' ' ') == \
\$(ledger '${dir}' 'runs.map((r) => r.session).sort().join(\" \") + \" \"') ]]"
check "every logged session ended ok" \
  "[[ \$(tail -n +2 '${sessions_tsv}' | cut -f4 | sort -u) == ok ]]"
check "no process resumes or continues a conversation" \
  "[[ \$(ledger '${dir}' 'runs.some((r) => r.flags.some((f) => /^(-c|-r|--continue|--resume|--fork-session|--from-pr|--teleport)/.test(f)))') == false ]]"
check "every process disables session persistence" \
  "[[ \$(ledger '${dir}' 'runs.every((r) => r.flags.includes(\"--no-session-persistence\"))') == true ]]"
check "compaction and auto-memory are disabled in every process" \
  "[[ \$(ledger '${dir}' 'runs.every((r) => r.disableCompact === \"1\" && r.disableAutoMemory === \"1\")') == true ]]"
check "every process starts with its own empty config dir" \
  "[[ \$(ledger '${dir}' 'runs.every((r) => r.configEmptyAtStart) && new Set(runs.map((r) => r.configDir)).size === 12') == true ]]"
check "no config dir (memory, transcripts) survives its process" \
  "[[ \$(ledger '${dir}' 'runs.some((r) => require(\"fs\").existsSync(r.configDir))') == false ]]"
check "reviewers are read-only, restricted and isolated" \
  "[[ \$(ledger '${dir}' 'runs.filter((r) => r.role === \"reviewer\").every((r) => [\"--restricted\", \"--strict-mcp-config\", \"--tools=Read,Grep,Glob\"].every((f) => r.flags.includes(f)))') == true ]]"
check "phases run in order per ticket" \
  "[[ \$(ledger '${dir}' 'runs.map((r) => r.ticket + r.phase).join()') == \
01red,01green,01refactor,01docs,01review,01review,02red,02green,02refactor,02docs,02review,02review ]]"
check "no ticket-02 prompt carries ticket 01's transcript or ticket" \
  "[[ \$(ledger '${dir}' 'runs.filter((r) => r.ticket === \"02\").some((r) => /TRANSCRIPT-MARKER|01-first|ticket 01 was here/.test(r.prompt))') == false ]]"
check "ticket 01 was archived before ticket 02 started" \
  "[[ \$(ledger '${dir}' 'runs.filter((r) => r.ticket === \"02\").every((r) => r.archived.includes(\"01-first.md\"))') == true ]]"

echo "completed-ticket lifecycle:"
check "completed tickets moved to issues/done/" \
  "on_main '${dir}' issues/done/01-first.md && on_main '${dir}' issues/done/02-second.md"
check "completed tickets left the active queue" \
  "! on_main '${dir}' issues/01-first.md && ! on_main '${dir}' issues/02-second.md"
check "archived tickets are marked done with completion metadata" \
  "[[ \$(status_on_main '${dir}' issues/done/02-second.md) == done ]] &&
   git -C '${dir}' show main:issues/done/02-second.md | grep -q 'Completed:.* by slice/02-second'"
check "a dependency on a ticket archived long ago resolved (00 -> 01)" \
  "on_main '${dir}' feature-01.txt && on_main '${dir}' issues/done/00-foundation.md"
check "the rejected ticket stayed blocked and active" \
  "[[ \$(status_on_main '${dir}' issues/03-rejected.md) == blocked ]] &&
   ! on_main '${dir}' issues/done/03-rejected.md"
calls_before="$(ledger "${dir}" 'runs.length')"
code="$(run_harness "${dir}")"
check "a second run finds nothing to do" "[[ ${code} == 0 ]] && grep -q 'Done: 0 slice(s)' '${dir}.out'"
check "completed tickets are never selected again" \
  "[[ \$(ledger '${dir}' 'runs.length') == ${calls_before} ]]"
((failures == 0)) || sed 's/^/      | /' "${dir}.out"

echo "a harness killed mid-ticket leaves it recoverable:"
dir="$(new_repo interrupted)"
code="$(run_harness "${dir}" FAKE_CLAUDE_KILL_PHASE=green)"
check "the harness died" "[[ ${code} != 0 ]]"
check "the ticket is not completed or archived" \
  "[[ \$(status_on_main '${dir}' issues/01-first.md) == ready-for-agent ]] &&
   ! on_main '${dir}' issues/done/01-first.md"
check "nothing of the ticket reached main" "! on_main '${dir}' feature-01.txt"
check "the run stays active, so cleanup never removes its evidence" \
  "grep -q '\"status\": \"active\"' \"\$(compgen -G '${dir}/.ralph/logs/2*')/run.json\""
check "the killed session's record survives and shows it never finished" \
  "cat \"\$(compgen -G '${dir}/.ralph/logs/2*')\"/sessions/*.tsv | grep -q \$'\\t01 green#1\\t.*\\trunning\\t-\\t-\$'"
# Recovery as documented: back to main, drop the dead run's slice branch, run again.
git -C "${dir}" checkout --quiet --force main
git -C "${dir}" clean --quiet -fd
git -C "${dir}" branch --quiet -D slice/01-first
code="$(run_harness "${dir}")"
check "a fresh run completes the ticket from scratch" \
  "[[ ${code} == 0 ]] && on_main '${dir}' issues/done/01-first.md && on_main '${dir}' issues/done/02-second.md"
((failures == 0)) || sed 's/^/      | /' "${dir}.out"

echo "session log under concurrency (as with parallel reviewers):"
ledger_dir="${WORK}/concurrent"
mkdir -p "${ledger_dir}"
(
  cd "${ledger_dir}"
  # shellcheck source=../ralph-loop.sh
  RALPH_LOG_ROOT="${ledger_dir}/logs" source "${SOURCE_ROOT}/ralph-loop.sh"
  for i in $(seq 1 20); do fresh_session "reviewer-${i}" 0 true prompt & done
  fresh_session failing 0 false prompt &
  fresh_session missing-command 0 ralph-no-such-command prompt &
  fresh_session timed-out 1 bash -c 'sleep 5' prompt &
  (fresh_session killed 0 bash -c 'sleep 5' prompt) &
  killed=$!
  until grep -qs $'\tkilled\t' "${LOG_DIR}"/sessions/*.tsv; do sleep 0.1; done
  kill -KILL "${killed}"
  wait || true
  combine_sessions
  printf '%s\n' "${LOG_DIR}/sessions.tsv" >"${ledger_dir}/path"
) >"${ledger_dir}.out" 2>&1 || true
tsv="$(cat "${ledger_dir}/path" 2>/dev/null || echo missing)"
status_of() { awk -F'\t' -v label="$1" '$2 == label { print $4 "/" $5 }' "${tsv}"; }
check "24 concurrent sessions, 24 rows, 24 distinct ids" \
  "[[ \$(tail -n +2 '${tsv}' | wc -l) == 24 && \$(tail -n +2 '${tsv}' | cut -f3 | sort -u | wc -l) == 24 ]]"
check "all 20 parallel sessions recorded ok" \
  "[[ \$(awk -F'\t' '\$2 ~ /^reviewer-/ && \$4 == \"ok\"' '${tsv}' | wc -l) == 20 ]]"
check "a failing session is failed with its exit code" "[[ \$(status_of failing) == failed/1 ]]"
check "a launch failure is failed with exit 127" "[[ \$(status_of missing-command) == failed/127 ]]"
check "a timed-out session is distinguished" "[[ \$(status_of timed-out) == timed-out/124 ]]"
check "a session killed mid-flight is interrupted" "[[ \$(status_of killed) == interrupted/- ]]"
check "rows are in launch order" \
  "[[ \$(tail -n +2 '${tsv}' | cut -f1 | sort -c && echo sorted) == sorted ]]"
((failures == 0)) || sed 's/^/      | /' "${ledger_dir}.out"

if ((failures > 0)); then
  echo "ralph-loop session scenarios: ${failures} check(s) failed" >&2
  exit 1
fi
echo "ralph-loop session scenarios: all passed"
