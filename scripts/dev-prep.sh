#!/bin/bash
# Prüft Vite-Port; fragt bei Konflikt nach, ob bestehende Prozesse
# gekillt werden sollen.

set -e

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
