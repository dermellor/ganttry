// Timeline rendering and direct-manipulation handlers: builds the vis-timeline
// from the active view/source, keeps its DataSets in sync on live edits, and
// handles drag-move and add. Deleting hangs off the rail's own mark (itemRail.ts)
// and runs through itemForm's deleteItem, the same path the form's button takes.

import { Timeline, DataSet } from 'vis-timeline/standalone';
import { Callout } from './design-system';
import {
  assignLaneSubgroups,
  assignLanes,
  withBackgroundLabelItems,
  buildFromJson,
  decodeEntities,
  tagPillsHtml,
  withHierarchyMarks,
  withStatusMarks,
  type BuildResult,
  type TimelineGroup,
  type TimelineItem,
  type TimelineItemWithStart,
} from './buildItems';
import {
  isFilterActive,
  passesFilter,
  realIdOf,
  regroupForTimeline,
  resolveGrouping,
  syncGroupByControl,
} from './grouping';
import { syncFilterControl } from './filterControl';
import { GROUP_DIM } from './listGrouping';
import { DependencyArrows } from './arrows';
import { HierarchyFolders } from './hierarchyFolders';
import { PhaseBand } from './phaseBand';
import { MilestoneRail, railMarks } from './milestoneRail';
import { scrollItemIntoView } from './visGeometry';
import { withLaneShift } from './laneTransition';
import { iconSpanHtml } from './icons';
import { DEFAULT_STATUS } from './status';
import {
  ensureItemIds,
  findItemIndex,
  generateNewId,
  isoDateOnly,
  loadSource,
} from './editor';
import type { TimelineFile, TimelineFileItem, View } from './types';
import { durationToMs, parseLocalDay } from './date';
import { firstAssignableGroup, resolveAssignableGroup } from './groupHierarchy';
import { hiddenByCollapse, regroupSubtree } from './itemHierarchy';
import {
  state,
  els,
  setStatus,
  isEditableView,
  loadCollapsedItems,
  toggleItemCollapsed,
  syncUrl,
  MS_PER_DAY,
  TAG_TEXT_MIN_PX_PER_DAY,
} from './state';
import {
  markSelfEditing,
  publishSelfPresence,
  schedulePersist,
  setupRealtime,
  snapshotSaved,
} from './persistence';
import { attachItemPresence } from './itemPresence';
import { attachBackgroundItemSelection } from './backgroundItemSelection';
import { attachItemRail } from './itemRail';
import { attachItemCollapse } from './itemCollapse';
import { attachItemContextMenu } from './contextMenu';
import { attachOverrunLines } from './overrun';
import { deleteItem, setItemFieldValue, setItemStatus, showItemForm } from './itemForm';
import { showDetailForId, hideDetail } from './detailPanel';
import { renderListView } from './listView';
import { repaintPluginView } from './pluginHost/views';
import { notifyTimelineChanged } from './pluginHost/changes';
import { showPhaseFormByIndex, handlePhaseEdit } from './phaseForm';
import { hideTimelineSkeleton, showTimelineSkeleton } from './timelineSkeleton';

// Render-internal handles. `timeline` mirrors state.timeline (kept in sync on
// every assignment) so other modules can read the current instance while this
// module keeps a non-null-narrowable local for its own setup code. arrows,
// phaseBand, milestoneRail and the DataSets are only ever touched here.
let timeline: Timeline | null = null;
let arrows: DependencyArrows | null = null;
let hierarchyFolders: HierarchyFolders | null = null;
let phaseBand: PhaseBand | null = null;
let milestoneRail: MilestoneRail | null = null;
// Holds only start-bearing items (vis-timeline can't place a date-less item);
// `timelineItems()` narrows to that before every populate.
let itemsDs: DataSet<TimelineItemWithStart> | null = null;
let groupsDs: DataSet<TimelineGroup> | null = null;

// What the timeline actually shows for the current build + filter + grouping
// dimension. For the default 'group' dimension these mirror the build; for a
// tag/custom-field dimension the items are regrouped into value lanes (with
// multi-valued items cloned across lanes) and the id maps let selection/editing
// map a clone back to its real item. Recomputed by computeDisplay(); repackLanes
// and applyBuildToDataSets both operate on this display set, not the raw build.
let displayItems: TimelineItem[] = [];
let displayGroups: TimelineGroup[] = [];
let displayDeps = new Map<string, string[]>();
let displayToReal = new Map<string, string>();
let realToDisplay = new Map<string, string[]>();
// True when grouping by anything other than the item's own group — the timeline
// lanes are derived (tag/field values), so group-changing drags and dependency
// arrows are suppressed.
let regroupedMode = false;

// The display ids a real item currently renders as (its clones across lanes).
// Falls back to the id itself when not regrouped or the item has a single lane.
export function displayIdsFor(realId: string): string[] {
  return realToDisplay.get(realId) ?? [realId];
}

/**
 * Make `realId` the selected item: highlight it on the timeline, put it in the
 * URL, tell the other users, and open its detail/edit panel.
 *
 * The one selection path, shared by a click on the item itself and by a click on
 * its mark in the head rail — the rail's whole point is to behave like the item
 * it stands for, and a second copy of these five steps is how the two drift
 * (a rail click that forgets `publishSelfPresence`, say, goes unnoticed locally
 * and only shows up as a stale avatar on someone else's screen).
 *
 * `setSelection` runs unconditionally rather than only for multi-lane items:
 * from the rail nothing has selected the item yet, and re-selecting an already
 * selected item is a no-op for vis.
 *
 * The item is then scrolled into view if it isn't. From the rail that is the
 * whole point — its marks stand for milestones that are off screen, so opening a
 * form for a row the user still cannot see only answers half the click. For a
 * click on the item itself it costs nothing, since a visible item needs no
 * scrolling.
 */
function selectItemById(realId: string): void {
  state.selectedItemId = realId;
  const displayIds = displayIdsFor(realId);
  try {
    timeline?.setSelection(displayIds);
  } catch {
    /* item may not exist in this build */
  }
  // The first clone is arbitrary but stable — with several, any one of them
  // brings the item on screen, and scrolling to each in turn would just fight
  // itself.
  if (timeline && displayIds[0]) scrollItemIntoView(timeline, displayIds[0], els.timeline);
  syncUrl();
  publishSelfPresence();
  showDetailForId(realId);
}

// The parent map the lane packer may use for the current display set: the real
// one along the item's own group, empty once the lanes are derived values.
function displayParents(): Map<string, string> {
  return regroupedMode ? new Map() : state.activeBuild?.parents ?? new Map();
}

/**
 * An empty first row that reserves the strip taken by the overlays pinned to the
 * top of the center panel: the phase ribbon, the milestone rail, or both.
 *
 * Without a reservation an overlay sits on the first track. Reserving the strip
 * with CSS padding on the group set is what this replaces, and the reason is that
 * vis cannot see padding: it derives its content height *and* its vertical scroll
 * range from the sum of the group heights, so the panel ended up holding more than
 * vis knew about. The scroll then stopped short by the height of the reserve and
 * `.vis-timeline` (fixed height, `overflow: hidden`) cut off whatever hung below —
 * always the last track, which is exactly where a folded summary item leaves a
 * single short row.
 *
 * A group costs nothing to account for, because counting groups is what vis
 * already does. It carries no items, so nothing can be assigned to it, and it is
 * added *after* filtering and lane assignment: `pruneGroupsToItems` would drop an
 * item-less group, and `assignLanes` colours lanes by index, so prepending
 * earlier would shift every track's colour.
 *
 * Which overlays are present is decided here, and written into the strut as
 * classes, because vis measures that label once and keeps the number: a class
 * toggled on the container afterwards resizes the strut without vis ever hearing
 * about it, which is the same discrepancy the group replaced.
 */
