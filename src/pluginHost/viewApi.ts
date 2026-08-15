// The half of the host API that only a **view** may have: the design-system
// components and the markdown editor.
//
// **Why this is a second file rather than more of `api.ts`.** Everything a plugin
// declares outside its view — its manifest, its fields, its tools, its data rules —
// is read by the *server*: the MCP function asks the registry for a plugin's field
// definitions, its derived values and its tool handlers. Those modules import the
// host through `api.ts`, so anything `api.ts` re-exports is dragged into a
// serverless bundle along with them.
//
// That is not theoretical. `api.ts` re-exported `export * from '../design-system'`
// and `createMarkdownEditor`, and the day the server started reading plugin fields
// (#153's sibling work) the MCP function's bundle grew to 118 modules — 50 of them
// design-system, 27 of them stylesheets — and stopped building at all, because
// esbuild has no loader for a `.css` import. Netlify failed every deploy from that
// merge onwards while the site kept serving the last good one, so nothing shipped
// for a day and no check said a word.
//
// So the rule this file exists to hold: **`api.ts` is DOM-free and safe on a
// server; `viewApi.ts` is what a view imports.** A module that imports from here
// declares itself client-only, and `scripts/ci/check-server-bundle.mjs` fails if
// one of them ends up reachable from the MCP function.
//
// A runtime-loaded plugin still gets neither: it is fetched as bytes and executed
// from a blob URL, with no bundler and no import map, so it uses the CSS half —
// the tokens and the `ds-*` class names. That is unchanged; see „Making it look
// like the app" (docs/plugin-authoring.md).

export * from './api';

/**
 * The markdown editor the item form uses.
 *
 * Here rather than in the design system, which is where it belongs and where it is
 * not yet: it carries its own stylesheet and two npm dependencies, so moving it is
 * a design-system change with its own playground entry. See „What is not in the
 * design system yet" (docs/design-system.md).
 */
export { createMarkdownEditor, type MarkdownEditor } from '../wysiwyg';

export * from '../design-system';
