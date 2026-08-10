// The element builder every component is written against.
//
// The viewer has no framework, so a component here is a plain function that
// returns an `HTMLElement`. That has one consequence worth stating up front:
// two thirds of the call sites in this codebase assemble HTML *strings* (the
// item form's template literals, and vis-timeline, which takes a string per
// item and gives no way to hand it a node). Those call sites use `html()` to
// render a component into their string.
//
// A component is therefore defined once, as DOM, and the string form is derived
// from it. The alternative — a `.html()` builder beside every factory — is two
// definitions of one component, and the second one is where the drift starts.
//
// What `html()` cannot carry across is behaviour: a listener attached by the
// factory does not survive `outerHTML`. That is not a regression, because a
// string call site was always going to wire its own handler after inserting the
// markup; it does mean `onClick` is for the DOM path only, and passing it to
// something you then stringify silently does nothing.

/**
 * Recursive on purpose: a component composes its children from optional pieces
 * (`cond && Node`) and from lists (`items.map(…)`), so nested arrays turn up in
 * almost every call. `append` flattens them, and having the type say so is what
 * keeps call sites from needing a `.flat()` that does nothing at runtime.
 */
export type Child = Node | string | number | false | null | undefined | Child[];

/**
 * Attribute values. `false`, `null` and `undefined` remove the attribute, so a
 * component can pass an optional prop straight through without a conditional at
 * every call site. `true` renders a bare boolean attribute (`hidden`, not
 * `hidden="true"`) — the two are equivalent to the parser, but the bare form is
 * what the existing markup uses and diffing the two is noise.
 */
export type AttrValue = string | number | boolean | null | undefined;
export type Attrs = Record<string, AttrValue>;

/** Listeners, keyed by event name — `{ click: … }`, not `{ onClick: … }`. */
export type Listeners = Partial<{
  [K in keyof HTMLElementEventMap]: (event: HTMLElementEventMap[K]) => void;
}>;

export function setAttrs(node: Element, attrs: Attrs | undefined): void {
  if (!attrs) return;
  for (const [name, value] of Object.entries(attrs)) {
    if (value === false || value == null) {
      node.removeAttribute(name);
    } else if (value === true) {
      node.setAttribute(name, '');
    } else {
      node.setAttribute(name, String(value));
    }
  }
}

export function append(node: Node, children: Child): void {
  if (children == null || children === false) return;
  if (Array.isArray(children)) {
    for (const child of children) append(node, child);
    return;
  }
  node.appendChild(typeof children === 'object' ? children : document.createTextNode(String(children)));
}

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs?: Attrs,
  children?: Child,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  setAttrs(node, attrs);
  append(node, children);
  return node;
}

/**
 * `class` for a component: the root class, plus whatever the caller passed.
 * Every factory takes a `className` so a call site can attach its own hook
 * (a `js-`-style selector, a layout class) without reaching for `!important`
 * or a wrapper div.
 */
export function classes(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(' ');
}

/**
 * `data-*` attributes from a record, skipping the empty ones. Variants are
 * expressed as data attributes rather than modifier classes throughout, which
 * is what lets a stylesheet say `[data-variant='danger']` and a call site read
 * the current variant back off the node.
 */
export function data(values: Record<string, string | number | boolean | null | undefined>): Attrs {
  const out: Attrs = {};
  for (const [key, value] of Object.entries(values)) {
    if (value === false || value == null || value === '') continue;
    out[`data-${key}`] = value === true ? '' : value;
  }
  return out;
}

export function on(node: HTMLElement, listeners: Listeners | undefined): void {
  if (!listeners) return;
  for (const [event, handler] of Object.entries(listeners)) {
    node.addEventListener(event, handler as EventListener);
  }
}

/**
 * The string form of a component, for the call sites that build markup as text.
 * Listeners do not survive; see the note at the top of this file.
 */
export function html(node: Element): string {
  return node.outerHTML;
}

/** Several components as one string — a chip row, a set of menu items. */
export function htmlAll(nodes: Element[]): string {
  return nodes.map(html).join('');
}

/**
 * An element from a literal markup string. This exists for inline SVG, which
 * `el()` cannot build (it creates HTML elements, and an `<svg>` needs the SVG
 * namespace) and which there is no reason to express as a tree of factory calls.
 *
 * The argument must be a literal in the source, never anything derived from
 * data — this parses markup, so a value that reached it from a timeline file
 * would be an injection. Everything data-driven goes through `el()`, which sets
 * text as text.
 */
export function fromHtml(markup: string): Element {
  const template = document.createElement('template');
  template.innerHTML = markup.trim();
  const node = template.content.firstElementChild;
  if (!node) throw new Error('fromHtml: markup produced no element');
  return node;
}

/**
 * Replace a placeholder element with a component, keeping the placeholder's id
 * and any attributes the app set on it. This is how the static shell in
 * index.html hands its nodes over to the component layer without `els` (which
 * resolves ids at module load) having to change.
 */
export function replace<T extends HTMLElement>(target: Element, replacement: T): T {
  for (const attr of Array.from(target.attributes)) {
    if (attr.name === 'class') {
      replacement.className = classes(replacement.className, attr.value);
    } else if (!replacement.hasAttribute(attr.name)) {
      replacement.setAttribute(attr.name, attr.value);
    }
  }
  target.replaceWith(replacement);
  return replacement;
}