export const BAND_SPACER_GROUP_ID = '__phase_band_spacer';

/**
 * The height vis may draw into: the container's **content** box.
 *
 * Not `clientHeight`, which includes padding — and `.timeline` pads its top.
 * Handing vis that number gave it a box of the container's full height, starting
 * one padding below the container's top edge, so its bottom 16px lay outside a
 * container that clips (`overflow: hidden`). No scroll position could reveal
 * them: vis counts those pixels as visible and ends its scroll range exactly that
 * much early, so the strip it swallowed was always the last track. That is why it
 * read as „the bottom row is cut off" rather than as a height being off by the
 * padding, and why it only showed on a timeline with enough tracks to scroll.
 */
function visViewportHeight(el: HTMLElement): number {
  const cs = getComputedStyle(el);
  return el.clientHeight - (parseFloat(cs.paddingTop) || 0) - (parseFloat(cs.paddingBottom) || 0);
}

function withBandSpacer(groups: TimelineGroup[]): TimelineGroup[] {
  // Keyed off the phases and the marks themselves, not off the `has-phase-band` /
  // `has-milestone-rail` classes: both are toggled further down, after
  // computeDisplay has already run, so the first render would come out without
  // the reservation.
  const hasPhases = (state.activeBuild?.phases.length ?? 0) > 0;
  // The rail's own predicate, so „is there a mark" cannot come to mean two
  // different things — the rail decides what it draws with the same call.
  const hasRail = railMarks(displayItems).length > 0;
  if ((!hasPhases && !hasRail) || groups.length === 0) return groups;
  // A strut, not an empty string: vis measures the label to get the group's
  // height, so the reserve has to be something it can measure.
  const strut = ['band-spacer-strut', hasPhases && 'reserves-band', hasRail && 'reserves-rail']
    .filter(Boolean)
    .join(' ');
  return [
    { id: BAND_SPACER_GROUP_ID, content: `<div class="${strut}"></div>`, className: 'band-spacer' },
    ...groups,
  ];
}

// vis-timeline editable config for the active source. When regrouped, the lanes
// are derived values (tags / custom-field), not the item's editable group — so a
// vertical drag between lanes (updateGroup) and double-click-to-add (which would
// guess a bogus group from the lane) are disabled. Horizontal move, resize and
// delete still work on the real item. Shared by the initial render and the live
// grouping switch.
function editableOptions(): false | Record<string, boolean> {
  return isEditableView()
    ? {
        updateTime: true,
        updateGroup: !regroupedMode,
        add: !regroupedMode,
        remove: false,
        overrideItems: false,
      }
    : false;
}

// Recompute the display items/groups for the active build, milestones filter and
// grouping dimension; refresh the shared dropdown and the id maps. Lanes get a
// coarse first pass here (no zoom info yet); repackLanes refines them once the
// timeline has a width. Returns the display set for the caller to feed the vis
// DataSets.
function computeDisplay(): { items: TimelineItem[]; groups: TimelineGroup[] } {
  const build = state.activeBuild;
  if (!build) {
    displayItems = [];
    displayGroups = [];
    displayDeps = new Map();
    displayToReal = new Map();
    realToDisplay = new Map();
    regroupedMode = false;
    return { items: [], groups: [] };
  }
  const filtered = filterBuildForDisplay(build);
  const entries = filtered.items.filter((it) => it.type !== 'background');
  const { dim, options } = resolveGrouping(entries);
  state.groupBy = dim;
  syncGroupByControl(options, dim);
  syncFilterControl();
  regroupedMode = dim !== GROUP_DIM;

  const regroup = regroupForTimeline(filtered.items, filtered.groups, dim, options);
  displayItems = withBackgroundLabelItems(regroup.items);
  displayGroups = regroup.groups;
  displayToReal = regroup.displayToReal;
  realToDisplay = regroup.realToDisplay;
  for (const item of displayItems) {
    if (!item.className?.split(/\s+/).includes('background-item-label')) continue;
    const realId = realIdOf(item.id);
    displayToReal.set(item.id, realId);
    const ids = realToDisplay.get(realId) ?? [realId];
    if (!ids.includes(item.id)) ids.push(item.id);
    realToDisplay.set(realId, ids);
  }
  // Cross-lane dependency arrows only make sense along the item's own group; a
  // tag/field regroup would tangle them across values, so it runs deps-free.
  displayDeps = regroupedMode ? new Map() : build.dependencies;

  // Like the dependency edges above, the hierarchy bands a track only along the
  // item's own group: a tag/field regroup renders an item once per lane it falls
  // into, and those clone ids are not what the parent map is keyed by.
  assignLaneSubgroups(displayItems, displayGroups, displayDeps, displayParents());
  assignLanes(displayItems, displayGroups);
  // The spacer is added last, on the way out — see withBandSpacer.
  return { items: displayItems, groups: withBandSpacer(displayGroups) };
}

// The gap vis-timeline leaves between two rows of a track, and half of it above
// and below the track's edges. Named because the lane pitch below is derived from
// it: the two have to agree or the label reserves the wrong height.
const ITEM_MARGIN_VERTICAL = 12;

// Vertical pitch of one lane, published to CSS as `--lane-pitch` so the group
// label can reserve `--lanes × pitch` (see LANE_COUNT_PROPERTY in buildItems.ts).
// Measured from a rendered bar rather than written down: the bar's height is a
// consequence of its padding, font and line-height, so a second copy of the number
// here would drift the moment a type token moves. The stylesheet carries a
// fallback for the first paint, before any bar exists to measure.
function syncLanePitch(): void {
  const bar = els.timeline.querySelector<HTMLElement>('.vis-item.vis-range, .vis-item.vis-box');
  const h = bar?.offsetHeight ?? 0;
  if (h > 0) els.timeline.style.setProperty('--lane-pitch', `${h + ITEM_MARGIN_VERTICAL}px`);
}

// Point-label measurement (see repackLanes). A single off-DOM canvas measures
// text width in the timeline's own font; results are cached by `font|text`.
// `labelFont` is resolved lazily from a rendered item and reset per render.
let measureCtx: CanvasRenderingContext2D | null = null;
let labelFont: string | null = null;
const labelWidthCache = new Map<string, number>();
let repackRaf = 0;

// Prune a group list to only those referenced by `items` — directly, or (for a
// parent/container) via a nested child that survives. Nested-group references are
// trimmed to the survivors too. Shared by the milestones-only filter and the
// value filter, both of which drop items and then need the empty lanes removed.
function pruneGroupsToItems(items: TimelineItem[], groups: TimelineGroup[]): TimelineGroup[] {
  const referenced = new Set<string>();
  for (const it of items) if (it.group) referenced.add(it.group);
  const keep = new Set<string>();
  const visit = (id: string): boolean => {
    if (keep.has(id)) return true;
    const g = groups.find((x) => x.id === id);
    if (!g) return false;
    let kept = referenced.has(id);
    if (g.nestedGroups) {
      for (const child of g.nestedGroups) {
        if (visit(child)) kept = true;
      }
    }
    if (kept) keep.add(id);
    return kept;
  };
  for (const g of groups) visit(g.id);
  return groups
    .filter((g) => keep.has(g.id))
    .map((g) =>
      g.nestedGroups
        ? { ...g, nestedGroups: g.nestedGroups.filter((c) => keep.has(c)) }
        : g,
    );
}

