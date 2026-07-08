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

# Node spawns this wrapper with detached:true, making it the session/pgroup
# leader. Do not exec: the wrapper must stay alive to write exit.json.
"$@" >>"$RUN_DIR/events.jsonl" 2>>"$RUN_DIR/stderr.log" </dev/null &
CHILD=$!
printf '%s\n' "$CHILD" >"$RUN_DIR/child.pid"

forward_term() {
  kill -TERM "$CHILD" 2>/dev/null || true
}
trap forward_term TERM INT

while true; do
  wait "$CHILD"
  CODE=$?
  if [[ "$CODE" -gt 128 ]] && kill -0 "$CHILD" 2>/dev/null; then
    continue
  fi
  break
done

ENDED_AT="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
printf '{"code":%s,"endedAt":"%s"}\n' "$CODE" "$ENDED_AT" >"$RUN_DIR/exit.json.tmp"
mv "$RUN_DIR/exit.json.tmp" "$RUN_DIR/exit.json"
exit "$CODE"
