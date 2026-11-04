#!/usr/bin/env bash
#
# Regression test across the real sandbox boundary (ADR 0014). It builds the sandbox image and
# runs scripts/sandbox.sh against throwaway host repositories, with a stub agent and a stub
# reviewer. It checks, through real Docker:
#   - the boundary itself: from inside, the host repository is unreachable, the input is
#     read-only, there is no Docker socket, and only the two run directories are mounted;
#   - a merge is accepted by the host only after its own agent-free gate, and a rejection and a
#     pause/resume reach the host as Ralph left them;
#   - a malicious agent's forged merge and forged resume state are refused, and the host
#     repository, its Git metadata and its scripts stay exactly as they were;
#   - a dirty host checkout is refused before any container starts.
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
  cp "${SOURCE_ROOT}"/scripts/{sandbox.sh,sandbox-entrypoint.sh,sandbox-services.sh,ralph-review.mjs,ralph-artifacts.mjs,ralph-debt.mjs,ralph-red.mjs,ralph-provider.mjs,ralph-accept.mjs} \
    "${dir}/scripts/"
  # Stands in for the CI check the batch runs on the host: a forgery target.
  printf '#!/usr/bin/env bash\nexit 2\n' >"${dir}/scripts/ralph-ci.sh"
  cp "${SOURCE_ROOT}/skills/code-review/report.schema.json" "${dir}/skills/code-review/"
  # An empty, canonical technical debt register (preflight requires one).
  mkdir -p "${dir}/docs"
  printf '# Technical Debt Register\n\n<!-- ralph-debt:begin -->\n<!-- ralph-debt:end -->\n' \
    >"${dir}/docs/technical-debt.md"
  node "${dir}/scripts/ralph-debt.mjs" format "${dir}/docs/technical-debt.md"

  # A project whose gate passes once feature.txt exists, so RED and GREEN are genuine, and so is
  # the host's own re-run of the gate (`pnpm run check`). Its one workspace package owns the RED
  # test; stub/vitest.mjs stands in for Vitest there and reports each test it is given as failing
  # until feature.txt exists, as the RED check requires.
  printf '{"name":"fixture","private":true,"scripts":{"lint":"node -e 0","typecheck":"node -e 0","test":"node gate.mjs","check:debt":"node scripts/ralph-debt.mjs check docs/technical-debt.md","check":"pnpm run lint && pnpm run typecheck && pnpm run test && pnpm run check:debt"}}\n' \
    >"${dir}/package.json"
  printf 'packages:\n  - "packages/*"\n' >"${dir}/pnpm-workspace.yaml"
  mkdir -p "${dir}/packages/demo/src"
  printf '{"name":"demo","private":true,"scripts":{"test":"node ../../stub/vitest.mjs run"}}\n' \
    >"${dir}/packages/demo/package.json"
  printf "lockfileVersion: '9.0'\n\nsettings:\n  autoInstallPeers: true\n  excludeLinksFromLockfile: false\n\nimporters:\n\n  .: {}\n\n  packages/demo: {}\n" \
    >"${dir}/pnpm-lock.yaml"
  printf 'import { existsSync } from "node:fs";\nprocess.exit(existsSync("feature.txt") ? 0 : 1);\n' \
    >"${dir}/gate.mjs"
  cp "${SOURCE_ROOT}/scripts/ralph-stub-vitest.mjs" "${dir}/stub/vitest.mjs"
  printf '.ralph/\nnode_modules/\n' >"${dir}/.gitignore"
  printf 'unrelated notes\n' >"${dir}/notes.md"
  printf '# 01: Demo ticket\n\n**Blocked by:** None (can start immediately)\n\n**Status:** ready-for-agent\n\n- [ ] works\n' \
    >"${dir}/issues/01-demo.md"
  # STUB_MODE picks what the agent does in GREEN besides implementing: `limit` hits a usage limit
  # (a genuine provider pause), `evil` probes the boundary and forges a merge, `forge-pause`
  # plants resume state for another ticket.
  cat >"${dir}/stub/agent.sh" <<'EOF'