// Items + groups actually shown, after the milestones-only toggle and the value
// filter (both shared across the timeline and list views). Background phase-tint
// items always pass the value filter. Empty lanes are pruned once at the end.
export function filterBuildForDisplay(build: BuildResult): {
  items: TimelineItem[];
  groups: TimelineGroup[];
} {
  const filterOn = isFilterActive();
  // Folded subtrees are dropped here rather than in each view, so the timeline,
  // the list and the status-line counts all say the same thing about what is on
  // screen. It also runs before the tag/field regrouping, so a hidden child
  // never gets cloned into a lane in the first place.
  const hidden = hiddenByCollapse(build.parents, state.collapsedItems);
  if (!state.milestonesOnly && !filterOn && hidden.size === 0) {
    return { items: build.items, groups: build.groups };
  }
  let items = build.items;
  if (hidden.size) items = items.filter((it) => !hidden.has(it.id));
  if (state.milestonesOnly) items = items.filter((it) => it.type === 'point');
  if (filterOn) {
    items = items.filter((it) => it.type === 'background' || passesFilter(it, build.groups));
  }
  const groups = pruneGroupsToItems(items, build.groups);
  return { items, groups };
}

export function rebuildAndApply(prebuilt?: BuildResult): void {
  if (!state.activeView || !state.activeSourceFile || !timeline) return;
  const built = prebuilt ?? buildFromJson(state.activeView, state.activeSourceFile);
  state.activeBuild = built;
  applyBuildToDataSets();
  // buildFromJson packs lanes with zero-width points; restore the label-width
  // lanes for the current zoom so edits don't re-collapse milestones.
  repackLanes();
  if (arrows) arrows.setDependencies(built.dependencies);
  if (phaseBand) phaseBand.setPhases(built.phases);
  setStatus(statusFor(state.activeView, built));
}

/**
 * Reload the active source from the server and apply it to the *live* timeline,
 * instead of rebuilding the view from scratch. Used for remote changes.
 *
 * `renderTimeline` destroys the vis-timeline plus the arrows/phase-band overlays
 * and re-creates them (including their 100/500 ms retry redraws), so the
 * container is briefly empty and the whole view flashes. A collaborator editing
 * a form writes every `PERSIST_THROTTLE_MS`, which turned that into a continuous
 * flicker for everyone else watching the same timeline.
 *
 * Returns `false` when the in-place path can't represent the change — the caller
 * then falls back to the full rebuild.
 */
export async function refreshActiveSourceInPlace(view: View): Promise<boolean> {
  if (!view.source || !timeline) return false;
  if (state.activeView?.id !== view.id || state.activeSourceId !== view.source.id) return false;

  const loaded = await loadSource(view.source);
  // The await gave the user time to switch away; the reload is stale then.
  if (state.activeView?.id !== view.id || !timeline) return false;

  const file = loaded.file;
  ensureItemIds(file); // assigned in memory only — saved on first edit
  const built = buildFromJson(view, file);

  // The overlays are created once per timeline instance, and the ribbon also
  // needs the container's phase-band padding. Making one appear or disappear is
  // the full render path's job — rare, since it takes a remote edit that adds
  // the first or removes the last phase / dependency.
  if (built.phases.length > 0 !== Boolean(phaseBand)) return false;
  if (built.dependencies.size > 0 !== Boolean(arrows)) return false;

  state.activeSourceFile = file;
  state.activeSourceEditable = loaded.editable;
  state.activeSourceLive = loaded.live;
  snapshotSaved();
  rebuildAndApply(built);
  return true;
}

// Client-side timeline validation: vis-timeline needs a start to position an
// item, so start-less items (which the DB now allows) are kept out of the
// timeline DataSet. They still live in the build and show in the list view.
//
// Also the one seam every populate of the item DataSet passes through, so it is
// where the status gets stamped onto the bar as the rail's data mark
// (`withStatusMarks`, see buildItems.ts). „Now" is read once per populate, so
// every item in one repaint is judged against the same instant.
export function timelineItems(items: TimelineItem[]): TimelineItemWithStart[] {
  return withHierarchyMarks(
    withStatusMarks(
      items.filter((it): it is TimelineItemWithStart => !!it.start),
      Date.now(),
    ),
    state.activeBuild?.parents ?? new Map(),
    state.collapsedItems,
    realIdOf,
  );
}

export function applyBuildToDataSets(): void {
  if (!state.activeBuild) return;
  const display = computeDisplay();
  // `computeDisplay` has to support the first render, before a timeline exists,
  // so it assigns a coarse layout without point-label widths. During an update
  // (folding included) the live timeline already gives us the real zoom. Refine
  // the in-memory items *before* publishing them to vis: publishing the coarse
  // pass first made unrelated items jump into a hierarchy folder until the next
  // animation-frame repack moved them back out.
  packDisplayForCurrentZoom();
  // Diff the DataSets in place instead of clear()+add(). Clearing momentarily
  // empties the timeline, collapsing its content height — the browser then clamps
  // the vertical-scroll container's scrollTop to the top and vis-timeline latches
  // that, snapping the view up on every rebuild (live edits, drags, switching
  // items). update()/remove() keep the surviving rows mounted, so the height
  // never collapses and the scroll position is left untouched.
  if (itemsDs) syncDataSet(itemsDs, timelineItems(display.items));
  if (groupsDs) syncDataSet(groupsDs, display.groups);
  // The head rail reads the same display set, so it follows the filter and the
  // grouping dimension without a second derivation of "what is visible".
  milestoneRail?.setItems(display.items);
  hierarchyFolders?.setHierarchy(display.items, displayParents());
  // Keep the list view in sync when it's the active display (edits, drags,
  // milestones-only toggle all funnel through here).
  if (state.viewMode === 'list') renderListView();
  // Same for a plugin view (the pricing matrix's roadmap counts, say, depend on
  // item metadata). A plugin's chunk is loaded lazily; once entered it is cached,
  // so this repaint no-ops during the brief pre-load window.
  else repaintPluginView(state.viewMode);
}

// Reconcile a vis DataSet to `next` without ever emptying it: drop rows that are
// gone, then add/update the rest. Avoids the content-height collapse a clear()
// would cause (which resets vis-timeline's vertical scroll to the top).
function syncDataSet(ds: DataSet<any>, next: Array<{ id?: string | number }>): void {
  const nextIds = new Set(next.map((r) => String(r.id)));
  const stale = (ds.getIds() as (string | number)[]).filter((id) => !nextIds.has(String(id)));
  if (stale.length) ds.remove(stale);
  ds.update(next);
}

export function statusFor(view: View, build: BuildResult): string {
  const filtered = filterBuildForDisplay(build);
  const suffix = state.milestonesOnly ? ' · nur Meilensteine' : '';
  // Start-less items exist in the data but can't be placed on the timeline —
  // surface the count so they aren't silently missing from the timeline view.
  const dateless = filtered.items.length - timelineItems(filtered.items).length;
  const datelessHint = dateless > 0 ? ` · ${dateless} ohne Start (nur Liste)` : '';
  return `${filtered.items.length} items in „${view.name}" · ${filtered.groups.length} groups${suffix}${datelessHint}`;
}

/**
 * A load failure, stated in the content area rather than only in the footer.
 *
 * The status line is easy to miss next to an empty timeline, and „nothing is
 * drawn" reads as a broken app. This puts the reason where the timeline would
 * have been, which is where somebody is already looking.
 */
