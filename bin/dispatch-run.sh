#!/usr/bin/env bash
set -u

RUN_DIR="${1:-}"
if [[ -z "$RUN_DIR" || "${2:-}" != "--" ]]; then
  echo "usage: dispatch-run.sh <runDir> -- <cmd> <args...>" >&2
  exit 64
fi
shift 2
if [[ $# -eq 0 ]]; then
  echo "dispatch-run.sh: missing command" >&2
  exit 64
fi

mkdir -p "$RUN_DIR"

CHILD=""
STOP_REQUESTED=0

forward_term() {
  STOP_REQUESTED=1
  if [[ -n "$CHILD" ]]; then
    kill -TERM "$CHILD" 2>/dev/null || true
  fi
}
trap forward_term TERM INT

wait_for_child() {
  local pid="$1"
  local code
  while true; do
    wait "$pid"
    code=$?
    if [[ "$code" -gt 128 ]] && kill -0 "$pid" 2>/dev/null; then
      continue
    fi
    return "$code"
  done
}

write_exit() {
  local code="$1"
  local ended_at
  ended_at="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
  printf '{"code":%s,"endedAt":"%s"}\n' "$code" "$ended_at" >"$RUN_DIR/exit.json.tmp"
  mv "$RUN_DIR/exit.json.tmp" "$RUN_DIR/exit.json"
}

# Reclaim inactive build caches before an agent can launch a disk-heavy build. The
# guard refuses the run when the safety reserve cannot be restored, preventing a slow
# build from running all the way into ENOSPC.
DISK_GUARD="${DISK_GUARD:-$HOME/bin/build-disk-guard.sh}"
if [[ -x "$DISK_GUARD" ]]; then
  "$DISK_GUARD" >>"$RUN_DIR/disk-guard.log" 2>&1
  CODE=$?
  if [[ "$CODE" -ne 0 ]]; then
    printf 'dispatch-run.sh: disk preflight failed; see %s\n' "$RUN_DIR/disk-guard.log" >>"$RUN_DIR/stderr.log"
    write_exit "$CODE"
    exit "$CODE"
  fi
fi

# Build/refresh the ticket-local structural graph before the provider starts.
# This is deliberately fail-open: Graft is an optimization, never a reason to
# strand an otherwise valid Claude/Codex run.
if [[ -n "${DISPATCH_GRAFT_INDEXER:-}" &&
      -n "${DISPATCH_GRAFT_NODE:-}" &&
      -n "${DISPATCH_GRAFT_ROOT:-}" &&
      -n "${DISPATCH_GRAFT_GRAPH_DIR:-}" ]]; then
  GRAFT_TIMEOUT="${DISPATCH_GRAFT_TIMEOUT_SEC:-120}"
  if [[ ! "$GRAFT_TIMEOUT" =~ ^[0-9]+$ || "$GRAFT_TIMEOUT" -lt 1 ]]; then
    GRAFT_TIMEOUT=120
  fi

  GRAFT_TIMEOUT_MARK="$RUN_DIR/graft-index.timed-out"
  GRAFT_STATUS_TMP="$RUN_DIR/graft-index.json.tmp"
  mkdir -p "$DISPATCH_GRAFT_GRAPH_DIR"

  "$DISPATCH_GRAFT_NODE" "$DISPATCH_GRAFT_INDEXER" index \
    "$DISPATCH_GRAFT_ROOT" "$DISPATCH_GRAFT_GRAPH_DIR" \
    >>"$RUN_DIR/graft-index.log" 2>&1 </dev/null &
  CHILD=$!
  printf '%s\n' "$CHILD" >"$RUN_DIR/child.pid"

  GRAFT_STARTED_AT=$SECONDS
  while kill -0 "$CHILD" 2>/dev/null; do
    if [[ "$STOP_REQUESTED" -eq 1 ]]; then
      kill -TERM "$CHILD" 2>/dev/null || true
      break
    fi
    if (( SECONDS - GRAFT_STARTED_AT >= GRAFT_TIMEOUT )); then
      : >"$GRAFT_TIMEOUT_MARK"
      kill -TERM "$CHILD" 2>/dev/null || true
      # Give native parsers a short grace period, then guarantee the provider
      # is not held hostage by a wedged index process.
      for _ in {1..20}; do
        kill -0 "$CHILD" 2>/dev/null || break
        sleep 0.1
      done
      kill -KILL "$CHILD" 2>/dev/null || true
      break
    fi
    sleep 0.1
  done

  wait_for_child "$CHILD"
  GRAFT_CODE=$?
  CHILD=""

  if [[ "$STOP_REQUESTED" -eq 1 ]]; then
    write_exit 143
    exit 143
  fi

  if [[ -f "$GRAFT_TIMEOUT_MARK" ]]; then
    printf '{"status":"timed-out","code":%s}\n' "$GRAFT_CODE" >"$GRAFT_STATUS_TMP"
  elif [[ "$GRAFT_CODE" -eq 0 ]]; then
    printf '{"status":"ready","code":0}\n' >"$GRAFT_STATUS_TMP"
  else
    printf '{"status":"failed","code":%s}\n' "$GRAFT_CODE" >"$GRAFT_STATUS_TMP"
  fi
  mv "$GRAFT_STATUS_TMP" "$RUN_DIR/graft-index.json"
fi

if [[ "$STOP_REQUESTED" -eq 1 ]]; then
  write_exit 143
  exit 143
fi

# Node spawns this wrapper with detached:true, making it the session/pgroup
# leader. Do not exec: the wrapper must stay alive to write exit.json.
"$@" >>"$RUN_DIR/events.jsonl" 2>>"$RUN_DIR/stderr.log" </dev/null &
CHILD=$!
printf '%s\n' "$CHILD" >"$RUN_DIR/child.pid"

wait_for_child "$CHILD"
CODE=$?
write_exit "$CODE"
exit "$CODE"