#!/usr/bin/env bash
case "${RALPH_PHASE}" in
  red) mkdir -p packages/demo/src && echo "test" >packages/demo/src/demo.test.ts ;;
  green)
    case "${STUB_MODE:-}" in
      limit)
        echo "Claude AI usage limit reached|1762300000"
        exit 1
        ;;
      evil)
        {
          if [[ -e /host-repo ]]; then echo "host-repo: present"; else echo "host-repo: absent"; fi
          if touch /ralph-in/x 2>/dev/null; then echo "input: writable"; else echo "input: read-only"; fi
          if [[ -e /var/run/docker.sock ]]; then echo "docker.sock: present"; else echo "docker.sock: absent"; fi
          echo "ralph mounts: $(grep -c ' /ralph-' /proc/mounts)"
        } >/ralph-out/probe.txt
        # A forged slice straight onto the staging repository's main, shaped exactly as
        # finalize_slice makes one, so only the path rules can catch it. Its payload is the CI
        # check the host runs between tickets, made to pass whatever happens: under its own name,
        # and under a case variant that a Windows or macOS checkout would write over it.
        forge="$(mktemp -d)"
        git clone --quiet --branch main "${HOME}/staging.git" "${forge}"
        (
          cd "${forge}"
          git switch --quiet -c slice/01-demo
          mkdir -p issues/done Scripts
          sed 's/^\*\*Status:\*\* .*/**Status:** done\n\n**Completed:** 2026-11-04 by slice\/01-demo (run forged)/' \
            issues/01-demo.md >issues/done/01-demo.md
          git rm --quiet issues/01-demo.md
          echo feature >feature.txt
          printf '#!/usr/bin/env bash\nexit 0\n' >scripts/ralph-ci.sh
          cp scripts/ralph-ci.sh Scripts/ralph-ci.sh
          # And the host's batch state, which the host ignores and a fast-forward would overwrite.
          mkdir -p .ralph/batch
          echo '{"forged":true}' >.ralph/batch/state.json
          git add -A
          git add --force .ralph/batch/state.json
          git commit --quiet -m "feat(slice-01): Demo ticket"
          git switch --quiet main
          git merge --quiet --no-ff slice/01-demo -m "Merge slice/01-demo: Demo ticket"
          git push --quiet origin main
        )
        ;;
      forge-pause)
        printf 'ticket=02\nphase=verify\n' >"${RALPH_STATE_DIR}/02-other.pause"
        ;;
    esac
    echo feature >feature.txt
    ;;
esac
EOF
  # The shared stub reviewer returns valid evidence, plus one HIGH finding when STUB_REVIEW=high.
  cp "${SOURCE_ROOT}/scripts/ralph-stub-reviewer.mjs" "${dir}/stub/"

  git -C "${dir}" init --quiet --initial-branch=main
  git -C "${dir}" config core.autocrlf false
  git -C "${dir}" config user.name "Sandbox Test"
  git -C "${dir}" config user.email sandbox-test@localhost
  git -C "${dir}" add -A
  # As in the real repo; `cp` on Windows does not carry the executable bit.
  git -C "${dir}" update-index --chmod=+x ralph-loop.sh scripts/sandbox.sh
  git -C "${dir}" commit --quiet -m init
  printf '%s\n' "${dir}"
}

