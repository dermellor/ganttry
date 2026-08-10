/**
 * Vertical lane transitions — an experiment.
 *
 * Panning horizontally eventually re-centres the packing neighbourhood
 * (`repackLanes` in [`render.ts`](./render.ts)), and every item whose lane
 * changed is repositioned by vis inside a single frame. That is the vertical
 * jump this smooths over: the horizontal travel is what the user is driving, so
 * the vertical step reads as the layout snapping out from under it.
 *
 * FLIP, not a CSS transition on the property vis writes, for two reasons that
 * both come out of vis-timeline's own item code:
 *
 * - A point item carries **both axes in one `transform`** (`Item.repositionXY`
 *   writes `translate(x, y)`), so `transition: transform` would smear the pan
 *   itself into a lag. A range item writes `top` instead, so a single CSS rule
 *   could not cover both types anyway.
 * - vis rewrites those inline styles every frame of a pan. A Web Animations
 *   effect with `composite: 'add'` sits *on top of* the inline value rather than
 *   replacing it, so vis keeps full control of where the item belongs and this
 *   only contributes a decaying offset. Two shifts that overlap in time stack
 *   the same way, each carrying its own true distance.
 *
 * **The measurement deliberately avoids `getBoundingClientRect`.** A rect
 * includes the offset this module is itself animating, so a re-pack that lands
 * while an earlier shift is still easing reads the eased position as the "before"
 * and invents a delta for an item that never moved — every animating item then
 * spawns a fresh animation on every frame. Measured on a continuous zoom over a
 * 752-item timeline: 8817 animations where 761 items had actually moved. vis's
 * own `item.top` / `Group.top` are plain layout numbers, untouched by transforms,
 * so they give the position the item *would* sit at with nothing animating —
 * which is the only stable thing to difference against. (Reaching into those
 * internals is the established way to read item geometry here; `arrows.ts` and
 * `hierarchyFolders.ts` do the same.)
 */

// Long enough to read as movement, short enough that a re-centre mid-pan is over
// before the pointer has travelled far. Tuning knob for the experiment.
const SHIFT_MS = 260;
// Fast out, settle in — the item should look like it is catching up with a
// layout that has already happened, which is exactly what it is doing.
const SHIFT_EASING = 'cubic-bezier(0.2, 0, 0, 1)';
// Below this the "jump" is sub-pixel rounding, not a lane change.
const MIN_SHIFT_PX = 1;

/**
 * Above this many lanes, a track's items are not animated.
 *
 * The animation buys one thing: you can follow an individual item to its new
 * row. Once a track is a wall of bars that stops being true, and easing a
 * hundred of them at once is motion without information.
 *
 * Lane count is the signal rather than the number of items on screen, because
 * vis unmounts items outside the *vertical* viewport too — on a 752-item test
 * timeline, widening the window from two to four years took the mounted count
 * *down* from 292 to 191 while the densest track went from 10 lanes to 16.
 * Lanes climb monotonically across the whole zoom range (5, 5, 6, 6, 7, 10, 16,
 * 26 from one month to eight years), which is what makes them usable at all.
 *
 * **Per track, and that correction came from real data.** Taking the maximum
 * over the whole timeline looked equivalent on an evenly generated fixture and
 * fell over on the first live one: fifteen tracks at
 * `[1, 1, 9, 7, 4, 3, 2, 1, 6, 26, 3, 1, 6, 10, 1]` lanes, so a single outlier
 * track switched the animation off on the fourteen readable ones. A track is
 * its own visual field here — `stack: false` with fixed lanes means nothing
 * crosses between them — so one track opting out while its neighbours ease is
 * the behaviour that matches what you can actually follow.
 */
const DENSE_LANE_LIMIT = 12;

// Background items are the phase tints: full-height chrome that never sits in a
// lane. A box item's `.vis-line` is the stem down to the axis, whose *height*
// changes rather than its position, so translating it would detach it from its
// own dot.
const ITEM_SELECTOR = '.vis-item:not(.vis-background):not(.vis-line)';

type Positions = Map<HTMLElement, number>;

/** vis hangs the Item instance off its own DOM (`ItemSet.itemFromElement`). */
type VisItem = { top?: number; parent?: { top?: number; groupId?: string | number } };

/** Lanes each track was packed into, by group id. */
export type LaneCounts = Map<string, number>;

function visItem(el: HTMLElement): VisItem | undefined {
  return (el as unknown as Record<string, VisItem | undefined>)['vis-item'];
}

/**
 * Where the item sits vertically inside the item set, in layout terms: the
 * track's offset plus the item's offset inside it. `null` for anything vis has
 * not positioned yet, which is skipped rather than animated from zero.
 */
function basePos(el: HTMLElement): number | null {
  const item = visItem(el);
  const own = item?.top;
  const track = item?.parent?.top;
  return typeof own === 'number' && typeof track === 'number' ? track + own : null;
}

/** Whether this item's track is still sparse enough for the movement to read. */
function trackIsFollowable(el: HTMLElement, lanes: LaneCounts): boolean {
  const groupId = visItem(el)?.parent?.groupId;
  return (lanes.get(String(groupId)) ?? 1) <= DENSE_LANE_LIMIT;
}

function prefersReducedMotion(): boolean {
  return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
}

function capture(host: HTMLElement, lanes: LaneCounts): Positions {
  const positions: Positions = new Map();
  for (const el of host.querySelectorAll<HTMLElement>(ITEM_SELECTOR)) {
    if (!trackIsFollowable(el, lanes)) continue;
    const pos = basePos(el);
    if (pos !== null) positions.set(el, pos);
  }
  return positions;
}

/**
 * Play the difference between `before` and the current layout as a decaying
 * vertical offset. `onFrame` runs once per frame for as long as anything is
 * moving, and is where the overlays that derive their geometry from item
 * positions (the dependency arrows) get to keep up — they read
 * `getBoundingClientRect`, which reports the animated position.
 */
function playShift(before: Positions, onFrame?: () => void): void {
  let moved = 0;
  for (const [el, was] of before) {
    if (!el.isConnected) continue;
    const now = basePos(el);
    if (now === null) continue;
    const delta = was - now;
    if (Math.abs(delta) < MIN_SHIFT_PX) continue;
    el.animate(
      [{ transform: `translateY(${delta}px)` }, { transform: 'translateY(0px)' }],
      { duration: SHIFT_MS, easing: SHIFT_EASING, composite: 'add' },
    );
    moved++;
  }
  if (!moved || !onFrame) return;

  const until = performance.now() + SHIFT_MS;
  const tick = (): void => {
    onFrame();
    if (performance.now() < until) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

/**
 * Run `mutate` — a DataSet update or a redraw that repositions items — and
 * animate whatever it moved vertically.
 *
 * The timing rests on vis throttling its own redraw through
 * `requestAnimationFrame`: the frame that runs `mutate` only *schedules* the
 * reposition, and the callback registered here lands in the same frame as
 * vis's but after it, so the new positions are readable and nothing has been
 * painted in between. Without that ordering the jump shows for one frame before
 * the offset covers it.
 */
export function withLaneShift(
  host: HTMLElement,
  mutate: () => void,
  { lanes, onFrame }: { lanes: LaneCounts; onFrame?: () => void },
): void {
  if (prefersReducedMotion()) {
    mutate();
    return;
  }
  // A track that gets denser is judged by the lane count it had when it was
  // still followable: the item is leaving a layout the user could read, so the
  // move out of it is the one worth showing.
  const before = capture(host, lanes);
  mutate();
  requestAnimationFrame(() => playShift(before, onFrame));
}
