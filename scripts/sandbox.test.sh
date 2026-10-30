#!/usr/bin/env bash
#
# Regression test across the real sandbox boundary: builds the sandbox image, runs
# scripts/sandbox.sh against a throwaway host repo with a stub agent and a stub reviewer that
# always blocks, and checks that a REJECTED run leaves its evidence on the host after the
# container is gone: logs and review reports, the quarantine branch, and the blocked status
# (on the base branch, or on a side branch when the host has unrelated local changes).
# Needs Docker. Not part of `pnpm run check`, which also runs inside the sandbox (no Docker).
set -Eeuo pipefail

SOURCE_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
readonly SOURCE_ROOT
# Under the repo, not /tmp: Docker Desktop on Windows can only mount paths it can translate.
mkdir -p "${SOURCE_ROOT}/.ralph/tmp"
WORK="$(mktemp -d "${SOURCE_ROOT}/.ralph/tmp/sandbox-test.XXXXXX")"
readonly WORK
# Files written by the container's user may not be deletable on Linux hosts; never fail on it.
trap 'rm -rf "${WORK}" 2>/dev/null || true' EXIT
failures=0

new_host_repo() {
  local dir="${WORK}/$1"
  mkdir -p "${dir}/scripts" "${dir}/infra/nats" "${dir}/skills/code-review" "${dir}/issues" \
    "${dir}/stub"
  cp "${SOURCE_ROOT}/Dockerfile" "${SOURCE_ROOT}/.dockerignore" "${SOURCE_ROOT}/ralph-loop.sh" \
    "${dir}/"
  cp "${SOURCE_ROOT}/infra/nats/nats.conf" "${dir}/infra/nats/"
  cp "${SOURCE_ROOT}"/scripts/{sandbox.sh,sandbox-entrypoint.sh,sandbox-services.sh,ralph-review.mjs,ralph-artifacts.mjs} \
    "${dir}/scripts/"
  cp "${SOURCE_ROOT}/skills/code-review/report.schema.json" "${dir}/skills/code-review/"

  # A project whose gate passes once feature.txt exists, so RED and GREEN are genuine.
  printf '{"name":"fixture","private":true,"scripts":{"lint":"node -e 0","typecheck":"node -e 0","test":"node gate.mjs"}}\n' \
    >"${dir}/package.json"
  printf "lockfileVersion: '9.0'\n\nsettings:\n  autoInstallPeers: true\n  excludeLinksFromLockfile: false\n\nimporters:\n\n  .: {}\n" \
    >"${dir}/pnpm-lock.yaml"
  printf 'import { existsSync } from "node:fs";\nprocess.exit(existsSync("feature.txt") ? 0 : 1);\n' \
    >"${dir}/gate.mjs"
  printf '.ralph/\nnode_modules/\n' >"${dir}/.gitignore"
  printf 'unrelated notes\n' >"${dir}/notes.md"
  printf '# 01: Demo ticket\n\n**Blocked by:** None (can start immediately)\n\n**Status:** ready-for-agent\n\n- [ ] works\n' \
    >"${dir}/issues/01-demo.md"
  cat >"${dir}/stub/agent.sh" <<'EOF'
#!/usr/bin/env bash
case "${RALPH_PHASE}" in
  red) echo "test" >demo.test.ts ;;
  green) echo feature >feature.txt ;;
esac
EOF
  # The shared stub reviewer returns valid evidence plus one HIGH finding (STUB_REVIEW=high).
  cp "${SOURCE_ROOT}/scripts/ralph-stub-reviewer.mjs" "${dir}/stub/"

  git -C "${dir}" init --quiet --initial-branch=main
  git -C "${dir}" config core.autocrlf false
  git -C "${dir}" config user.name "Sandbox Test"
  git -C "${dir}" config user.email sandbox-test@localhost
  git -C "${dir}" add -A
  # As in the real repo; `cp` on Windows does not carry the executable bit.
  git -C "${dir}" update-index --chmod=+x ralph-loop.sh scripts/sandbox.sh
  git -C "${dir}" commit --quiet -m init
  mkdir -p "${dir}/.ralph/logs"
  # On Linux the container user (uid 1000) must be able to write the mounted repo and logs.
  chmod -R a+rwX "${dir}"
  printf '%s\n' "${dir}"
}

