#!/usr/bin/env bash
#
# Container entrypoint. The container never sees the host repository (ADR 0014). Its only host
# mounts are:
#   /ralph-in   read-only: repo.bundle (the base branch and parked work) and state/ (resume state
#               the host vouches for)
#   /ralph-out  this run's output: logs/ as they happen, then state/ and result.bundle at exit
# Ralph pushes to a staging bare repository that only this container has. When the loop ends,
# its branches leave as a Git bundle, which is data: the host validates it
# (scripts/ralph-accept.mjs) and is the only one that changes the host repository.
#
# The host's own gate on a candidate (scripts/ralph-verify.mjs, ADR 0015) runs this image in
# stages, each a separate container sharing one workspace volume at /workspace, without an agent
# or a key:
#   --prepare    clones RALPH_VERIFY_COMMIT from the bundle, checks the register, installs and
#                checks the linked bins, generates (network on; only trusted code runs)
#   --tools      register check, lint, typecheck, harness tests (no network)
#   --test DIR   the `test` script of one workspace directory against fresh services (no network,
#                read-only workspace): the only stage that runs the slice's own code
set -Eeuo pipefail

readonly IN=/ralph-in
readonly OUT=/ralph-out
readonly STAGING="${HOME}/staging.git"
readonly WORKSPACE="${HOME}/workspace"
readonly STATE="${HOME}/ralph-state"
readonly BASE_BRANCH="${RALPH_BASE_BRANCH:-main}"
readonly VERIFY_ROOT=/workspace
# The image carries its own copy of the choice of driver (ADR 0017), so what runs is not decided
# by the workspace the agent can edit.
# shellcheck source=ralph-driver.sh
source /usr/local/lib/ralph/ralph-driver.sh

# The command of a root package.json script (protected: no run can change it), run with bash, not
# `pnpm run`, which would install first and needs the network.
root_script() {
  node -e 'process.stdout.write(require("/workspace/package.json").scripts?.[process.argv[1]] ?? "")' "$1"
}
run_root_script() {
  local command
  command="$(root_script "$1")"
  [[ -n "${command}" ]] || return 0
  echo "sandbox: ${1}" >&2
  (cd "${VERIFY_ROOT}" && PATH="${VERIFY_ROOT}/node_modules/.bin:${PATH}" bash -c "${command}")
}

case "${1:-}" in
  --prepare)
    commit="${RALPH_VERIFY_COMMIT:?}"
    cd "${VERIFY_ROOT}"
    git init --quiet --initial-branch="${BASE_BRANCH}" .
    git fetch --quiet --no-tags "${IN}/repo.bundle" '+refs/*:refs/bundle/*'
    git reset --quiet --hard "${commit}"
    [[ "$(git rev-parse HEAD)" == "${commit}" ]] || {
      echo "sandbox: the workspace is not at ${commit}" >&2
      exit 1
    }
    echo "sandbox: verifying $(git log -1 --format='%h %s')" >&2
    # The register check is protected and needs no dependencies, so it runs before anything is
    # installed. The tools stage runs it again.
    run_root_script check:debt
    pnpm install --frozen-lockfile
    # Before any package script runs: no package outside the toolchain may link a bin that
    # shadows a command the gate trusts (node, the shell, tsc, vitest, ...). The check comes from
    # the image, built from the base.
    node /usr/local/lib/ralph/ralph-bins.mjs "${VERIFY_ROOT}"
    run_root_script db:generate
    # The test stages see this workspace read-only. Vite bundles each package's config into
    # .vite-temp, which they mount as their one writable directory there; Vitest's module cache
    # must exist and, read-only, is never written, so no test can plant a module another loads.
    node -e '
      const { readdirSync, existsSync, mkdirSync } = require("node:fs");
      const dirs = ["."];
      for (const group of ["apps", "packages"].filter((dir) => existsSync(dir))) {
        for (const name of readdirSync(group)) {
          if (existsSync(`${group}/${name}/package.json`)) dirs.push(`${group}/${name}`);
        }
      }
      for (const dir of dirs) {
        for (const cache of [".vite-temp", ".vitest-cache"]) {
          mkdirSync(`${dir}/node_modules/${cache}`, { recursive: true });
        }
      }'
    exit 0
    ;;
  --tools)
    for step in check:debt lint typecheck test:harness; do
      run_root_script "${step}"
    done
    exit 0
    ;;
  --test)
    target="${2:?}"
    # Tests run as this user next to the runner that reports on them. Yama scope 1 or more stops
    # them from tracing the runner (their parent) and rewriting its verdict; without it, refuse.
    scope="$(cat /proc/sys/kernel/yama/ptrace_scope 2>/dev/null || echo none)"
    [[ "${scope}" =~ ^[1-3]$ ]] || {
      echo "sandbox: the kernel does not restrict ptrace (Yama ptrace_scope: ${scope}); refusing to run tests" >&2
      exit 1
    }
    dir="${VERIFY_ROOT}/${target}"
    command="$(node -e 'process.stdout.write(require(process.argv[1]).scripts?.test ?? "")' "${dir}/package.json")"
    [[ -n "${command}" ]] || {
      echo "sandbox: ${target} has no test script" >&2
      exit 1
    }
    # shellcheck source=sandbox-services.sh
    source /usr/local/lib/sandbox-services.sh
    sandbox_start_services
    echo "sandbox: test ${target}" >&2
    cd "${dir}"
    PATH="${dir}/node_modules/.bin:${VERIFY_ROOT}/node_modules/.bin:${PATH}" exec bash -c "${command}"
    ;;
  --review)
    # One reviewer of the host's own review (scripts/ralph-host-review.mjs): a fresh session over
    # a read-only snapshot of exactly RALPH_REVIEW_COMMIT. The host made the changeset, prompt and
    # schema; the report is whatever the reviewer prints, read by the host from stdout. Nothing
    # else may reach stdout, and the container has no output mount.
    commit="${RALPH_REVIEW_COMMIT:?}"
    git init --quiet "${WORKSPACE}"
    cd "${WORKSPACE}"
    git fetch --quiet --no-tags "${IN}/repo.bundle" '+refs/*:refs/bundle/*'
    git -c advice.detachedHead=false checkout --quiet "${commit}"
    [[ "$(git rev-parse HEAD)" == "${commit}" ]] || {
      echo "sandbox: the review workspace is not at ${commit}" >&2
      exit 1
    }
    changeset="$(cat "${IN}/changeset.path")"
    mkdir -p "$(dirname "${changeset}")"
    cp "${IN}/changeset.diff" "${changeset}"
    # The reviewer only has read tools; the workspace is read-only all the same.
    chmod -R a-w "${WORKSPACE}"
    echo "sandbox: reviewing $(git log -1 --format='%h %s') (${RALPH_REVIEW_AXIS:-reviewer})" >&2
    config="$(mktemp -d)"
    IFS=' ' read -r -a review_argv <<<"${RALPH_REVIEW_CMD:-claude -p --restricted --strict-mcp-config --tools=Read,Grep,Glob --no-session-persistence --output-format=json}"
    [[ "${review_argv[0]##*/}" != claude ]] ||
      review_argv+=(--session-id "$(node -e 'console.log(require("node:crypto").randomUUID())')")
    CLAUDE_CONFIG_DIR="${config}" DISABLE_COMPACT=1 CLAUDE_CODE_DISABLE_AUTO_MEMORY=1 \
      exec timeout "${RALPH_REVIEW_TIMEOUT:-1800}" "${review_argv[@]}" \
      --json-schema "$(cat "${IN}/schema.json")" "$(cat "${IN}/prompt.txt")"
    ;;
