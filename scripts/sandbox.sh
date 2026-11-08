#!/usr/bin/env bash
#
# Builds the sandbox image and runs ralph-loop.sh inside it. Arguments are forwarded to the
# loop, e.g. `./scripts/sandbox.sh --once` or `./scripts/sandbox.sh --ticket 03`.
# `RALPH_DRIVER=lead ./scripts/sandbox.sh --ticket NN` runs the opt-in lead driver instead (ADR
# 0017): one explicit ticket, the same trust boundary. Unset, Ralph runs, as always.
# `./scripts/sandbox.sh --verify [commit]` only runs the quality gate on real services on that
# commit (default: the base branch), with no agent and no key, in the hardened staged containers
# of scripts/ralph-verify.mjs.
# `./scripts/sandbox.sh --max-tickets N` runs a bounded batch: one sandbox run per ticket, with
# GitHub CI verified in between (scripts/ralph-batch.mjs, which calls this script per ticket).
#
# Trust boundary (ADR 0014): the container gets no part of this repository. It receives a Git
# bundle and the host's resume state read-only, and writes only to a fresh run directory. What it
# produces is untrusted until scripts/ralph-accept.mjs has validated it. That script, running on
# the host, is the only thing that changes this repository. Exit codes: 0 accepted (merged, or
# nothing to do), 75 paused, 1 rejected or failed, 3 refused as untrusted.
set -Eeuo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
readonly REPO_ROOT
readonly IMAGE="${RALPH_IMAGE:-ticketarena-sandbox}"
readonly BASE="${RALPH_BASE_BRANCH:-main}"

for arg in "$@"; do
  [[ "${arg}" != --max-tickets ]] || exec node "${REPO_ROOT}/scripts/ralph-batch.mjs" "$@"
done
# A batch moves this repository ticket by ticket, so a second, unrelated run must not
# interleave with it. This is a best-effort check, not a lock: the batch itself holds the only
# real lock.
batch_dir="${REPO_ROOT}/${RALPH_BATCH_DIR:-.ralph/batch}"
if [[ -d "${batch_dir}/lock" && -z "${RALPH_BATCH_ID:-}" ]]; then
  echo "sandbox: a Ralph batch holds ${batch_dir}/lock; wait for it (or remove the lock if no batch runs)" >&2
  exit 1
fi

command -v docker >/dev/null || {
  echo "sandbox: docker is required" >&2
  exit 1
}
git() { command git -C "${REPO_ROOT}" "$@"; }

verify=false
[[ "${1:-}" != "--verify" ]] || verify=true
# shellcheck source=ralph-driver.sh
source "${REPO_ROOT}/scripts/ralph-driver.sh"
readonly PREFLIGHT="${REPO_ROOT}/scripts/ralph-preflight.mjs"
readonly BASELINE_DIR="${REPO_ROOT}/.ralph/baseline"
if [[ "${verify}" == false ]]; then
  # A bad RALPH_DRIVER, or the lead without --ticket, is refused before any container exists.
  ralph_driver_check "${RALPH_DRIVER:-}" "$@" || exit 2
  [[ -n "${ANTHROPIC_API_KEY:-}" || -n "${CLAUDE_CODE_OAUTH_TOKEN:-}" ]] || {
    echo "sandbox: export ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN first" >&2
    exit 1
  }
  # The accepted result is fast-forwarded into this checkout, so the run must start from it.
  [[ "$(git symbolic-ref --short HEAD)" == "${BASE}" ]] || {
    echo "sandbox: check out '${BASE}' first" >&2
    exit 1
  }
  [[ -z "$(git status --porcelain)" ]] || {
    echo "sandbox: the working tree is not clean; commit or stash first" >&2
    exit 1
  }
  # Readiness (ADR 0019): a ticket that cannot start costs no image, container or session.
  if [[ "${RALPH_DRIVER:-}" == lead ]]; then
    bash "${REPO_ROOT}/scripts/ralph-lead.sh" "$@" --dry-run || exit $?
  fi
fi

docker build --quiet --tag "${IMAGE}" "${REPO_ROOT}" >/dev/null