function showLoadFailure(message: string): void {
  clearLoadFailure();
  els.timeline.appendChild(Callout({ text: message, tone: 'danger', className: 'load-failure' }));
}

function clearLoadFailure(): void {
  els.timeline.querySelector('.load-failure')?.remove();
}

export async function renderTimeline(view: View) {
  if (!state.config) return;

  // A fresh vis-timeline always starts scrolled to the top. When we re-render
  // the *same* view (realtime refresh, conflict reload, live rebuild) we must
  // keep the user where they were vertically — otherwise clicking/editing an
  // item near the bottom snaps the view to the top. The horizontal window is
  // preserved separately via `pendingWindow`; this is its vertical counterpart.
  const sameView = state.activeView?.id === view.id;
  const prevVScroll = sameView
    ? els.timeline.querySelector<HTMLElement>('.vis-panel.vis-left')?.scrollTop ?? 0
    : 0;

  let built: BuildResult;
  let sourceFile: TimelineFile | null = null;
  let sourceId: string | null = null;

  let sourceEditable = false;
  let sourceLive: import('./types').SourceLive = 'none';

  // Cover the area for the duration of the fetch — a DB-backed source takes long
  // enough that an untouched timeline area reads as "this view is empty".
  showTimelineSkeleton(els.timeline);
  clearLoadFailure();

  {
    try {
      const loaded = await loadSource(view.source);
      sourceFile = loaded.file;
      sourceEditable = loaded.editable;
      sourceLive = loaded.live;
    } catch (err) {
      // The load failed, so nothing is on its way any more; leaving the
      // placeholder up would promise a timeline that is never going to arrive.
      hideTimelineSkeleton(els.timeline);
      const message = err instanceof Error ? err.message : String(err);
      setStatus(`Konnte Quelle ${view.source.id} nicht laden: ${message}`);
      // And say it where the eye actually is. The status line alone leaves a
      // blank content area, which reads as „the app is broken" rather than as
      // „this did not load" — the failure looked silent even though it was not.
      showLoadFailure(message);
      return;
    }
    sourceId = view.source.id;
    if (ensureItemIds(sourceFile)) {
      // assigned ids in memory only — saved on first edit
    }
    built = buildFromJson(view, sourceFile);
  }
  state.activeBuild = built;
  state.activeView = view;
  state.activeSourceFile = sourceFile;
  state.activeSourceId = sourceId;
  state.activeSourceEditable = sourceEditable;
  state.activeSourceLive = sourceLive;
  // Before the first computeDisplay: the folds are per source, and the previous
  // view's set would otherwise hide items that happen to share an id here.
  loadCollapsedItems(sourceId);
  snapshotSaved();
  setupRealtime();

  const display = computeDisplay();
  itemsDs = new DataSet<TimelineItemWithStart>(timelineItems(display.items));
  groupsDs = new DataSet<TimelineGroup>(display.groups);

  if (arrows) {
    arrows.dispose();
    arrows = null;
  }
  if (hierarchyFolders) {
    hierarchyFolders.dispose();
    hierarchyFolders = null;
  }
  if (phaseBand) {
    phaseBand.dispose();
    phaseBand = null;
  }
  if (milestoneRail) {
    milestoneRail.dispose();
    milestoneRail = null;
  }
  if (timeline) {
    (timeline as any)._ro?.disconnect();
    timeline.destroy();
    timeline = null;
    state.timeline = null;
    els.timeline.innerHTML = '';
  }

  const useGroups = display.groups.length > 0;

  const now = Date.now();
  const yearMs = 365 * 24 * 3600 * 1000;
  const recent = built.items
    .map((i) => (i.start ? new Date(i.start).getTime() : NaN))
    .filter((t) => t <= now + yearMs)
    .sort((a, b) => b - a);
  const focusMax = recent[0] ?? now;
  const focusMin = recent[Math.min(recent.length - 1, 200)] ?? focusMax - 2 * yearMs;
  const span = Math.max(focusMax - focusMin, 90 * 24 * 3600 * 1000);
  const padding = span * 0.05;

  const containerHeight = visViewportHeight(els.timeline) || 600;

  const editable = editableOptions();

  els.addBtn.hidden = !isEditableView();

  const initialStart = state.pendingWindow?.start ?? new Date(focusMin - padding);
  const initialEnd = state.pendingWindow?.end ?? new Date(focusMax + padding);

  // Reserve room at the top for the phase ribbon. `margin.axis` alone doesn't
  // do it: it only offsets the first *item*, so an empty parent/nested group
  // rendered as the first row collapses to a header that sits exactly behind
  // the band. Instead we tag the container and let CSS pad the whole group set
  // (labels, items, and phase tints) down by the band height — see
  // `.timeline.has-phase-band` in styles/timeline.css.
  const axisMargin = 8;
  els.timeline.classList.toggle('has-phase-band', built.phases.length > 0);

  // Fresh timeline → the item font may differ (brand switch); drop the cached
  // font and measurements so point-label widths get re-measured.
  labelFont = null;
  labelWidthCache.clear();
  // And the reserved stretch belongs to the window this render opens on, not to
  // whatever the previous view was looking at.
  reservedRange = null;

  // The data is here and the real chart takes over from this line on. (A
  // preceding timeline already took the placeholder with it via the
  // `innerHTML` reset above; on a first load there was none.)
  hideTimelineSkeleton(els.timeline);

  timeline = new Timeline(els.timeline, itemsDs, useGroups ? groupsDs : undefined, {
    // Vertical placement is precomputed into per-lane `subgroup`s in buildItems
    // (assignLaneSubgroups); vis only honours subgroups in its non-stacking
    // path, and fixed lanes stay put while scrolling (vis's own stacking
    // re-flows vertically as items enter/leave the viewport).
    stack: false,
    horizontalScroll: true,
    zoomKey: 'ctrlKey',
    // Higher = gentler zoom per wheel/trackpad-pinch step (vis default is 5). A
    // Mac trackpad pinch arrives as a ctrl+wheel event and goes through vis's
    // mousewheel zoom, so this tames pinch sensitivity too.
    zoomFriction: 15,
    // Prepend the brand-resolved icon at render time so the stored `content`
    // stays clean (used by the edit form, confirm dialogs, and Sheets).
    template: (item: TimelineItem) =>
      item ? `${tagPillsHtml(item.tags)}${iconSpanHtml(item.icon)}${item.content ?? ''}` : '',
    // vis-timeline's XSS filter strips the icon span's class/style. Our content
    // and titles are already escapeHtml'd at build time and icon keys are
    // validated, so disabling the redundant filter is safe here.
    xss: { disabled: true },
    // vis puts a *half* gap at a track's top and bottom edge and a full one
    // between its rows, so a bar ended up 3px from the track's border while
    // sitting 6px from its neighbour, and read as glued to the line. Doubling
    // the vertical gap buys the edges their 6px; the rows are further apart for
    // it, which a track carrying a summary bar and its children needs anyway.
    margin: { item: { horizontal: 6, vertical: ITEM_MARGIN_VERTICAL }, axis: axisMargin },
    orientation: { axis: 'top', item: 'top' },
    locale: 'de',
    tooltip: { followMouse: false, overflowMethod: 'cap' },
    zoomMin: 1000 * 60 * 60 * 6,
    zoomMax: 1000 * 60 * 60 * 24 * 365 * 30,
    snap: (date: Date) => {
      // Snap to the nearest *local* day. vis parses stored "YYYY-MM-DD" as local
      // midnight and isoDateOnly reads Dates in local time, so snapping locally
      // keeps the whole pipeline consistent. Rounding (not flooring) makes a
      // sub-day drag in either direction land on the nearest day rather than
      // snapping back to the origin.
      const d = new Date(date);
      if (d.getHours() >= 12) d.setDate(d.getDate() + 1);
      d.setHours(0, 0, 0, 0);
      return d;
    },
    height: `${containerHeight}px`,
    verticalScroll: true,
    start: initialStart,
    end: initialEnd,
    editable,
    onMove: handleMove,
    onAdd: handleAdd,
    onUpdate: (_item: TimelineItem, callback: (item: TimelineItem | null) => void) => {
      // suppress vis-timeline's built-in inline editor; we use our own form on select
      callback(null);
    },
  } as any);
  state.timeline = timeline;
  // Re-apply other users' item marks whenever vis (re)mounts item DOM.
  attachItemPresence(timeline);
  // vis-timeline intentionally makes background items inert. Stored ones are
  // still real entries; only the generated phase tints remain pure chrome.
  attachBackgroundItemSelection(timeline, els.timeline, selectItemById);
  // Same for the rail's delete mark — ours rather than vis's `editable.remove`
  // button, which only ever appears on a *selected* item (see itemRail.ts).
  attachItemRail(timeline, els.timeline, deleteItem);
  // And the fold caret on every bar that has children. Unlike the rail's delete
  // mark this is not an editing affordance, so it stays on a read-only source.
  attachItemCollapse(timeline, els.timeline, toggleItemChildren);
  // Right-click quick actions. Delete goes through the same `deleteItem` the rail
  // mark and the form button use, so there is one delete flow, not three.
  attachItemContextMenu(timeline, {
    setStatus: setItemStatus,
    setField: setItemFieldValue,
    duplicate: duplicateItem,
    remove: deleteItem,
  });

  // And for the overrun line, whose length is a duration and therefore depends on
  // the current zoom (see overrun.ts).
  attachOverrunLines(timeline);

  // The pale body behind an expanded subtree is created unconditionally: a
  // timeline may gain or lose visible hierarchy through folding and filtering
  // without rebuilding the vis instance. Like the other overlays it retries
  // until vis has created its item-set layers.
  const initHierarchyFolders = () => {
    if (!timeline || hierarchyFolders) return;
    try {
      hierarchyFolders = new HierarchyFolders(timeline, els.timeline);
      hierarchyFolders.setHierarchy(displayItems, displayParents());
    } catch {
      // item set not ready yet — a later attempt will pick it up
    }
  };
  requestAnimationFrame(initHierarchyFolders);
  setTimeout(initHierarchyFolders, 100);
  setTimeout(initHierarchyFolders, 500);

  let lastH = containerHeight;
  const ro = new ResizeObserver(() => {
    const h = visViewportHeight(els.timeline);
    if (h > 0 && h !== lastH) {
      lastH = h;
      timeline?.setOptions({ height: `${h}px` });
    }
    // The detail/edit panel is an overlay now, so opening it no longer changes
    // the timeline width and this observer stays quiet for it. It still fires on
    // real width changes (window resize), which shift px/day — so re-evaluate
    // tag-density and re-pack point-label lanes.
    updateTagDensity();
    // The lane pitch too: a brand or type change reaches the bars through CSS, and
    // the reservation is expressed in multiples of it (see syncLanePitch).
    syncLanePitch();
    scheduleRepack();
  });
  ro.observe(els.timeline);
  (timeline as any)._ro = ro;

  const ensureVisible = () => {
    // Re-pack lanes with the real px/day + measurable item font before the
    // timeline becomes visible, so the first painted frame already reserves
    // room for point labels instead of flashing the overlap.
    syncLanePitch();
    repackLanes();
    timeline?.redraw();
    // Re-apply the pre-render vertical offset once the new timeline has laid out
    // (content height and the feasible scroll range are only known after a
    // redraw). vis-timeline's own `_setScrollTop` clamps to that range and a
    // second redraw syncs both the content transform and the scrollbar
    // containers — the authoritative path, avoiding the desync a raw DOM
    // scrollTop write races into. Repeated across frames so a first pass that
    // ran before layout settled gets corrected.
    const tl = timeline as any;
    if (prevVScroll > 0 && typeof tl?._setScrollTop === 'function') {
      tl._setScrollTop(-prevVScroll);
      timeline?.redraw();
    }
    const visEl = els.timeline.querySelector<HTMLElement>('.vis-timeline');
    if (visEl) visEl.style.visibility = 'visible';
  };
  requestAnimationFrame(ensureVisible);
  setTimeout(ensureVisible, 100);
  setTimeout(ensureVisible, 500);

  if (built.dependencies.size > 0) {
    // The .vis-panel.vis-center the overlay attaches to only exists once the
    // timeline has laid out. A single rAF sometimes fires too early, so retry
    // across a few frames/timeouts until it succeeds (mirrors ensureVisible).
    // Each tick also re-applies the dependencies: the first draw can land before
    // the item DOM has laid out (anchors resolve to null → no lines), and on a
    // static page no further 'changed' event fires to correct it. setDependencies
    // reschedules a redraw, so a later tick draws once anchors exist.
    const initArrows = () => {
      if (!timeline) return;
      try {
        if (!arrows) arrows = new DependencyArrows(timeline, els.timeline);
        arrows.setDependencies(displayDeps);
      } catch {
        // panel not ready yet — a later attempt will pick it up
      }
    };
    requestAnimationFrame(initArrows);
    setTimeout(initArrows, 100);
    setTimeout(initArrows, 500);
  }

  if (built.phases.length > 0) {
    // Same fragility as the arrows overlay: the .vis-panel.vis-center the band
    // attaches to only exists once the timeline has laid out, and a single rAF
    // sometimes fires too early (constructor throws, band never appears). Retry
    // across a few frames/timeouts until it succeeds; `phaseBand` is only set on
    // success, so later ticks are no-ops once it's up.
    const initBand = () => {
      if (!timeline || phaseBand) return;
      try {
        phaseBand = new PhaseBand(timeline, els.timeline);
        phaseBand.setPhases(built.phases);
        if (isEditableView()) phaseBand.setEditable(true, handlePhaseEdit, showPhaseFormByIndex);
      } catch {
        // panel not ready yet — a later attempt will pick it up
      }
    };
    requestAnimationFrame(initBand);
    setTimeout(initBand, 100);
    setTimeout(initBand, 500);
  }

  // The milestone rail is created unconditionally, unlike the ribbon above: the
  // set of milestones changes with the *filter*, not only with the build, so a
  // view that currently shows none may show some a moment later. It hides itself
  // (and releases the row reserve) while the count is 0, which the phase ribbon's
  // create-only-if-present shape could not do without a full re-render.
  const initRail = () => {
    if (!timeline || milestoneRail) return;
    try {
      milestoneRail = new MilestoneRail(timeline, els.timeline);
      milestoneRail.setOnSelect(selectItemById);
      milestoneRail.setItems(displayItems);
    } catch {
      // panel not ready yet — a later attempt will pick it up
    }
  };
  requestAnimationFrame(initRail);
  setTimeout(initRail, 100);
  setTimeout(initRail, 500);

  updateTagDensity();
  // `rangechange` fires continuously while zooming/panning. `updateTagDensity`
  // is a no-op unless the compact state flips, and `scheduleRepack` coalesces to
  // one re-pack per frame — so this stays cheap during a drag/zoom.
  timeline.on('rangechange', () => {
    updateTagDensity();
    scheduleRepack();
  });

  timeline.on('select', (props: { items: string[] }) => {
    const clicked = props.items[0];
    if (!clicked) {
      state.selectedItemId = null;
      syncUrl();
      publishSelfPresence();
      return;
    }
    // The clicked id may be a clone; track/select by the real item id.
    selectItemById(realIdOf(clicked));
  });

  timeline.on('rangechanged', (props: { start: Date; end: Date; byUser: boolean }) => {
    if (!props.byUser) return;
    state.userWindow = { start: new Date(props.start), end: new Date(props.end) };
    syncUrl();
  });

  if (state.pendingItem) {
    const id = state.pendingItem;
    state.pendingItem = null;
    setTimeout(() => {
      try {
        timeline?.setSelection(displayIdsFor(id));
      } catch {
        /* item may not exist in this build */
      }
      state.selectedItemId = id;
      showDetailForId(id);
    }, 0);
  }
  if (state.pendingWindow) {
    state.userWindow = state.pendingWindow;
    state.pendingWindow = null;
  }

  setStatus(statusFor(view, built));

  // Fresh build → repaint the list too, so switching to it (or reloading a
  // deep-linked list URL) shows the current data without an extra edit.
  if (state.viewMode === 'list') renderListView();
  // A plugin view is loaded lazily; once entered it is cached, so this repaint
  // no-ops during the brief pre-load window.
  else repaintPluginView(state.viewMode);

  // „The timeline changed", for any plugin holding derived state
  // (src/pluginHost/changes.ts). Fired here rather than per write because this
  // is the one place that also covers a change arriving from somebody else
  // through the realtime channel, and after the repaint because a listener
  // calling `timeline()` must see the file this render used.
  notifyTimelineChanged();
}

