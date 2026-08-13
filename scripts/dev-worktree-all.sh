#!/bin/bash
#
# Every instance profile, served from THIS checkout, on the worktree preview pool.
#
# The problem it solves: a worktree preview shows the branch's code in exactly one
# data constellation, so a change that behaves differently against a database, a
# JSON file and a notes directory looks fine right up to the moment somebody opens
# the other instance. The instances themselves already share one checkout by design
# (AGENTS.md → „Two instances from one checkout"); what was missing is the same
# thing for a branch.
#
# It never touches the instance ports. A worktree server that occupies one is the
# failure this exists to prevent: the supervised instance is then either dead or
# serving a branch, and nothing on screen says which. See „Worktree live preview:
# never stop PM2" in .claude/local-setup.md if this machine has it.
#
#   bash scripts/dev-worktree-all.sh                  # every profile found
#   bash scripts/dev-worktree-all.sh test fiction     # only these
#   bash scripts/dev-worktree-all.sh --dry-run        # print the plan, start nothing
#   WT_PORT_BASE=31205 bash scripts/dev-worktree-all.sh
#
# Ports count up from WT_PORT_BASE (31200 by default), one per profile, in the
# order given. Ctrl-C stops all of them.

set -uo pipefail
cd "$(dirname "$0")/.."

PORT_BASE="${WT_PORT_BASE:-31200}"
PROFILE_DIR="${TIMELINES_INSTANCE_DIR:-$HOME/.config/zeitlines/instances}"

# Profiles are discovered, not listed: a new instance appears here by existing.
# `*.netlify.env` and friends are excluded — a profile with a dot in it is a
# sidecar for one deployment's host config, not something to serve.
discover() {
  local f name
  for f in "$PROFILE_DIR"/*.env; do
    [ -e "$f" ] || continue
    name="$(basename "$f" .env)"
    case "$name" in *.*) continue ;; esac
    echo "$name"
  done
}

# A `while read` loop rather than `mapfile`: macOS ships bash 3.2, where `mapfile`
# does not exist. The script would die on the machine it was written for.
AVAILABLE=()
while IFS= read -r line; do
  [ -n "$line" ] && AVAILABLE+=("$line")
done <<EOF
$(discover)
EOF

DRY_RUN=""
PROFILES=()
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    -*)
      echo "dev:worktree:all: unbekannte Option: $arg" >&2
      echo "  Nutzung: bash $0 [--dry-run] [profil ...]" >&2
      exit 1
      ;;
    *) PROFILES+=("$arg") ;;
  esac
done

# An argument that is not a profile is refused rather than passed to Vite as one.
# Unvalidated, a typo (or a flag this script does not know) starts a server for an
# instance that does not exist — which looks like it worked, occupies a port, and is
# then cleaned up by killing whatever is on it. That is how somebody else's preview
# server gets killed.
if [ "${#PROFILES[@]:-0}" -gt 0 ]; then
  for want in "${PROFILES[@]}"; do
    found=""
    for have in "${AVAILABLE[@]:-}"; do [ "$want" = "$have" ] && found=1; done
    [ -n "$found" ] && continue
    echo "dev:worktree:all: kein Profil namens $want in $PROFILE_DIR" >&2
    echo "  vorhanden: ${AVAILABLE[*]:-(keine)}" >&2
    exit 1
  done
else
  PROFILES=("${AVAILABLE[@]:-}")
fi

if [ "${#PROFILES[@]:-0}" -eq 0 ]; then
  echo "dev:worktree:all: keine Profile in $PROFILE_DIR" >&2
  exit 1
fi

# A port in use is a hard stop rather than a shuffle: `strictPort` would fail per
# server and leave a half-started set, which is worse than not starting.
for i in "${!PROFILES[@]}"; do
  port=$((PORT_BASE + i))
  if lsof -nP -iTCP:"$port" -sTCP:LISTEN -t >/dev/null 2>&1; then
    echo "dev:worktree:all: Port $port ist belegt (${PROFILES[$i]})." >&2
    echo "  Anderen Block wählen: WT_PORT_BASE=$((PORT_BASE + 5)) bash $0 ${PROFILES[*]}" >&2
    exit 1
  fi
done

if [ -n "$DRY_RUN" ]; then
  echo "Worktree: $(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo '?') in $(pwd)"
  for i in "${!PROFILES[@]}"; do
    printf '  %-10s http://localhost:%s   TIMELINES_DATA_DIR=wt-%s\n' \
      "${PROFILES[$i]}" "$((PORT_BASE + i))" "${PROFILES[$i]}"
  done
  echo "(--dry-run: nichts gestartet)"
  exit 0
fi

PIDS=()

# Killing the recorded pid is not enough: it is the `npm run` wrapper, and Vite is
# its child. Terminating only the wrapper leaves three servers holding three ports
# with nothing supervising them — and the next person cleans that up by killing
# whatever sits on the port, which is how a *different* session's preview server
# dies. So take the descendants first, deepest last.
kill_tree() {
  local pid="$1" child
  for child in $(pgrep -P "$pid" 2>/dev/null); do kill_tree "$child"; done
  kill "$pid" 2>/dev/null
}

cleanup() {
  trap - INT TERM EXIT
  for pid in "${PIDS[@]:-}"; do kill_tree "$pid"; done
  wait 2>/dev/null
}
trap cleanup INT TERM EXIT

echo "Worktree: $(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo '?') in $(pwd)"
for i in "${!PROFILES[@]}"; do
  profile="${PROFILES[$i]}"
  port=$((PORT_BASE + i))
  # Its own build output per server, and this is not optional: `build:data` writes
  # to public/<TIMELINES_DATA_DIR>/, so two servers sharing one directory overwrite
  # each other's config.json. The symptom is not an error — the older server keeps
  # running and starts serving the other one's timeline, which reads as a data bug
  # in whatever is being debugged (AGENTS.md → „Two servers out of the *same*
  # checkout collide the same way").
  TIMELINES_INSTANCE="$profile" \
  TIMELINES_DATA_DIR="wt-$profile" \
  WT_PORT="$port" \
    npm run dev:worktree >"/tmp/zeitlines-wt-$profile.log" 2>&1 &
  PIDS+=("$!")
  printf '  %-10s http://localhost:%s   (log: /tmp/zeitlines-wt-%s.log)\n' "$profile" "$port" "$profile"
done

echo
echo "Ctrl-C beendet alle. Die betreuten Instanzen auf 3120+ bleiben unberührt."
wait