run_sandbox() {
  local dir=$1
  # Stub agents need no credentials; a placeholder satisfies the scripts' key check.
  ANTHROPIC_API_KEY=placeholder-unused-by-stub-agents CLAUDE_CODE_OAUTH_TOKEN="" \
    RALPH_AGENT_CMD="bash stub/agent.sh" RALPH_REVIEW_CMD="env STUB_REVIEW=high node stub/ralph-stub-reviewer.mjs" \
    RALPH_MAX_ATTEMPTS=1 RALPH_MAX_REVIEW_ROUNDS=1 RALPH_BASE_BRANCH="" \
    bash "${dir}/scripts/sandbox.sh" --once >"${dir}.out" 2>&1 && echo 0 || echo $?
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

status_on() { git -C "$1" show "$2:issues/01-demo.md" | sed -n 's/^\*\*Status:\*\* //p'; }
first_branch() { git -C "$1" for-each-ref --format='%(refname:short)' "refs/heads/$2" | head -n 1; }

check_evidence() {
  local dir=$1 rejected
  rejected="$(first_branch "${dir}" 'rejected/*')"
  check "quarantine branch on host" "[[ '${rejected}' == rejected/01-demo-* ]]"
  check "quarantine branch holds the work" \
    "git -C '${dir}' cat-file -e '${rejected}:feature.txt' 2>/dev/null"
  check "review report on host" \
    "grep -q 'Code review: BLOCKED' '${dir}'/.ralph/logs/*/01-demo.review-1.md 2>/dev/null"
  check "agent log on host" "ls '${dir}'/.ralph/logs/*/01-demo.agent.log >/dev/null 2>&1"
  check "review decision on host" \
    "grep -q '\"verdict\": \"blocked\"' '${dir}'/.ralph/logs/*/01-demo.review-1.decision.json 2>/dev/null"
  check "reviewed changeset archived on host" \
    "grep -q '^review-token: ' '${dir}'/.ralph/logs/*/01-demo.review-1.diff 2>/dev/null"
  check "run recorded as failed on host" \
    "grep -q '\"status\": \"failed\"' '${dir}'/.ralph/logs/*/run.json 2>/dev/null"
}

echo "rejected run, clean host:"
host="$(new_host_repo clean-host)"
code="$(run_sandbox "${host}")"
check "sandbox exits non-zero" "[[ ${code} != 0 ]]"
check_evidence "${host}"
check "ticket blocked on host main" "[[ \$(status_on '${host}' main) == blocked ]]"
check "host checkout updated" "grep -q 'Status:\*\* blocked' '${host}/issues/01-demo.md'"
check "work not merged into main" "! git -C '${host}' cat-file -e main:feature.txt 2>/dev/null"
((failures == 0)) || sed 's/^/      | /' "${host}.out" | tail -n 40

echo "rejected run, host with unrelated local changes:"
host="$(new_host_repo dirty-host)"
printf 'my unsaved edit\n' >>"${host}/notes.md"
main_before="$(git -C "${host}" rev-parse main)"
code="$(run_sandbox "${host}")"
check "sandbox exits non-zero" "[[ ${code} != 0 ]]"
check_evidence "${host}"
check "host main untouched" "[[ \$(git -C '${host}' rev-parse main) == ${main_before} ]]"
check "local edit preserved" "grep -q 'my unsaved edit' '${host}/notes.md'"
check "blocked status on a side branch" \
  "[[ \$(status_on '${host}' \"\$(first_branch '${host}' 'ralph/blocked-*')\") == blocked ]]"
((failures == 0)) || sed 's/^/      | /' "${host}.out" | tail -n 40

if ((failures > 0)); then
  echo "sandbox rejection tests: ${failures} check(s) failed" >&2
  exit 1
fi
echo "sandbox rejection tests: all passed"
