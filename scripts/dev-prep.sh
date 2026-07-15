#!/bin/bash
# Prüft Vite-Port; fragt bei Konflikt nach, ob bestehende Prozesse
# gekillt werden sollen. Vorher: lokales `main` auf `origin/main` nachziehen.

set -e

# --- Base invariant: local `main` mirrors `origin/main` (AGENTS.md) ---
# The dev server serves from THIS checkout. After a PR merged on GitHub the local
# `main` is stale, so the running app shows old code — the "I don't see my change"
# trap. Auto-heal it, but only when provably safe: on `main`, clean tree,
# fast-forward only. `--ff-only` refuses (never rewrites) on divergence, so this
# can only catch up, never clobber; it never pushes. `dev:worktree` bypasses this
# script by design, so it won't fire inside a worktree (where ff-only main is wrong).
sync_main_with_origin() {
  git rev-parse --is-inside-work-tree >/dev/null 2>&1 || return 0
  [ "$(git rev-parse --abbrev-ref HEAD 2>/dev/null)" = "main" ] || return 0
  [ -z "$(git status --porcelain 2>/dev/null)" ] || {
    echo "dev-prep: working tree nicht sauber — origin/main-Sync übersprungen."; return 0; }
  git fetch --quiet origin 2>/dev/null || {
    echo "dev-prep: git fetch fehlgeschlagen (offline?) — Sync übersprungen."; return 0; }
  if git merge --ff-only -q origin/main 2>/dev/null; then
    :
  else
    echo "dev-prep: lokales main weicht von origin/main ab (kein Fast-Forward) — bitte manuell reconcilen (siehe AGENTS.md → Base invariant)."
  fi
}
sync_main_with_origin

PORTS="3120"
# Only a real *listener* blocks binding to the port. Match `-sTCP:LISTEN` so we
# don't trip over leftover client sockets in CLOSED/TIME_WAIT state (e.g. a
# browser or the Claude app that connected to a now-dead dev server) — those
# don't prevent a new server from listening, and killing their owner would take
# down the wrong process.
PIDS=$(lsof -ti:$PORTS -sTCP:LISTEN 2>/dev/null || true)

if [ -n "$PIDS" ]; then
  echo "Port $PORTS ist belegt:"
  ps -p $PIDS -o pid,command 2>/dev/null | sed 's/^/  /'
  echo
  # Under PM2 / any non-interactive run there is no TTY to prompt on; auto-kill
  # the stale listener instead of hanging on `read` (which would EOF and, with
  # `set -e`, abort the whole dev command into a crash loop).
  if [ -t 0 ]; then
    read -p "Bestehende Prozesse killen? [Y/n] " -n 1 -r REPLY
    echo
  else
    REPLY="Y"
    echo "Kein TTY — bestehende Prozesse werden automatisch beendet."
  fi
  if [[ -z "$REPLY" || $REPLY =~ ^[Yy]$ ]]; then
    kill $PIDS 2>/dev/null || true
    for i in 1 2 3 4 5; do
      sleep 0.2
      [ -z "$(lsof -ti:$PORTS -sTCP:LISTEN 2>/dev/null)" ] && break
    done
    echo "Gekillt."
  else
    echo "Abgebrochen. Prozesse manuell beenden mit:"
    echo "  kill $PIDS"
    exit 1
  fi
fi
