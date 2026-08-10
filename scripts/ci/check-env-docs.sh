#!/usr/bin/env bash
#
# Every environment variable README's Configuration table documents must be read
# somewhere in the code.
#
# The failure this catches is a documented knob that nothing reads. A reader sets
# it, nothing happens, and the tool looks broken rather than the documentation.
# It is invisible to every other check: the schemas cover data files, openapi.yaml
# covers routes, and no test asserts anything about prose. It happened twice at
# once — TIMELINES_NOTES_DIR and TIMELINES_STATIC_ONLY outlived the Markdown notes
# pipeline by several releases, and both read as current documentation.
#
# Only README's table is parsed, deliberately. docs/ mentions retired variables ON
# PURPOSE, in „what used to be here" sections (docs/deploy.md, docs/local-sources.md),
# and a checker that cannot tell a historical note from a live claim would either
# fail on those or need an ignore list that goes stale on its own. The table is the
# one place that states „set this and it works", so it is the one place to police.
#
# A name counts as read if it appears in any tracked non-Markdown file: a string
# literal, a constant (ENV_FILE_VAR in scripts/db/env.ts), or netlify.toml. Testing
# for a call shape like envValue('X') instead would miss all three indirections and
# reintroduce the false positives this check exists to avoid.
#
# Run after nothing in particular; it reads the tree, not the build.
set -euo pipefail

cd "$(dirname "$0")/../.."

# The first cell of each row in the section, which is where the variable names
# live; the description cell may name others (TIMELINES_DATABASE_URL_<NAMESPACE>)
# that are prefixes rather than variables of their own.
documented=$(
  awk '
    /^## Configuration$/ { in_section = 1; next }
    in_section && /^## / { exit }
    in_section && /^\|/ {
      split($0, cells, "|")
      print cells[2]
    }
  ' README.md | grep -oE '`[A-Z][A-Z0-9_]+`' | tr -d '`' | sort -u
)

if [ -z "$documented" ]; then
  echo "check-env-docs: no variables found in README's Configuration table" >&2
  echo "  the table moved or its heading changed, so this check silently stopped checking" >&2
  exit 1
fi

# `git grep` searches tracked files only, so an untracked scratch file cannot make a
# dead variable look alive. Three exclusions, all of them documentation rather than
# readers — a variable mentioned only in these is still unread by the code:
#   *.md          — including the README the names were just taken from.
#   .env.example  — a template of what to set, and the second place the retired
#                   TIMELINES_NOTES_DIR survived. Counting it would have let this
#                   check pass on the very bug it was written for.
#   this script   — its comments name the two variables that motivated it, which
#                   would otherwise satisfy the lookup it performs.
EXCLUDES="
:(exclude)*.md
:(exclude).env.example
:(exclude)scripts/ci/check-env-docs.sh
"

missing=0
for var in $documented; do
  if git grep -F -l -- "$var" -- $EXCLUDES >/dev/null 2>&1; then
    echo "ok    $var"
  else
    echo "FAIL  $var is documented in README but read nowhere in the code" >&2
    missing=$((missing + 1))
  fi
done

if [ "$missing" -gt 0 ]; then
  echo "check-env-docs: $missing documented variable(s) that nothing reads" >&2
  echo "  either the code stopped reading them (drop the row) or they were never wired up" >&2
  exit 1
fi

echo "check-env-docs: ok"
