#!/bin/bash
# Prüft Vite-Port; fragt bei Konflikt nach, ob bestehende Prozesse
# gekillt werden sollen.

set -e

PORTS="3120"
PIDS=$(lsof -ti:$PORTS 2>/dev/null || true)

if [ -n "$PIDS" ]; then
  echo "Port $PORTS ist belegt:"
  ps -p $PIDS -o pid,command 2>/dev/null | sed 's/^/  /'
  echo
  read -p "Bestehende Prozesse killen? [Y/n] " -n 1 -r REPLY
  echo
  if [[ -z "$REPLY" || $REPLY =~ ^[Yy]$ ]]; then
    kill $PIDS 2>/dev/null || true
    for i in 1 2 3 4 5; do
      sleep 0.2
      [ -z "$(lsof -ti:$PORTS 2>/dev/null)" ] && break
    done
    echo "Gekillt."
  else
    echo "Abgebrochen. Prozesse manuell beenden mit:"
    echo "  kill $PIDS"
    exit 1
  fi
fi