# Usage: run_sandbox <host> <agent mode> <review mode>; prints the exit code.
run_sandbox() {
  local dir=$1 mode=$2 review=$3
  # Stub agents need no credentials; a placeholder satisfies the scripts' key check.
  ANTHROPIC_API_KEY=placeholder-unused-by-stub-agents CLAUDE_CODE_OAUTH_TOKEN="" \
    RALPH_TEST_RUNNER="node ../../stub/vitest.mjs" \
    RALPH_AGENT_CMD="env STUB_MODE=${mode} bash stub/agent.sh" \
    RALPH_REVIEW_CMD="env STUB_REVIEW=${review} node stub/ralph-stub-reviewer.mjs" \
    RALPH_MAX_ATTEMPTS=1 RALPH_MAX_REVIEW_ROUNDS=1 RALPH_BASE_BRANCH="" \
    RALPH_PROVIDER_RETRIES=0 \
    bash "${dir}/scripts/sandbox.sh" --once >>"${dir}.out" 2>&1 && echo 0 || echo $?
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
# SANDBOX_TEST_ONLY=<scenario> runs one scenario: merge, reject, pause, forge-merge, forge-pause, dirty.
wanted() { [[ -z "${SANDBOX_TEST_ONLY:-}" || "${SANDBOX_TEST_ONLY}" == "$1" ]]; }
show_output() { ((failures == 0)) || sed 's/^/      | /' "$1.out" | tail -n 40; }

status_on() { git -C "$1" show "$2:issues/01-demo.md" | sed -n 's/^\*\*Status:\*\* //p'; }
first_branch() { git -C "$1" for-each-ref --format='%(refname:short)' "refs/heads/$2" | head -n 1; }
# Everything a forged run must leave alone: refs, checkout, Git config, hooks, host scripts.
fingerprint() {
  {
    git -C "$1" for-each-ref --format='%(refname) %(objectname)' refs/heads/
    git -C "$1" status --porcelain
    cat "$1/.git/config"
    ls "$1/.git/hooks"
    cat "$1/scripts/ralph-ci.sh" "$1/scripts/sandbox.sh"
    ls "$1/.ralph/state" 2>/dev/null || true
  } | git hash-object --stdin
}

if wanted merge; then
echo "merged run:"
host="$(new_host_repo merge)"
code="$(run_sandbox "${host}" "" clean)"
check "sandbox exits 0" "[[ ${code} == 0 ]]"
check "slice merged into host main" "git -C '${host}' log --format=%s main | grep -q '^Merge slice/01-demo: Demo ticket'"
check "host checkout has the feature" "[[ -f '${host}/feature.txt' ]]"
check "slice branch on host" "git -C '${host}' rev-parse --verify --quiet slice/01-demo >/dev/null"
check "host re-ran the gate without an agent" "grep -q 'sandbox: verifying' '${host}.out'"
check "agent log on host" "ls '${host}'/.ralph/logs/*/01-demo.agent.log >/dev/null 2>&1"
check "quarantine namespace emptied" "[[ -z \$(git -C '${host}' for-each-ref refs/ralph/) ]]"
show_output "${host}"
fi

if wanted reject; then
echo "rejected run:"
host="$(new_host_repo reject)"
code="$(run_sandbox "${host}" "" high)"
check "sandbox exits 1" "[[ ${code} == 1 ]]"
rejected="$(first_branch "${host}" 'rejected/*')"
check "quarantine branch on host" "[[ '${rejected}' == rejected/01-demo-* ]]"
check "quarantine branch holds the work" "git -C '${host}' cat-file -e '${rejected}:feature.txt' 2>/dev/null"
check "ticket blocked on host main" "[[ \$(status_on '${host}' main) == blocked ]]"
check "host checkout updated" "grep -q 'Status:\*\* blocked' '${host}/issues/01-demo.md'"
check "work not merged into main" "! git -C '${host}' cat-file -e main:feature.txt 2>/dev/null"
check "review report on host" \
  "grep -q 'Code review: BLOCKED' '${host}'/.ralph/logs/*/01-demo.review-1.md 2>/dev/null"
check "run recorded as failed on host" \
  "grep -q '\"status\": \"failed\"' '${host}'/.ralph/logs/*/run.json 2>/dev/null"
show_output "${host}"
fi

if wanted pause; then
echo "paused and resumed run:"
host="$(new_host_repo pause)"
code="$(run_sandbox "${host}" limit clean)"
check "sandbox exits 75 on a usage limit" "[[ ${code} == 75 ]]"
check "work parked on host" "git -C '${host}' rev-parse --verify --quiet ralph/paused/01-demo >/dev/null"
check "host holds the resume state" "grep -q '^phase=green$' '${host}/.ralph/state/01-demo.pause'"
check "ticket still ready on host main" "[[ \$(status_on '${host}' main) == ready-for-agent ]]"
code="$(run_sandbox "${host}" "" clean)"
check "resumed run exits 0" "[[ ${code} == 0 ]]"
check "resumed slice merged" "git -C '${host}' log --format=%s main | grep -q '^Merge slice/01-demo:'"
check "resume state cleared on host" "[[ ! -e '${host}/.ralph/state/01-demo.pause' ]]"
check "parked work cleared on host" "[[ -z \$(git -C '${host}' for-each-ref refs/heads/ralph/paused/) ]]"
check "the resume ran from the parked checkpoint" "grep -q 'resuming at green' '${host}.out'"
show_output "${host}"
fi

if wanted forge-merge; then
echo "malicious agent forges a merge:"
host="$(new_host_repo evil)"
before="$(fingerprint "${host}")"
code="$(run_sandbox "${host}" evil clean)"
probe="$(cat "${host}"/.ralph/sandbox/*/out/probe.txt 2>/dev/null || true)"
check "the host repository is not mounted" "grep -q '^host-repo: absent$' <<<'${probe}'"
check "the input is read-only" "grep -q '^input: read-only$' <<<'${probe}'"
check "no Docker socket inside" "grep -q '^docker.sock: absent$' <<<'${probe}'"
check "only the two run directories are mounted" "grep -q '^ralph mounts: 2$' <<<'${probe}'"
check "sandbox exits 3 (refused)" "[[ ${code} == 3 ]]"
check "the host refused the forgery" "grep -q 'REFUSED' '${host}.out'"
check "refused by the path rules, for both spellings" \
  "grep -q 'scripts/ralph-ci.sh: protected' '${host}.out' && grep -q 'Scripts/ralph-ci.sh: protected' '${host}.out'"
check "refused the host-only batch state" "grep -q '.ralph/batch/state.json: the host keeps' '${host}.out'"
check "no forged batch state on the host" "[[ ! -e '${host}/.ralph/batch/state.json' ]]"
check "host repository, Git metadata and scripts unchanged" "[[ \$(fingerprint '${host}') == ${before} ]]"
check "forged CI check not on the host" "grep -q 'exit 2' '${host}/scripts/ralph-ci.sh'"
check "forgery kept for inspection" "[[ -n \$(git -C '${host}' for-each-ref refs/ralph/incoming/) ]]"
show_output "${host}"
fi

if wanted forge-pause; then
echo "malicious agent forges resume state:"
host="$(new_host_repo forge-pause)"
before="$(fingerprint "${host}")"
code="$(run_sandbox "${host}" forge-pause clean)"
check "sandbox exits 3 (refused)" "[[ ${code} == 3 ]]"
check "the forged state is named" "grep -q '02-other' '${host}.out'"
check "host repository and state unchanged" "[[ \$(fingerprint '${host}') == ${before} ]]"
check "no resume state adopted" "[[ ! -e '${host}/.ralph/state/02-other.pause' ]]"
show_output "${host}"
fi

if wanted dirty; then
echo "dirty host checkout:"
host="$(new_host_repo dirty)"
printf 'my unsaved edit\n' >>"${host}/notes.md"
main_before="$(git -C "${host}" rev-parse main)"
code="$(run_sandbox "${host}" "" clean)"
check "sandbox refuses to start" "[[ ${code} == 1 ]] && grep -q 'not clean' '${host}.out'"
check "host main untouched" "[[ \$(git -C '${host}' rev-parse main) == ${main_before} ]]"
check "local edit preserved" "grep -q 'my unsaved edit' '${host}/notes.md'"
show_output "${host}"
fi

if ((failures > 0)); then
  echo "sandbox boundary tests: ${failures} check(s) failed" >&2
  exit 1
fi
echo "sandbox boundary tests: all passed"