// Toggle the compact tag mode based on how much horizontal room a day of the
// timeline currently occupies. Recomputed on zoom/pan (`rangechange`) and on
// container resize; only mutates the DOM when the state actually flips.
export function updateTagDensity(): void {
  const pxPerDay = currentPxPerDay();
  if (pxPerDay === null) return;
  const compact = pxPerDay < TAG_TEXT_MIN_PX_PER_DAY;
  els.timeline.classList.toggle('is-tags-compact', compact);
}

// Horizontal density of the visible window, in px per day. `null` when it can't
// be computed yet (no timeline / zero width). `Infinity` when the window has
// collapsed to a point.
function currentPxPerDay(): number | null {
  if (!timeline) return null;
  const width = els.timeline.clientWidth;
  if (!width) return null;
  const win = timeline.getWindow();
  const days = (win.end.getTime() - win.start.getTime()) / MS_PER_DAY;
  return days > 0 ? width / days : Infinity;
}

// The arrow overlay measures the item DOM, and vis emits no event while a lane
// shift is easing out — so it has to be driven per frame or an arrow hangs in
// mid-air for the duration of the animation.
//
// The hierarchy folders deliberately are *not* driven here: they derive their
// top from vis's own `item.top`, which is already the final value the moment the
// DataSet updates, so redrawing them per frame would paint the same rectangle
// fifteen times. An outline that snaps while its children ease is the known cost
// of this experiment.
function refreshItemOverlays(): void {
  arrows?.refresh();
}