esac

[[ -f "${IN}/repo.bundle" ]] || {
  echo "sandbox: mount the input directory (with repo.bundle) at ${IN}" >&2
  exit 1
}
if [[ -z "${ANTHROPIC_API_KEY:-}" && -z "${CLAUDE_CODE_OAUTH_TOKEN:-}" ]]; then
  echo "sandbox: set ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN" >&2
  exit 1
fi

# An unknown driver, or the lead without --ticket, stops here: before the clone, the services
# and any agent.
ralph_driver_check "${RALPH_DRIVER:-}" "$@" || exit 2
driver="$(ralph_driver_script "${RALPH_DRIVER:-}")"

git config --global user.name "${GIT_AUTHOR_NAME:-Ralph Loop}"
git config --global user.email "${GIT_AUTHOR_EMAIL:-ralph@localhost}"

git clone --quiet --mirror "${IN}/repo.bundle" "${STAGING}"
git clone --quiet --branch "${BASE_BRANCH}" "${STAGING}" "${WORKSPACE}"
mkdir -p "${STATE}" "${OUT}/logs"
[[ ! -d "${IN}/state" ]] || cp -R "${IN}/state/." "${STATE}/"
cd "${WORKSPACE}"
pnpm install --frozen-lockfile

# shellcheck source=sandbox-services.sh
source /usr/local/lib/sandbox-services.sh
sandbox_start_services

# Every branch Ralph pushed goes out whatever the loop's outcome, because a rejection and a
# pause are results as well. The exit status is only a hint to the host: what the host accepts
# is decided by validating the bundle.
status=0
if [[ "${driver}" == ./scripts/ralph-lead.sh ]]; then
  # As PID 1 this shell ignores a `docker stop` (SIGTERM) it has no handler for, and the container
  # would be killed with no result.bundle and no logs. The lead driver stops its session and saves
  # the work on a signal, so pass the signal on and wait for it to finish (ADR 0017). Ralph's own
  # line below is unchanged.
  RALPH_PUSH_REMOTE=origin RALPH_LOG_ROOT="${OUT}/logs" RALPH_STATE_DIR="${STATE}" \
    "${driver}" "$@" &
  driver_pid=$!
  trap 'kill -TERM "${driver_pid}" 2>/dev/null || true' INT TERM
  while kill -0 "${driver_pid}" 2>/dev/null; do
    wait "${driver_pid}" || status=$?
  done
  trap - INT TERM
else
  RALPH_PUSH_REMOTE=origin RALPH_LOG_ROOT="${OUT}/logs" RALPH_STATE_DIR="${STATE}" \
    "${driver}" "$@" || status=$?
fi
mkdir -p "${OUT}/state"
cp -R "${STATE}/." "${OUT}/state/"
git -C "${STAGING}" bundle create --quiet "${OUT}/result.bundle.tmp" --branches
mv "${OUT}/result.bundle.tmp" "${OUT}/result.bundle"
exit "${status}"
