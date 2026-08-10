#!/usr/bin/env bash
#
# Enforces the design-system contract (docs/design-system.md).
#
# The contract is four sentences of prose, and prose does not survive contact
# with the next contributor — this repo already prefers a test over discipline
# (see the OpenAPI drift test in AGENTS.md). What follows are the three rules
# that can be checked mechanically:
#
#   1. A colour is named once. A literal is allowed in a custom-property
#      declaration and nowhere else, so every colour in the product has a name
#      that a theme can override.
#   2. Spacing comes from the scale. A raw px value in padding/margin/gap is
#      what makes two surfaces sit 12px and 14px from their edge for no reason.
#   3. A `<button>` comes from the Button component. A hand-rolled one is how
#      the viewer ended up with seven button treatments in five stylesheets.
#
# Not checked, because a checker would need to understand intent: whether a new
# component belongs in the layer at all, and whether its variants are the right
# ones. That is what review is for.
#
# Runnable locally: bash scripts/ci/check-design-system.sh
set -uo pipefail

cd "$(dirname "$0")/../.."

failed=0

# `report <rule> <file:line>…` — prints the offending lines and trips the exit.
report() {
  local rule="$1"
  shift
  echo "FAIL  $rule" >&2
  printf '%s\n' "$@" | sed 's/^/      /' >&2
  failed=1
}

# ---------------------------------------------------------------------------
# 1. Colour literals outside a custom-property declaration
# ---------------------------------------------------------------------------
#
# The token layer is the exception by definition: it is where the names are
# assigned. Everything else — including a plugin's own stylesheet — may define
# its own custom properties and must then use them by name.
#
# `--x: #abc` is allowed; `color: #abc` is not. The distinction is the `--` at
# the start of the property, which is what makes the value nameable and
# therefore themeable.
#
# Three further exemptions, each because the thing being written is not a colour
# a theme would ever want to change:
#
#   `hsl(var(--…) …)`  a colour *computed* from a named token — the presence hue
#                      is one number per person, and the saturation and lightness
#                      around it are the formula, not a palette entry.
#   `mask` / `-webkit-mask`
#                      a mask's colour is an alpha stencil: `#000` there means
#                      „opaque", and recolouring it would break the mask.
#   `transparent`      not a colour literal at all, but it lands in the same
#                      declarations as one.

colour_hits=$(
  grep -rnE '(#[0-9a-fA-F]{3,8}\b|\b(rgba?|hsla?)\()' \
    --include='*.css' src 2>/dev/null |
    grep -v '^src/design-system/tokens/' |
    # A declaration that *assigns* a custom property, with any leading space.
    grep -vE ':[0-9]+: *--[A-Za-z0-9-]+ *:' |
    # Data URLs carry `%23` for `#`, and an SVG's own fills are part of the asset.
    grep -v 'url("data:' |
    grep -vE 'hsla?\( *var\(--' |
    grep -vE '^[^:]*:[0-9]+: *(-webkit-)?mask' ||
    true
)
[ -n "$colour_hits" ] && report \
  "a colour literal outside a custom-property declaration — name it in a \`--…\` first, then use the name" \
  "$colour_hits"

# ---------------------------------------------------------------------------
# 2. Raw px in padding / margin / gap
# ---------------------------------------------------------------------------
#
# `0` and `1px` are allowed: zero is not a step on a scale, and 1px is a
# hairline, which is a border's width rather than an amount of air. Negative
# values are allowed too — a component pulling itself back over its own padding
# is geometry, not spacing (see the editable headline in Text.css).

spacing_hits=$(
  grep -rnE '^[^/*]*\b(padding|margin|gap|row-gap|column-gap)(-(top|right|bottom|left|inline|block))?: *[^;]*[0-9]+px' \
    --include='*.css' src 2>/dev/null |
    # A hairline, and the negative pull-backs.
    grep -vE ': *-?1px' |
    grep -vE ': *-[0-9]+px' |
    true
)
[ -n "$spacing_hits" ] && report \
  "spacing in raw px — use a step from the --space-* scale" \
  "$spacing_hits"

# ---------------------------------------------------------------------------
# 3. Buttons built by hand
# ---------------------------------------------------------------------------
#
# Both spellings: markup in a template literal, and `createElement('button')`.
#
# Three files are exempt, and each exemption is named here rather than worked
# around silently:
#
#   src/design-system/   where the button is defined.
#   src/export.ts        its client script runs in a standalone file with no
#                        module loader, so it has to write the component's
#                        markup out by hand. The classes it writes are the
#                        contract, and they are commented as such there.
#   src/itemRail.ts      the delete affordance inside a timeline bar. It is a
#   src/itemCollapse.ts  `<button>` for the hit area and the keyboard, and
#                        nothing else: the rail's stylesheet sets its box, its
#                        position, its glyph and its resting opacity. Rendering
#                        either as an IconButton and then overriding every visual
#                        property the component brings would be the violation
#                        wearing the component's name. Note that the *list's*
#                        fold caret is not exempt — it sits in ordinary layout,
#                        and it is the `TreeToggle` component.
#   src/milestoneRail.ts the same bare hit area again, one panel up: a 10px
#                        diamond absolutely positioned on the axis line, whose
#                        box, rotation, colour and ring all come from
#                        timeline.css. The element is a `<button>` so the mark
#                        can be reached by keyboard and carry an `aria-label` —
#                        there is no text node to read a name from.

button_hits=$(
  grep -rnE "<button|createElement\('button'\)|createElement\(\"button\"\)" \
    --include='*.ts' src 2>/dev/null |
    grep -v '^src/design-system/' |
    grep -v '^src/export.ts:' |
    grep -v '^src/itemRail.ts:' |
    grep -v '^src/itemCollapse.ts:' |
    grep -v '^src/milestoneRail.ts:' ||
    true
)
[ -n "$button_hits" ] && report \
  "a hand-built <button> — use Button or IconButton from the design system" \
  "$button_hits"

# ---------------------------------------------------------------------------
# 4. Every exported component appears in the playground
# ---------------------------------------------------------------------------
#
# A component whose states you can only reach by driving the app through six
# clicks is a component nobody looks at, and the empty and error states are the
# ones that rot. This checks presence, not coverage: it cannot tell whether all
# of a component's variants are shown, only that the component is on the page
# at all.

missing=()
while IFS= read -r name; do
  grep -q "\b$name\b" src/playground/main.ts || missing+=("$name")
done < <(
  grep -hoE '^export function [A-Z][A-Za-z]+' src/design-system/components/*.ts |
    sed 's/^export function //' |
    sort -u
)
[ ${#missing[@]} -gt 0 ] && report \
  "exported component(s) missing from the playground (src/playground/main.ts)" \
  "${missing[@]}"

if [ "$failed" -ne 0 ]; then
  echo "" >&2
  echo "The design-system contract is in docs/design-system.md." >&2
  exit 1
fi

echo "check-design-system: ok"