// Coalesce re-packs to one per animation frame: `rangechange` fires many times
// during a single zoom/pan gesture, but the lanes only need recomputing once
// per painted frame.
function scheduleRepack(): void {
  if (repackRaf) return;
  repackRaf = requestAnimationFrame(() => {
    repackRaf = 0;
    repackLanes();
  });
}

// Refine the current display set for the live zoom without touching the DataSet.
// Keeping this separate from `repackLanes` lets rebuilds finish both packing
// passes before vis sees either one, while zoom/pan can still diff the mounted
// rows and update only what moved.
function packDisplayForCurrentZoom(): boolean {
  if (!timeline || !state.activeBuild) return false;
  const pxPerDay = currentPxPerDay();
  if (pxPerDay === null) return false;

  const reservation = reservationFor(timeline.getWindow());
  assignLaneSubgroups(
    displayItems.filter((it) => withinReservation(it, reservation)),
    displayGroups,
    displayDeps,
    displayParents(),
    { pxPerDay: packingPxPerDay(pxPerDay), pointLabelPx: measurePointLabelPx },
  );
  return true;
}

// Recompute per-lane subgroups for the current zoom level and push only the
// items whose lane actually changed into the live DataSet. Because point items
// reserve their label width (translated from px via the current px/day),
// zooming out — where the same label spans more days — spreads crowded
// milestones onto more lanes, and zooming back in re-packs them tight again.
export function repackLanes(): void {
  if (!timeline || !state.activeBuild || !itemsDs) return;

  // Pack the *display* set (regrouped/cloned when grouping by tag/field), so the
  // clones on their derived lanes get label-width-aware spacing too. Restricted to
  // the reserved neighbourhood, which is what keeps both the lanes and the reserved
  // height tight: packing the whole timeline would spread a track over every lane
  // its busiest stretch needs, wherever you happen to be looking.
  const before = new Map(displayItems.map((it) => [it.id, it.subgroup]));
  const beforeStyles = new Map(displayGroups.map((g) => [g.id, g.style]));
  if (!packDisplayForCurrentZoom()) return;

  // Only touch items that are actually mounted (milestones-only filter may hide
  // some) and whose lane moved — a partial update keeps vis's redraw minimal.
  const present = new Set((itemsDs.getIds() as (string | number)[]).map(String));
  const changed = displayItems
    .filter((it) => present.has(String(it.id)) && it.subgroup !== before.get(it.id))
    .map((it) => ({ id: it.id, subgroup: it.subgroup }));
  // The lane change is the vertical jump the user sees while panning
  // horizontally, so it is the one place the viewer animates a layout change
  // (`laneTransition.ts` carries the why). Scoped to the repack on purpose: a
  // rebuild, a filter or a drag moves items for reasons the user just caused
  // directly, and easing those in would read as lag.
  if (changed.length) withLaneShift(els.timeline, () => itemsDs!.update(changed), refreshItemOverlays);

  // The reservation has to reach the label too, or the track keeps yesterday's
  // height. It matters that the reservation always covers the lanes the packing just
  // used: vis takes the *larger* of the label reservation and the height its drawn
  // items need, and the second term is what depends on the time window. Keeping the
  // first one on top is what makes the track's height a function of the data and the
  // zoom alone, so panning and scrolling cannot move it.
  if (groupsDs) {
    const movedGroups = displayGroups
      .filter((g) => g.style !== beforeStyles.get(g.id))
      .map((g) => ({ id: g.id, style: g.style }));
    if (movedGroups.length) {
      groupsDs.update(movedGroups);
      // And a redraw one frame later. vis measures the group label in `_didResize`,
      // which its redraw queue runs *after* the `_calculateHeight` that consumes the
      // measurement, so a fresh reservation only lands on the following pass — and
      // two `redraw()` calls in the same tick collapse into one, which is why this
      // waits for the next frame. Without it the track keeps the height of the
      // previous lane count and its label overflows the row.
      //
      // A second lane-shift pass, because this redraw is the one that moves
      // whole tracks: a track that gained or lost a lane pushes everything below
      // it, an amount the first pass could not have measured yet.
      requestAnimationFrame(() =>
        withLaneShift(els.timeline, () => timeline?.redraw(), refreshItemOverlays),
      );
    }
  }
}

