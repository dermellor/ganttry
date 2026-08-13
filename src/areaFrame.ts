// The mechanics both settings areas share: which section a hash value names, the
// section list beside the panel, and mounting exactly one section at a time.
//
// There are two areas — one for the instance, one for the open timeline — and they
// are the same object with different sections. The second one arrived by copying
// the first, and the copies had already drifted (a heading level, a missing
// unmount) before either shipped. So the shape lives here once, and each area
// declares only its sections.
//
// What is deliberately NOT here: the routing. Each area owns its own hash key and
// its own state field, because „which area is open" is a decision about levels
// (see docs/information-architecture.md) rather than about this frame.

import { Tab } from './design-system';

/** One section of an area: a label in the list and a body it mounts on demand. */
export type AreaSection<Id extends string = string> = {
  id: Id;
  label: string;
  mount: (root: HTMLElement) => void | Promise<void>;
  unmount?: () => void;
};

/** The nodes an area is made of, as `appShell` builds them. */
export type AreaNodes = {
  root: HTMLElement;
  nav: HTMLElement;
  heading: HTMLElement;
  body: HTMLElement;
};

/**
 * The section a hash value names, defaulting to the first.
 *
 * A bare key and an unknown section both land on the first section rather than
 * closing the area: somebody following a link to a section that was renamed asked
 * to be here, and an empty page would answer a question they did not ask.
 */
export function areaSection<Id extends string>(
  sections: readonly AreaSection<Id>[],
  raw: string | undefined | null,
): Id {
  return sections.find((s) => s.id === raw?.trim().toLowerCase())?.id ?? sections[0].id;
}

/**
 * One area's live state: which section is mounted, so the next open can tear it
 * down. Held per area rather than globally, or opening the timeline's area would
 * leave the instance area believing its section is still up.
 */
export type AreaHandle<Id extends string> = { mounted: AreaSection<Id> | null };

export function createAreaHandle<Id extends string>(): AreaHandle<Id> {
  return { mounted: null };
}

function renderNav<Id extends string>(
  nodes: AreaNodes,
  sections: readonly AreaSection<Id>[],
  active: Id,
): void {
  nodes.nav.replaceChildren(
    ...sections.map((s) =>
      Tab({
        label: s.label,
        selected: s.id === active,
        controls: nodes.body.id,
        attrs: { 'data-section': s.id },
      }),
    ),
  );
}

/**
 * Show the area on a section, or hide it when `null`.
 *
 * `bodyClass` is what hides the content behind it, through a class on `<body>` and
 * CSS rather than by setting `hidden` on each element: every one of those owns its
 * own `hidden` for its own reasons (`+ Eintrag` is hidden on a read-only source,
 * the detail panel when nothing is selected), and writing over that on open means
 * guessing what to restore on close. The guess is wrong for exactly the case that
 * matters — the button coming back on a timeline that cannot be edited.
 */
export async function showArea<Id extends string>(
  handle: AreaHandle<Id>,
  nodes: AreaNodes,
  sections: readonly AreaSection<Id>[],
  section: Id | null,
  bodyClass: string,
): Promise<void> {
  const open = section != null;
  nodes.root.hidden = !open;
  document.body.classList.toggle(bodyClass, open);

  if (!open) {
    unmountArea(handle, nodes);
    return;
  }

  const def = sections.find((s) => s.id === section) ?? sections[0];
  if (handle.mounted?.id === def.id) return;
  unmountArea(handle, nodes);
  handle.mounted = def;
  renderNav(nodes, sections, def.id);
  nodes.heading.textContent = def.label;
  await def.mount(nodes.body);
}

/**
 * Re-run the open section's mount, keeping it open.
 *
 * `showArea` returns early when the wanted section is already the mounted one, which
 * is right for a click on the tab it is already on and wrong for a change of what the
 * section describes. The timeline's own area is the case: its sections are about the
 * OPEN timeline, and switching timelines from the header while the area is open left
 * them describing the previous one — the Plugins section then offered switches for a
 * document nobody was looking at.
 */
export async function remountArea<Id extends string>(
  handle: AreaHandle<Id>,
  nodes: AreaNodes,
): Promise<void> {
  const def = handle.mounted;
  if (!def) return;
  def.unmount?.();
  nodes.body.replaceChildren();
  await def.mount(nodes.body);
}

/** Tear the current section down before another one is mounted over it. */
export function unmountArea<Id extends string>(handle: AreaHandle<Id>, nodes: AreaNodes): void {
  handle.mounted?.unmount?.();
  handle.mounted = null;
  nodes.body.replaceChildren();
}

/** Wire the section list: a click on a tab opens that section. */
export function wireAreaNav<Id extends string>(
  nav: HTMLElement,
  open: (section: Id) => void,
): void {
  nav.addEventListener('click', (ev) => {
    const tab = (ev.target as HTMLElement).closest('[data-section]') as HTMLElement | null;
    if (tab?.dataset.section) open(tab.dataset.section as Id);
  });
}
