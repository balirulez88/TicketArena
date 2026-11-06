#!/usr/bin/env bash
#
# Which execution driver a sandbox run starts (ADR 0017). Sourced by sandbox.sh on the host, to
# refuse a bad choice before any container exists, and by the container entrypoint, which runs
# the answer. The default is and stays Ralph; the lead driver is chosen only by an explicit
# RALPH_DRIVER=lead. Anything else is an error: a typo must not silently pick an agent driver.
#
#   ralph_driver_script <RALPH_DRIVER value>   prints the driver's path in the workspace
#   ralph_driver_check <RALPH_DRIVER value> <args...>   as above, plus the lead's one-ticket rule

ralph_driver_script() {
  case "${1:-}" in
    "" | ralph) printf '%s\n' ./ralph-loop.sh ;;
    lead) printf '%s\n' ./scripts/ralph-lead.sh ;;
    *)
      printf "sandbox: RALPH_DRIVER must be 'ralph' (the default) or 'lead', not '%s'\n" "$1" >&2
      return 2
      ;;
  esac
}

# The lead driver works exactly one explicit ticket, so it never picks (and pays for) work on its
# own. Refused here too so a missing --ticket costs nothing, not even a bundle.
ralph_driver_check() {
  local driver=${1:-} arg
  shift
  ralph_driver_script "${driver}" >/dev/null || return 2
  [[ "${driver}" == lead ]] || return 0
  for arg in "$@"; do
    [[ "${arg}" != --ticket ]] || return 0
  done
  echo "sandbox: RALPH_DRIVER=lead needs an explicit --ticket NN (one ticket per run)" >&2
  return 2
}