// The stretch of time a track reserves height for.
//
// Not the whole timeline: a track would then always be as tall as its densest
// stretch, and a sparse window shows more empty rows than content — measured on a
// real roadmap, a screen that held fourteen tracks held two. Not the visible window
// either, because a reservation that moves with every pan puts the jumping straight
// back. So: a neighbourhood one window wide on each side, and it stays put until the
// window travels close to its edge. Panning and scrolling then happen entirely
// inside a reservation that does not move, and a long journey costs one reflow.
// Both terms matter, and a first version with only the first one was reverted for
// it: one window width of margin means half a window of travel before the
// neighbourhood re-centres, which at a two-month zoom is a re-centre every few
// weeks — constantly, in use. The floor is what makes the margin a *duration*
// rather than a multiple of however far you happen to be zoomed in, so the
// re-centre stays rare at every zoom level. On a roadmap shorter than the
// neighbourhood this collapses to reserving for the whole timeline, which is the
// behaviour that never moves; the compactness only pays off once a roadmap is
// genuinely longer than the neighbourhood, and there an occasional re-centre is
// what you expect from travelling that far.
const RESERVE_MARGIN_WINDOWS = 2;
const RESERVE_MARGIN_MIN_MS = 365 * MS_PER_DAY;
let reservedRange: { start: number; end: number } | null = null;

function reservationFor(win: { start: Date; end: Date }): { start: number; end: number } {
  const start = win.start.getTime();
  const end = win.end.getTime();
  const width = Math.max(end - start, 1);
  const margin = Math.max(width * RESERVE_MARGIN_WINDOWS, RESERVE_MARGIN_MIN_MS);
  // Re-centre when the window is within half a margin of the edge, or when its width
  // changed at all: the neighbourhood is defined in window widths, so a zoom step
  // invalidates it by definition.
  const kept = reservedRange;
  const keep =
    kept !== null &&
    kept.end - kept.start === width + 2 * margin &&
    start - kept.start >= margin / 2 &&
    kept.end - end >= margin / 2;
  if (keep) return kept;
  return (reservedRange = { start: start - margin, end: end + margin });
}

// Does the item's own extent reach into the reserved stretch? Items outside keep
// whatever lane they had: they are not drawn (the window sits inside the
// reservation), so their lane cannot be seen until a later pass repacks them.
function withinReservation(it: TimelineItem, r: { start: number; end: number }): boolean {
  if (!it.start) return false;
  const start = new Date(it.start).getTime();
  const end = new Date(it.end ?? it.start).getTime();
  return start <= r.end && end >= r.start;
}

// Zoom levels, in px/day, snapped to a ladder of quarter-octave steps (≈19% apart)
// and always rounded *down*. Two reasons for the ladder: it keeps a pinch from
// re-packing on every frame (px/day changes continuously, the bucket rarely), and
// it makes the layout a function of the bucket, so zooming out and back in returns
// to the layout you left instead of a slightly different one. Rounding down means
// the reserved label width errs on the generous side, so the snapping can cost a
// lane but can never let two labels overlap.
const PACK_STEPS_PER_OCTAVE = 4;

function packingPxPerDay(pxPerDay: number): number {
  if (!Number.isFinite(pxPerDay) || pxPerDay <= 0) return pxPerDay;
  const step = Math.floor(Math.log2(pxPerDay) * PACK_STEPS_PER_OCTAVE) / PACK_STEPS_PER_OCTAVE;
  return 2 ** step;
}

// Estimate the rendered width (px) of a point item's label: dot + optional icon
// + tag pills (text pills, or dots in compact mode) + the content text, plus
// padding/breathing room. Text is measured off-DOM in the item font (cached).
const ICON_LABEL_PX = 20;
const POINT_LABEL_PAD = 26;
const PILL_GAP_PX = 6;
const PILL_TEXT_PAD = 12;
const PILL_DOT_PX = 16;

function measurePointLabelPx(item: TimelineItem): number {
  const font = currentLabelFont();
  let px = measureText(decodeEntities(item.content ?? ''), font) + POINT_LABEL_PAD;
  if (item.icon) px += ICON_LABEL_PX;
  if (item.tags?.length) {
    const compact = els.timeline.classList.contains('is-tags-compact');
    for (const t of item.tags) {
      px += compact ? PILL_DOT_PX : measureText(decodeEntities(t), font) + PILL_TEXT_PAD;
    }
    px += PILL_GAP_PX;
  }
  return px;
}

function measureText(text: string, font: string): number {
  const key = `${font}|${text}`;
  const cached = labelWidthCache.get(key);
  if (cached != null) return cached;
  if (!measureCtx) measureCtx = document.createElement('canvas').getContext('2d');
  const w = measureCtx ? ((measureCtx.font = font), measureCtx.measureText(text).width) : text.length * 7.5;
  labelWidthCache.set(key, w);
  return w;
}

// Resolve the canvas `font` shorthand from a rendered item. Only cached once a
// real `.vis-item-content` exists — before that we return the container font
// but keep retrying, so an early pre-layout measurement doesn't lock in a wrong
// font (the cache key includes the font, so a later correct font re-measures).
function currentLabelFont(): string {
  if (labelFont) return labelFont;
  const sample = els.timeline.querySelector<HTMLElement>('.vis-item .vis-item-content');
  const cs = getComputedStyle(sample ?? els.timeline);
  const font = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
  if (sample) labelFont = font;
  return font;
}

function handleMove(item: TimelineItem, callback: (item: TimelineItem | null) => void): void {
  if (!state.activeSourceFile) {
    callback(item);
    return;
  }
  // `item.id` may be a clone (when regrouped): edit the real source item.
  const realId = realIdOf(item.id);
  const idx = findItemIndex(state.activeSourceFile, realId);
  if (idx === -1) {
    callback(item);
    return;
  }
  const src = state.activeSourceFile.items[idx];
  const newStart = isoDateOnly(item.start);
  const newEnd = item.end ? isoDateOnly(item.end) : undefined;

  src.start = newStart;
  if (src.type === 'point') {
    delete src.end;
    delete src.duration;
  } else if (newEnd) {
    src.end = newEnd;
    delete src.duration;
  } else {
    delete src.end;
  }
  // Group changes only happen along the item's own group dimension. When
  // regrouped, `item.group` is a derived lane id (updateGroup is off anyway), so
  // never write it back over the real group.
  if (!regroupedMode && item.group != null && item.group !== src.group) {
    // Parent groups (with nestedGroups) are containers only: a drop onto a
    // parent lane snaps into its first leaf child instead of the parent itself.
    const groups = state.activeSourceFile.groups ?? state.activeBuild?.groups ?? [];
    const resolved = resolveAssignableGroup(item.group, groups) ?? String(item.group);
    // A summary bar drags its subtree along: what the band shows as one unit
    // moves as one (regroupSubtree owns which descendants qualify). It writes
    // `src.group` too, the head being the first item it moves.
    regroupSubtree(state.activeSourceFile.items, realId, resolved);
    item.group = resolved;
  }

  callback(item);
  rebuildAndApply();
  schedulePersist();
  // A drag/resize is an edit — flag it for the others (dragging an item selects
  // it, so the presence activity already points at this item).
  markSelfEditing();
  if (state.activeFormItemId === realId) {
    showItemForm(src);
  }
}

