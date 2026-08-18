// This plugin's interface text, in the two languages the host ships.
//
// The contract is „Text in more than one language" (docs/plugin-authoring.md). Its
// **agent-facing** text is not here and is not translated: a tool's notes and
// refusals are English like the rest of the tool surface (docs/mcp.md), and they live
// at the site that produces them, in `tools.ts`.
//
// **Nothing here is a stored value.** The three support-window ids (`standard`,
// `extended`, `unsupported`) are what a grouping dimension keys on, so only their
// *labels* are below; the ids stay in `lifecycle.ts` and never move. Nothing else in
// this plugin has an option set at all — the six stored fields are free text, because
// `CustomFieldType` has no date and no number type.
//
// **Why the keys are all short here.** „Interface text" (AGENTS.md) exempts four key
// shapes from the word limit, and this plugin needs none of them: it contributes no
// view, so it produces no empty state, no chart label and no refusal a person reads.
// Every refusal it can make is a tool's, which is English and lives in `tools.ts`.
// Adding a `refusal.` prefix here to buy room for a longer label would be a visible
// lie in a diff.

import { pluginMessages } from '../../pluginHost/api';

export const t = pluginMessages('dev.zeitlines.lifecycle', {
  en: {
    // What the manifest declares, in the reader's language. A manifest holds no
    // functions and cannot call `t()`, so the host looks these up here and falls back
    // to the literal in `manifest.ts` — see `manifestText` in
    // `src/pluginHost/messages.ts`. It reads the same in both languages and is
    // declared anyway, so the next plugin's author can see the seam exists.
    'manifest.name': 'Lifecycle',

    // The six stored fields. „End of support" rather than „EOL" as the label,
    // because the vendors' own pages use both and the spelt-out form is the one a
    // reader recognises without the acronym; „EOL" is in the manifest's keywords,
    // which is where a searcher meets it.
    'field.system': 'System',
    'field.endOfSupport': 'End of support',
    'field.extendedUntil': 'Extended support until',
    'field.leadTimeDays': 'Lead time (days)',
    'field.cutover': 'Cutover',
    'field.shutdown': 'Shutdown',

    // The two computed fields. Both are read-only in the form and stored nowhere.
    'field.latestStart': 'Latest start',
    'field.supportWindow': 'Support window',

    // The three support windows, as labels. The ids stay English and unstored.
    'window.standard': 'Standard support',
    'window.extended': 'Extended support',
    'window.unsupported': 'After end of life',
  },
  de: {
    'manifest.name': 'Lifecycle',

    // „Cutover" and „Lifecycle" stay English: both are the words German practice
    // uses („Cutover-Wochenende", „Go-Live"), and translating them would invent a
    // term nobody searches for. „End of Support" likewise — the vendors ship their
    // German pages with it untranslated.
    'field.system': 'System',
    'field.endOfSupport': 'End of Support',
    'field.extendedUntil': 'Extended Support bis',
    'field.leadTimeDays': 'Vorlaufzeit (Tage)',
    'field.cutover': 'Cutover',
    'field.shutdown': 'Abschaltung',

    'field.latestStart': 'Spätester Beginn',
    'field.supportWindow': 'Support-Fenster',

    'window.standard': 'Standard-Support',
    'window.extended': 'Extended Support',
    'window.unsupported': 'Nach End of Life',
  },
});