# Under the repository, not /tmp: Docker Desktop on Windows can only mount paths it translates.
# It is gitignored, and nothing on the host ever executes from it.
run_id="$(date +%Y%m%d-%H%M%S)-$$"
run_dir="${REPO_ROOT}/.ralph/sandbox/${run_id}"
mkdir -p "${run_dir}/in" "${run_dir}/out"
# On Linux hosts, the container user (uid 1000) must be able to write its output.
chmod a+rwx "${run_dir}/out"

tty_flag=()
[[ -t 0 && -t 1 ]] && tty_flag=(--tty --interactive)
# The container's only host mounts. It runs without capabilities and cannot gain privileges.
# MSYS_NO_PATHCONV stops Git Bash on Windows from rewriting the container-side paths.
sandbox_run() {
  MSYS_NO_PATHCONV=1 docker run --rm "${tty_flag[@]}" \
    --cap-drop ALL --security-opt no-new-privileges \
    --volume "${run_dir}/in:/ralph-in:ro" \
    --volume "${run_dir}/out:/ralph-out" \
    --env RALPH_BASE_BRANCH="${BASE}" \
    "$@"
}

if [[ "${verify}" == true ]]; then
  # The host's own gate, in hardened, staged containers of this image (ADR 0015).
  target="${2:-${BASE}}"
  RALPH_IMAGE="${IMAGE}" node "${REPO_ROOT}/scripts/ralph-verify.mjs" "${target}" || exit $?
  # The later run on this same code need not repeat it (ADR 0019). Only a hint: losing it costs one
  # baseline run, and the importer's gate never reads it.
  if key="$(ralph_baseline_key "${PREFLIGHT}" "${target}")"; then
    mkdir -p "${BASELINE_DIR}" && git rev-parse "${target}" >"${BASELINE_DIR}/${key}" || true
  fi
  exit 0
fi

base_sha="$(git rev-parse "refs/heads/${BASE}")"
baseline_verified="$(ralph_baseline_key "${PREFLIGHT}" "${base_sha}" 2>/dev/null || true)"
[[ -n "${baseline_verified}" && -f "${BASELINE_DIR}/${baseline_verified}" ]] || baseline_verified=""
mapfile -t parked < <(git for-each-ref --format='%(refname)' 'refs/heads/ralph/paused/')
git bundle create --quiet "${run_dir}/in/repo.bundle" "refs/heads/${BASE}" "${parked[@]}"
# Resume state the host holds. The container cannot write it: a pause comes back as output and
# is only adopted once ralph-accept.mjs has validated it.
mkdir -p "${run_dir}/in/state"
if [[ -d "${REPO_ROOT}/.ralph/state" ]]; then
  find "${REPO_ROOT}/.ralph/state" -maxdepth 1 -type f -exec cp {} "${run_dir}/in/state/" \;
fi

ticket=""
for ((i = 1; i <= $#; i++)); do
  [[ "${!i}" != --ticket ]] || {
    next=$((i + 1))
    ticket="${!next:-}"
  }
done

status=0
sandbox_run \
  --env RALPH_PROVIDER_RETRIES \
  --env RALPH_PROVIDER_BACKOFF \
  --env ANTHROPIC_API_KEY \
  --env CLAUDE_CODE_OAUTH_TOKEN \
  --env RALPH_AGENT_CMD \
  --env RALPH_DRIVER \
  --env RALPH_BASELINE_VERIFIED="${baseline_verified}" \
  --env RALPH_LEAD_CMD \
  --env RALPH_LEAD_TIMEOUT \
  --env RALPH_LEAD_MAX_BUDGET_USD \
  --env RALPH_MAX_ATTEMPTS \
  --env RALPH_REVIEW_CMD \
  --env RALPH_MAX_REVIEW_ROUNDS \
  --env RALPH_REVIEW_BLOCKING \
  --env RALPH_REVIEW_TIMEOUT \
  --env RALPH_TEST_RUNNER \
  --env GIT_AUTHOR_NAME="$(git config user.name)" \
  --env GIT_AUTHOR_EMAIL="$(git config user.email)" \
  "${IMAGE}" "$@" || status=$?

accepted=0
node "${REPO_ROOT}/scripts/ralph-accept.mjs" --run-dir "${run_dir}" --base "${base_sha}" \
  --exit "${status}" ${ticket:+--ticket "${ticket}"} || accepted=$?
# A refused or failed run keeps its directory for inspection; .ralph/ is gitignored.
((accepted != 0)) || rm -rf "${run_dir}" 2>/dev/null || true
exit "${accepted}"
