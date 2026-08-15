// This plugin's own text, in the two languages the host ships.
//
// A plugin brings its own catalogue rather than adding to the core's: the host
// does not know a plugin exists until it is installed, and a third-party plugin
// is not in this repository at all. `pluginMessages` is the contract seam and it
// arrived with host API 1.7 — see „Text in more than one language"
// (docs/plugin-authoring.md).
//
// **Nothing here is a stored value.** Every string is a label, a heading or a
// placeholder. The ids this plugin stores — tier ids, feature ids, version names —
// are the user's own words and never pass through a translation, which is the
// rule `src/i18n/storedValues.test.ts` holds the line on.
//
// The placeholders keep their examples in the language of the example: „z.B. ab
// 449,95 €/Monat" becomes „e.g. from €449.95/month" rather than being left German,
// because a placeholder showing the expected *format* is useless in a format the
// reader does not write numbers in.

import { pluginMessages } from '../../pluginHost/api';

export const t = pluginMessages('dev.zeitlines.product-roadmap', {
  en: {
    'feature.add': '+ Feature',
    'feature.roadmapWork': 'Roadmap work on this feature',
    'feature.noWork': 'No roadmap work linked',
    'feature.noWork.aria': 'Warning: no roadmap work linked',
    'tier.add': '+ Tier',
    'tier.edit': 'Edit tier',
    'tier.placeholder.name': 'e.g. Micro · 1–5 calls/day',
    'tier.placeholder.price': 'e.g. from €449.95/month',
    'tier.placeholder.useCase': 'e.g. catch missed calls',
    'tier.useCase': 'Use case',
    'version.add': '+ Version description',
    'version.remove': 'Remove version description',
    'version.from': 'From version',
    'version.from.lower': 'from version',
    'version.fromStart': '— from the start —',
    'cell.edit': 'Edit cell',
    'cell.placeholder.number': 'e.g. 3,000',
    'description.show': 'Show description',
    'add': 'Add',
    'delete': 'Delete',
    'readOnly': '(read-only)',
    'feature.namePrompt': 'Name of the new feature?',
    'tier.namePrompt': 'Name of the new tier?',
    'badge.new': 'New',
    'export.noPricing': '_No pricing model stored in the timeline._',
    'refusal.feature.conflict': 'Feature changed elsewhere — reloading…',
    'refusal.tier.conflict': 'Tier changed elsewhere — reloading…',
    'export.note': 'Manual changes are lost on the next export. The timeline is the source of truth.',
  },
  de: {
    'feature.add': '+ Feature',
    'feature.roadmapWork': 'Roadmap-Arbeit an diesem Feature',
    'feature.noWork': 'Keine Roadmap-Arbeit verknüpft',
    'feature.noWork.aria': 'Warnung: keine Roadmap-Arbeit verknüpft',
    'tier.add': '+ Tarif',
    'tier.edit': 'Tarif bearbeiten',
    'tier.placeholder.name': 'z.B. Micro · 1–5 Anrufe/Tag',
    'tier.placeholder.price': 'z.B. ab 449,95 €/Monat',
    'tier.placeholder.useCase': 'z.B. Verpasste Anrufe auffangen',
    'tier.useCase': 'Use Case',
    'version.add': '+ Versionsbeschreibung',
    'version.remove': 'Versionsbeschreibung entfernen',
    'version.from': 'Ab Version',
    'version.from.lower': 'ab Version',
    'version.fromStart': '— von Anfang an —',
    'cell.edit': 'Zelle bearbeiten',
    'cell.placeholder.number': 'z.B. 3.000',
    'description.show': 'Beschreibung anzeigen',
    'add': 'Hinzufügen',
    'delete': 'Löschen',
    'readOnly': '(Nur lesend)',
    'feature.namePrompt': 'Name des neuen Features?',
    'tier.namePrompt': 'Name des neuen Tarifs?',
    'badge.new': 'Neu',
    'export.noPricing': '_Kein Preismodell in der Timeline hinterlegt._',
    'refusal.feature.conflict': 'Feature wurde extern geändert — lade neu…',
    'refusal.tier.conflict': 'Tarif wurde extern geändert — lade neu…',
    'export.note':
      'Änderungen von Hand gehen beim nächsten Export verloren. Quelle der Wahrheit ist die Timeline.',
  },
});
