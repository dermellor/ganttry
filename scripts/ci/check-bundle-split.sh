#!/usr/bin/env bash
#
# Acceptance check for the plugin code split ("Plugins" (docs/architecture.md)): a
# generic build must download no plugin *view* code and no plugin CSS. A plugin's
# views and its stylesheet belong in its own lazily-loaded chunk.
#
# The check has two halves, and the second one is what keeps it honest: a marker
# must be absent from the entry chunk AND present in some lazy chunk. Test only
# the absence and the check turns into a silent pass the day somebody renames
# those classes.
#
# **The markers are derived, not listed.** They used to be five hardcoded class
# names of one plugin — a plugin fact in a core script, so uninstalling that
# plugin would have broken this check rather than merely shortened it (#18). Now
# each plugin's own stylesheet supplies them: a few class selectors out of
# `src/plugins/<id>/*.css`, which is exactly the set that must not reach the
# entry bundle. A new plugin is covered the moment it ships a stylesheet, and a
# renamed class updates the check by itself.
#
# Run after `npm run build`. Used by .github/workflows/ci.yml and runnable
# locally: bash scripts/ci/check-bundle-split.sh
set -euo pipefail

cd "$(dirname "$0")/../.."

if [ ! -f dist/index.html ]; then
  echo "check-bundle-split: dist/index.html not found — run 'npm run build' first." >&2
  exit 1
fi

entry=$(grep -oE 'assets/index-[A-Za-z0-9_-]+\.js' dist/index.html | head -1)
if [ -z "$entry" ]; then
  echo "check-bundle-split: could not determine the entry chunk from dist/index.html." >&2
  exit 1
fi
entry_css=$(grep -oE 'assets/index-[A-Za-z0-9_-]+\.css' dist/index.html | head -1)
if [ -z "$entry_css" ]; then
  echo "check-bundle-split: could not determine the entry stylesheet from dist/index.html." >&2
  exit 1
fi
echo "entry chunk: $entry"
echo "entry stylesheet: $entry_css"

# The longest class names of each plugin stylesheet. Longest rather than first,
# because a long, prefixed name is the one least likely to collide with a core
# class by accident — and a collision here reads as "the split is broken" when it
# is only a name clash. Six per plugin is enough to cover more than one view.
markers=()
shopt -s nullglob
for css in src/plugins/*/*.css; do
  plugin=$(basename "$(dirname "$css")")
  found=$(grep -oE '\.[a-zA-Z][a-zA-Z0-9_-]{5,}' "$css" \
    | tr -d '.' | sort -u | awk '{ print length, $0 }' | sort -rn | head -6 | cut -d' ' -f2-)
  if [ -z "$found" ]; then
    echo "check-bundle-split: $css yields no usable class names — the check would pass vacuously for $plugin." >&2
    exit 1
  fi
  echo "markers from $plugin: $(echo "$found" | tr '\n' ' ')"
  while IFS= read -r m; do markers+=("$m"); done <<< "$found"
done
shopt -u nullglob

if [ "${#markers[@]}" -eq 0 ]; then
  echo "check-bundle-split: no plugin stylesheet found under src/plugins/*/ — nothing to check." >&2
  echo "                    That is a pass only if no plugin ships a view. Verify before ignoring." >&2
  exit 1
fi

failed=0

for marker in "${markers[@]}"; do
  # `grep` exits 1 when it finds nothing, which here is the success case — so
  # each grep is guarded, or `set -e` plus `pipefail` would abort the script
  # exactly when the check is passing.
  # Both halves search JS *and* CSS assets: a plugin's stylesheet is imported by
  # its module, so Rollup emits it as a chunk-scoped .css file rather than folding
  # it into the entry stylesheet.
  in_entry=$({ grep -o "$marker" "dist/$entry" "dist/$entry_css" 2>/dev/null || true; } | wc -l | tr -d ' ')
  anywhere=$({ grep -l "$marker" dist/assets/*.js dist/assets/*.css 2>/dev/null || true; } | grep -v "$entry\|$entry_css" | wc -l | tr -d ' ')

  if [ "$in_entry" -gt 0 ]; then
    echo "FAIL  $marker: present in the entry chunk/stylesheet ($in_entry hits) — plugin code is no longer code-split." >&2
    failed=1
  elif [ "$anywhere" -eq 0 ]; then
    echo "FAIL  $marker: declared in a plugin stylesheet but in no built chunk — the build dropped it." >&2
    failed=1
  else
    echo "ok    $marker: absent from entry, present in $anywhere lazy chunk(s)"
  fi
done

if [ "$failed" -ne 0 ]; then
  echo "" >&2
  echo "The generic bundle must not carry plugin view code or plugin CSS. See „Plugins\" (docs/architecture.md)." >&2
  exit 1
fi

echo "check-bundle-split: ok"