// Appends a new item to the active source at the given start/group, persists,
// and opens its edit form. Shared by the double-click handler (handleAdd) and
// the toolbar "+ Eintrag" button (addNewItem).
export function createItem(start: Date | string | null | undefined, group?: string | number | null): (TimelineFileItem & { id: string }) | null {
  if (!state.activeSourceFile) return null;
  const newId = generateNewId(state.activeSourceFile);
  // Parent groups (with nestedGroups) are containers only: an explicit target
  // that is a parent redirects to its first leaf child, and the default (no
  // target) picks the first leaf group rather than a parent header.
  const groups = state.activeSourceFile.groups ?? state.activeBuild?.groups ?? [];
  const groupId = group != null
    ? resolveAssignableGroup(group, groups) ?? String(group)
    : firstAssignableGroup(groups) ?? groups[0]?.id;

  const newItem: TimelineFileItem & { id: string } = {
    id: newId,
    content: 'Neuer Eintrag',
    group: groupId,
    status: DEFAULT_STATUS,
  };
  // A timeline-placed item gets a start + default 1-week extent so it renders
  // as a visible bar. A list-created item (start === null) stays dateless —
  // empty start/end/duration — until the user fills the form in.
  if (start) {
    newItem.start = isoDateOnly(start);
    newItem.duration = '1w';
  }
  state.activeSourceFile.items.push(newItem);
  rebuildAndApply();
  schedulePersist();
  return newItem;
}

// vis-timeline's add path (double-click on empty space, ctrl-drag). `createItem`
// already inserted the item into the live DataSet via rebuildAndApply, so vis
// must NOT add it a second time: `itemsData.add()` throws on the duplicate id.
//
// That throw is why the mouse used to stay "pressed" after a double-click-add:
// hammer emits `doubletap` synchronously from inside its `pointerup` handler,
// and that handler only removes the pointer from its store *after* the callback
// returns (PointerEventInput.handler → `store.splice`). An exception escaping
// through it leaves the pointer in the store, so every later `pointermove` looks
// like an active drag and the timeline pans along with the mouse until the next
// click. Passing `null` cancels vis's own insert — our rebuild owns it.
function handleAdd(item: TimelineItem, callback: (item: TimelineItem | null) => void): void {
  const newItem = createItem(item.start, item.group);
  callback(null);
  if (!newItem) return;
  setTimeout(() => showItemForm(newItem, { focusTitle: true }), 50);
}

// Toolbar "+ Eintrag": adds an item at the centre of the visible window (so it
// lands on screen) and opens its form. No-op on read-only views. Optionally
// pins the new item to a specific group (used by the list view's per-group
// "+ Eintrag" buttons).
export function addNewItem(group?: string | null): void {
  if (!isEditableView()) return;
  // From the list view the new item starts dateless (empty start/end/duration)
  // and is filled in via the form. From the timeline it needs a start so it
  // lands on screen as a visible bar at the centre of the current window.
  let start: Date | null = null;
  if (state.viewMode !== 'list') {
    const win = timeline?.getWindow();
    start = win
      ? new Date((new Date(win.start).getTime() + new Date(win.end).getTime()) / 2)
      : new Date();
  }
  const newItem = createItem(start, group);
  if (!newItem) return;
  setTimeout(() => {
    try {
      timeline?.setSelection(displayIdsFor(newItem.id));
    } catch {
      /* item may be filtered out of the current view */
    }
    showItemForm(newItem, { focusTitle: true });
  }, 50);
}

/**
 * Duplicate an item — the context menu's „Duplizieren". Sits beside `createItem`
 * because it is the same job: mint an id, append to the source, persist, open the
 * new item's form. The title is focused so the copy can be renamed straight away,
 * which is also why the content is copied verbatim rather than suffixed.
 *
 * The copy drops the server-managed fields (`version` and the audit stamps), so
 * the persist diff sees an id it has never saved and POSTs a new row instead of
 * PATCHing over the original. `metadata` is deep-cloned — sharing that object
 * would make a later edit to either copy silently change the other.
 */
export function duplicateItem(id: string): void {
  if (!state.activeSourceFile) return;
  const idx = findItemIndex(state.activeSourceFile, id);
  if (idx === -1) return;
  const src = state.activeSourceFile.items[idx];
  const {
    id: _id,
    version: _v,
    createdAt: _ca,
    createdBy: _cb,
    updatedAt: _ua,
    updatedBy: _ub,
    ...rest
  } = src;
  const copy: TimelineFileItem & { id: string } = {
    ...rest,
    id: generateNewId(state.activeSourceFile),
  };
  if (src.metadata) copy.metadata = structuredClone(src.metadata);
  placeAfter(copy, src);
  state.activeSourceFile.items.push(copy);
  rebuildAndApply();
  schedulePersist();
  setTimeout(() => {
    try {
      timeline?.setSelection(displayIdsFor(copy.id));
    } catch {
      /* copy may be filtered out of the current view */
    }
    showItemForm(copy, { focusTitle: true });
  }, 50);
}

// Move a duplicate clear of its original: a bar starts where the original ended,
// anything without an extent shifts by a day. Day granularity throughout, like
// every drag (which snaps to whole days). A date-less item stays date-less — it
// lives in the list view only, where there is nothing to sit on top of.
function placeAfter(copy: TimelineFileItem, src: TimelineFileItem): void {
  if (!src.start) return;
  const start = parseLocalDay(src.start).getTime();
  if (src.end) {
    const end = parseLocalDay(src.end).getTime();
    // Guard against an end that isn't after the start (hand-edited data).
    const span = Math.max(end - start, MS_PER_DAY);
    copy.start = isoDateOnly(new Date(end));
    copy.end = isoDateOnly(new Date(end + span));
    // `end` and `duration` are mutually exclusive (end wins). Hand-edited data
    // carrying both would otherwise have the copy send a contradictory payload
    // for the write layer to resolve.
    delete copy.duration;
    return;
  }
  // `duration` carries over unchanged, so shifting the start by it is enough.
  copy.start = isoDateOnly(new Date(start + (durationToMs(src.duration) ?? MS_PER_DAY)));
}

// Re-apply the active grouping/filter to the live views without a full rebuild,
// so the current window/scroll is preserved. Recomputes the display set (via
// computeDisplay inside applyBuildToDataSets, which repaints the list/pricing
// too), repacks the timeline lanes, refreshes the dependency arrows, and updates
// the status line to the visible counts.
export function refreshDisplay(): void {
  if (!state.activeBuild) return;
  applyBuildToDataSets();
  if (timeline) {
    repackLanes();
    if (arrows) arrows.setDependencies(displayDeps);
    timeline.redraw();
  }
  if (state.activeView) setStatus(statusFor(state.activeView, state.activeBuild));
}

// Grouping change: same as a display refresh, but the grouping dimension also
// flips the editable behaviour (updateGroup/add are off when regrouped) and the
// "+ Eintrag" button availability, so re-apply those to the live timeline.
export function applyGrouping(): void {
  refreshDisplay();
  if (!timeline) return;
  timeline.setOptions({ editable: editableOptions() } as any);
  els.addBtn.hidden = !isEditableView();
}

// Filter change: only the visible item set changes, so a plain display refresh
// is enough (grouping dimension and editability are untouched).
export function applyFilter(): void {
  refreshDisplay();
}

/**
 * Fold or unfold one summary item's subtree — the fold caret in either view.
 * Which items disappear is decided once, in `filterBuildForDisplay`, so a plain
 * display refresh is all this needs: the timeline, the list and the status-line
 * counts follow from the same set.
 */
export function toggleItemChildren(realId: string): void {
  toggleItemCollapsed(realId);
  refreshDisplay();
}
