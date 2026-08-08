#!/usr/bin/env bash
#
# Acceptance check for the plugin code split (AGENTS.md → "Plugins"): a generic
# build must download no plugin *view* code, and no plugin CSS. A plugin's views
# and stylesheet are expected to live in its own lazily-loaded chunk.
#
# The check has two halves, and the second one is what keeps it honest: the
# markers must be absent from the entry chunk, but present in SOME chunk. Test
# only the absence and the check turns into a silent pass the day someone
# renames those CSS classes.
#
# Run after `npm run build`. Used by .github/workflows/ci.yml and runnable
# locally: bash scripts/ci/check-bundle-split.sh
set -euo pipefail

cd "$(dirname "$0")/../.."

# Markers: CSS class names emitted only by a plugin's own views, plus one from
# its stylesheet. The CSS marker is what proves the second half of the promise —
# the stylesheet used to be a <link> in index.html, so every visitor downloaded it
# whether or not the deploy had the plugin at all.
MARKERS=(pm-cell-ver pm-cell-editable pricing-badge-new pc-card pricing-view)

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

failed=0

for marker in "${MARKERS[@]}"; do
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
    echo "FAIL  $marker: not found in any chunk — the marker is stale, so this check proves nothing." >&2
    echo "      Update MARKERS in scripts/ci/check-bundle-split.sh to names a plugin view still emits." >&2
    failed=1
  else
    echo "ok    $marker: absent from entry, present in $anywhere lazy chunk(s)"
  fi
done

if [ "$failed" -ne 0 ]; then
  echo "" >&2
  echo "The generic bundle must not carry plugin view code or plugin CSS. See AGENTS.md → 'Plugins'." >&2
  exit 1
fi

echo "check-bundle-split: ok"
