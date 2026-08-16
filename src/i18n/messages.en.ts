// The reference catalogue. Every key the interface has is defined here first, and
// `messages.de.ts` is typed as a total record over this object — so a key added
// here and forgotten there does not compile.
//
// **Two namespaces, because “Interface text” (AGENTS.md) names two kinds of text
// with two different limits.**
//
//   - Everything else is a **label or a heading**, and the limit is the one the
//     rule has always had: at most one sentence and eight words.
//   - `refusal.*` is the third category — what the app says about something the
//     user just did: a validation message, a save error, a server's reason for a
//     503. Those are allowed to be a full sentence, and the rule already said so
//     (“A long refusal is still allowed, and it is not written inline”).
//
// The prefix is what makes that claim **greppable**. Before this file the same
// distinction existed by accident: a long refusal escaped `check-ui-text.mjs`
// because it sat in a rule module rather than at a rendering site, so “is this a
// refusal?” was answered by where the string happened to live. `npm run
// ui-text:check` now walks both catalogues and holds every non-`refusal.` key to
// the eight-word limit, which is a complete check over a complete list rather than
// a pattern match over call sites.
//
// Calling something `refusal.` to get the extra room is the one way to cheat this,
// and it is deliberately a visible lie in a diff rather than an invisible one.
//
// Keys are grouped by where they appear, and the grouping is a comment rather than
// a nested object: `keyof` over a flat object is the complete key list, which is
// what the type check and the text check both walk.
//
// **Quotation marks are the language's, not the codebase's.** English quotes a
// value with “…” and German with „…", and the two are not interchangeable: the
// first English screenshots of this interface showed „Sprint 3" in otherwise
// English sentences, which reads to a native eye exactly the way a German sentence
// full of "straight quotes" reads. So this file uses “…” throughout and
// `messages.de.ts` keeps „…". Assembling the quotes at the call site around a
// value from the catalogue is what produces the mixture — put the whole sentence,
// quotes included, in the key.

export const EN = {
  // ── Chrome: the header, the menu, the shell ──────────────────────────────
  'app.menu': 'Menu',
  'app.search': 'Search…',
  'app.settings': 'Settings',
  'app.settings.timeline': 'Settings for this timeline',
  'app.settings.close': 'Close settings',
  'app.settings.timeline.close': 'Close timeline settings',
  'app.signOut': 'Sign out',
  'app.noInstanceActions': 'No instance actions',
  'app.loadingConfig': 'Loading configuration…',
  'app.loading': 'Loading …',
  'app.plugins.state': 'Installed plugins and their state',

  // ── The timeline switcher ────────────────────────────────────────────────
  'switcher.open': 'open',
  'switcher.noMatch': 'No timeline matches.',
  'switcher.readOnly': 'Read-only',
  // The heading a group of sources gets. `SourceKind` is the stored vocabulary
  // (`db`, `local`); only the heading over it is a label.
  'switcher.origin.db': 'Database',
  'switcher.origin.local': 'Local',

  // ── Items ────────────────────────────────────────────────────────────────
  'item.create': '+ Entry',
  'item.create.aria': 'Add a new entry',
  'item.new': 'New entry',
  'item.delete': 'Delete entry',
  'item.children.show': 'Show sub-entries',
  'item.children.hide': 'Hide sub-entries',
  'item.children': 'Sub-entries',
  'item.parent': 'Parent',
  'item.search': 'Search entry…',
  'item.background.edit': 'Edit background entry',
  'item.selectedBy': 'has selected this entry',
  'item.unsaved': 'not saved yet',
  'item.count.one': '{count} entry',
  'item.count.other': '{count} entries',
  'item.untitled': '(untitled)',
  'item.delete.confirm': 'Really delete “{label}”?',
  'item.background.editNamed': 'Edit {label}',
  // The children's extent against the parent's. Three keys rather than one with
  // an “and” glued in: a conjunction assembled at the call site is the shape that
  // reads as a translation the moment a language puts the verb somewhere else.
  'item.children.overflow.before': 'Sub-entries start on {before}.',
  'item.children.overflow.after': 'Sub-entries run until {after}.',
  'item.children.overflow.both': 'Sub-entries start on {before} and run until {after}.',

  // ── The temporal type of an item ─────────────────────────────────────────
  // The keys in `ITEM_TYPE_KEYS` are stored on items (`type: 'point'`); only these
  // labels move. See src/i18n/storedValues.test.ts for the line that separates
  // the two.
  'itemType.point': 'Milestone',
  'itemType.range': 'Range',
  'itemType.background': 'Phase',
  'itemType.box': 'Marker',
  'itemType.auto': 'Automatic',
  // The picker names what the type looks like, which is the choice being made there.
  'itemType.background.long': 'Phase (background)',

  // ── The icon set ─────────────────────────────────────────────────────────
  // `IconKey` is stored on items and resolves to a `--icon-<key>` custom
  // property; these are the words the picker offers for it.
  'icon.milestone': 'Milestone',
  'icon.launch': 'Launch',
  'icon.done': 'Done',
  'icon.warning': 'Warning',
  'icon.blocked': 'Blocked',
  'icon.review': 'Review',
  'icon.deadline': 'Deadline',
  'icon.meeting': 'Meeting',
  'icon.idea': 'Idea',
  'icon.research': 'Research',
  'icon.design': 'Design',
  'icon.build': 'Build',
  'icon.bug': 'Bug',
  'icon.release': 'Release',
  'icon.decision': 'Decision',
  'icon.goal': 'Goal',
  'icon.info': 'Info',
  'icon.note': 'Note',

  // ── The item form ────────────────────────────────────────────────────────
  'form.save': 'Save',
  'form.cancel': 'Cancel',
  'form.delete': 'Delete',
  'form.close': 'Close',
  'form.add': 'add…',
  'form.select': 'Select…',
  'form.noValue': 'no value',
  'form.noIcon': 'no icon',
  'form.noIcon.option': '— no icon —',
  'form.endEmpty': 'empty = use the end',
  'form.milestoneOnly': 'only without an end date',
  'form.dateTime': 'Date & time',
  'form.dependsOn': 'Depends on',
  'form.metadata': 'Other metadata (JSON)',
  'form.jira.search': 'Ticket or key, e.g. PROJ-123…',
  'form.owner.search': 'Search a person…',
  'form.owner.unreachable': 'User directory unreachable',
  'form.owner.empty': 'No users recorded yet',
  'form.moveUp': 'Move up',
  'form.moveDown': 'Move down',
  'form.remove': 'Remove',
  'form.saving': 'Saving …',
  'form.name': 'Name',
  'form.title': 'Title',
  'form.description': 'Description',
  'form.start': 'Start',
  'form.end': 'End',
  'form.duration': 'Duration',
  'form.icon': 'Icon',
  'form.color': 'Colour',
  'form.id': 'ID',
  'form.readOnly': '(read-only)',
  'form.preset': 'default',
  'form.advanced': 'Advanced',
  'form.tabs': 'Fields',
  'form.noMatch': 'No match',
  'form.owner.remove': 'Remove owner',
  'form.owner.unlinked': '{value} — not linked to a user',

  // ── The audit block under an item's form ─────────────────────────────────
  'audit.created': 'Created',
  'audit.updated': 'Updated',
  'audit.metadata': 'Metadata',
  'audit.by': 'by',

  // ── Custom fields ────────────────────────────────────────────────────────
  'field.key': 'Key',
  'field.label': 'Label',
  'field.add': '+ Field',
  'field.none': 'No fields of your own yet.',
  'field.contextMenu': 'Offer in the right-click menu too',
  'field.options.hint': 'one per line: value = label #colour',
  'field.optional': 'optional',
  'field.new': 'New field',
  'field.type': 'Type',
  'field.values': 'Values',
  'field.section': 'Section',
  // The state of the input, which is where a reason belongs — see “Interface
  // text” (AGENTS.md).
  'field.keyLocked': 'fixed, because in use',
  'field.problems': '{count} problem(s) to resolve.',
  'field.valueNotListed': '{value} (not in the list)',
  'field.type.text': 'Text',
  'field.type.select': 'Choice',
  'field.type.multiSelect': 'Multiple choice',

  // ── Filter, grouping, presentation ───────────────────────────────────────
  'view.grouping': 'Group by',
  'view.filter': 'Filter',
  'view.presentation': 'Presentation',
  'view.filterValues': 'Filter values',
  'view.areas': 'Areas',
  'view.timeline': 'Timeline',
  'view.list': 'List',
  'view.graph': 'Graph',
  'app.timelines': 'Timelines',
  'app.online': 'Online',
  'app.plugins': 'Plugins',
  'filter.all': 'All values',
  // The “Ohne …” bucket the core composes from a field's label. The label is the
  // user's own word for their field and is never translated — only the frame is.
  'filter.count.one': '1 value',
  'filter.count.other': '{count} values',
  'filter.emptyBucket': 'Without {field}',
  // The link fields a timeline draws edges from. A field's own name is the vault
  // author's word and is never translated — only these frames are.
  'edges.label': 'Relations',
  'edges.all': 'All fields',
  'edges.count.one': '1 field',
  'edges.count.other': '{count} fields',
  // A link written in the note's text rather than in a frontmatter field.
  'edges.body': 'Body text',
  'edges.off': 'Off',
  'edges.in': 'Incoming',
  'edges.out': 'Outgoing',
  'group.default': 'Group (default)',
  // „No group is named here", the empty option of a setting that names one.
  'group.none': 'None',
  'groupOrder.alpha': 'Alphabetical (default)',
  'groupOrder.declared': 'As declared',
  'view.empty': 'No entries in this view.',
  'view.empty.filtered': 'No entries pass the filter.',
  // The dimensions a list can be grouped or filtered by. The dimension *keys*
  // (`group`, `tag`, `status`, `type`) are stored in a saved view and in the
  // hash; these are only what they are called.
  'dimension.group': 'Group',
  'dimension.tag': 'Tag',
  'dimension.status': 'Status',
  'dimension.type': 'Type',

  // ── The list view's columns ──────────────────────────────────────────────
  'list.column.entry': 'Entry',
  'list.column.start': 'Start',
  'list.column.end': 'End',
  'list.column.type': 'Type',
  'list.column.status': 'Status',
  'list.column.owner': 'Owner',

  // ── Saved views ──────────────────────────────────────────────────────────
  'savedView.plural': 'Saved views',
  'savedView.name': 'Name of the view',
  'savedView.name.new': 'Name of the new view',
  'savedView.shared': 'Visible to everyone in this instance',
  'savedView.saveCurrent': 'Save the current setting…',
  'savedView.leave': 'Leave the view',
  'savedView.close': 'Close view settings',
  'savedView.section': 'Views',
  'savedView.visibility': 'Visibility',
  'savedView.sharedMark': 'shared',
  'savedView.settings': 'Settings of view “{name}”',
  'savedView.trigger': 'Saved views: {name}',
  'savedView.drifted': '“{name}” with unsaved changes',
  'savedView.update': 'Update “{name}”',
  'savedView.saved': 'View “{name}” saved.',
  'savedView.updated': 'View “{name}” updated.',
  'savedView.deleted': 'View “{name}” deleted.',
  'savedView.delete.confirm': 'Really delete view “{name}”?',
  'savedView.error': 'View: {message}',

  // ── The timeline's own settings ──────────────────────────────────────────
  'timeline.settings.grouping': 'Grouping on open',
  'timeline.settings.groupOrder': 'Group order',
  // A heading over the two settings the relation graph reads, so each label can
  // name its group without repeating which presentation it steers.
  'timeline.settings.graph': 'Graph',
  'timeline.settings.graph.bandRoots': 'Group supplying band headings',
  'timeline.settings.graph.references': 'Group listed on the nodes',
  'timeline.settings.export': 'Download as HTML',
  'timeline.settings.general': 'General',
  'timeline.settings.fields': 'Fields',
  'timeline.settings.export.section': 'Export',
  'timeline.none': 'No timeline loaded.',
  'timeline.noChange': 'No change.',
  'timeline.saved': 'Saved.',
  // The status line's tail: entries the timeline cannot place. Named as a count
  // rather than listed, and the timeline is named rather than the presentations
  // that do show them — see `statusFor` in src/render.ts.
  'timeline.datelessHint': '{count} without a start (not on the timeline)',
  // The status line under the timeline. It was the last English sentence written
  // at a call site rather than declared here, and it survived the sweep because
  // the sweep looked for German: “6 items in … · 3 groups” reads as finished work
  // in every language until somebody switches to German and it does not move.
  'timeline.status': '{items} in “{name}” · {groups}',
  'timeline.items.one': '{count} item',
  'timeline.items.other': '{count} items',
  'timeline.groups.one': '{count} group',
  'timeline.groups.other': '{count} groups',
  'export.generating': 'Generating …',
  'export.done': 'File created.',

  // ── Phases ───────────────────────────────────────────────────────────────
  'phase.unnamed': '(unnamed phase)',
  'phase.updated': 'Phase “{label}” updated',
  'phase.delete.confirm': 'Really delete phase “{label}”?',

  // ── The instance settings area ───────────────────────────────────────────
  'settings.section.instance': 'Instance',
  'settings.section.members': 'Users',
  'settings.section.account': 'Account',
  'settings.none': 'This instance declares no settings.',
  'settings.unset': 'not set',
  'settings.set': 'set',
  'settings.default': '(default)',
  'settings.column.setting': 'Setting',
  'settings.column.value': 'Value',
  'settings.origin': 'Origin',
  'settings.on': 'on',
  'settings.off': 'off',
  'settings.empty': 'empty',
  'settings.home.env': 'Environment',
  'settings.home.build': 'Build',
  'settings.home.db': 'Database',

  // ── The declared settings, by variable ───────────────────────────────────
  'setting.group.access': 'Access',
  'setting.group.automation': 'Automation',
  'setting.group.data': 'Data',
  'setting.TIMELINES_ACCESS_CONTROL': 'Access control',
  'setting.TIMELINES_BOOTSTRAP_ADMIN': 'Master key (first administrator)',
  'setting.AUTH_REQUIRED': 'Sign-in required',
  'setting.ALLOWED_EMAIL_DOMAINS': 'Allowed sign-in domains',
  'setting.TIMELINES_TRUSTED_IDENTITY_HEADER': 'Identity header of the proxy',
  'setting.TIMELINES_ALLOWED_EMAIL_DOMAINS': 'Allowed domains behind the proxy',
  'setting.MCP_TOKEN_ROLE': 'Role of the service tokens',
  'setting.MCP_API_TOKEN': 'Service token',
  'setting.TIMELINES_DATABASE_URL': 'Postgres connection',
  'setting.TIMELINES_SUPABASE_URL': 'Supabase project',
  'setting.TIMELINES_SUPABASE_SERVICE_KEY': 'Supabase service key',
  'setting.TIMELINES_DB_LIVE': 'Live updates',
  'setting.TIMELINES_DATA_DIR': 'Data directory',
  'setting.TIMELINES_SOURCES_SUBDIR': 'Built data sources',
  'setting.TIMELINES_DEFAULT_LANGUAGE': 'Default language',

  // ── The account section: the first writable setting ──────────────────────
  'account.language': 'Language',
  'account.language.de': 'Deutsch',
  'account.language.en': 'English',
  'account.local': 'On this device only',

  // ── Members ──────────────────────────────────────────────────────────────
  'members.invite': 'Invite an e-mail address',
  'members.none': 'Nobody invited yet.',
  'members.inviteLink': 'Invitation link for',
  'members.inviteLinkField': 'Invitation link',
  'members.emailPlaceholder': 'address@example.com',
  'members.submit': 'Invite',
  'members.copy': 'Copy',
  'members.role': 'Role',
  'members.column.person': 'Person',
  'members.column.lastSeen': 'Last seen',
  // `MemberStatus` and `MemberRole` are stored on the membership row; these are
  // the words the table shows for them.
  'members.status.invited': 'Invited',
  'members.status.active': 'Active',
  'members.status.suspended': 'Suspended',
  'members.status.removed': 'Removed',
  'members.role.admin': 'Administrator',
  'members.role.editor': 'Editor',
  'members.role.viewer': 'Reader',
  'members.action.resend': 'Invite again',
  'members.action.suspend': 'Suspend',
  'members.action.restore': 'Restore',
  'members.action.remove': 'Remove',
  'members.invited': '{email} invited.',
  'members.reinvited': 'New invitation for {email}.',
  'members.suspended': '{email} suspended.',
  'members.restored': '{email} restored.',
  'members.removed': '{email} removed.',
  'members.roleChanged': 'Role of {email} changed.',
  'members.linkCopied': 'Link copied.',

  // ── Plugins ──────────────────────────────────────────────────────────────
  'plugin.active': 'active in this timeline',
  'plugin.inactive': 'not active',
  'plugin.disabled': 'switched off for this instance',
  'plugin.versionMismatch': 'does not fit this host version',
  'plugin.manifestInvalid': 'the manifest is no longer valid',
  'plugin.originUnsupported': 'the origin of the code is unsupported',
  'plugin.unreachable': 'the code is unreachable',
  'plugin.checksumMismatch': 'the code differs from its checksum',
  'plugin.codeMismatch': 'the code does not match the manifest',
  'plugin.loadFailed': 'loading failed',
  'plugin.unloadable': 'cannot be loaded',

  // ── The graph ────────────────────────────────────────────────────────────
  'graph.dependency': 'Dependency',
  'graph.parent': 'Parent',

  // ── Connection ───────────────────────────────────────────────────────────
  'sync.noApi': 'no connection to the API',
  'sync.offline': 'no connection',
  'sync.conflict': 'Conflict: changed elsewhere, reloading…',
  'sync.saving': 'Saving…',
  'sync.saved': 'Saved · {count} items',

  // ── Refusals and results: what the app says about what you just did ──────
  // Allowed a full sentence. See the header of this file for why the prefix is
  // the claim rather than the file the string sits in.
  'refusal.field.keyMissing': 'Without a key the field can store nothing.',
  'refusal.field.keyShape': 'A key may hold only letters, digits, “-” and “_”, and must start with a letter.',
  'refusal.field.keyReserved': '“{key}” already has a field of its own in the form.',
  'refusal.field.keyFromPlugin': '“{key}” comes from a plugin. A stored field on it would never appear.',
  'refusal.field.keyTaken': '“{key}” is already taken (field {index}).',
  'refusal.field.labelMissing': 'Without a label nobody knows what the field means.',
  'refusal.field.optionsMissing': 'A choice with no values can choose nothing.',
  'refusal.settings.unreadable': 'This runtime cannot read its own configuration.',
  'refusal.forbidden': 'You do not have the rights for that.',
  'refusal.accessControlOff':
    'Access control is off on this instance: TIMELINES_ACCESS_CONTROL=true turns it on.',
  'refusal.members.lastAdmin': 'That would leave the instance without an active administrator.',
  'refusal.members.nothingToResend': 'This membership is awaiting no invitation.',
  'refusal.members.needsDatabase': 'Memberships need a database on this instance.',
  'refusal.members.off': 'User administration is not switched on for this instance.',
  'refusal.members.unreadable': 'The member list is unreadable. The migration is probably missing.',
  'refusal.members.invalid': 'This input is not valid.',
  'refusal.members.notAMember': 'This address is not a member.',
  'refusal.members.linkCopy': 'Link selected — copy it with Ctrl/Cmd+C.',
  'refusal.metadata.invalid': 'Metadata JSON invalid — change not applied.',
  'refusal.conflict.item': 'This entry was changed elsewhere — saving will reload.',
  'refusal.account.saveFailed': 'Not saved.',
  'refusal.account.saved': 'Saved.',
  'refusal.item.reversedExtent': 'The end date has to be after the start (start {start}, end {end}).',
  'refusal.phase.overlap': 'Phases must not overlap: “{a}” and “{b}”.',
  'refusal.source.localFailed': 'Local source “{id}” could not be loaded ({reason}).',
  'refusal.source.fileFailed': 'File source “{id}” could not be loaded ({reason}).',
  'refusal.source.dbFailed': 'Timeline “{id}” could not be loaded from the database ({reason}).',
  'refusal.source.forbidden':
    'You do not have access to the timeline “{id}”. Ask an administrator of this instance for it.',
  'refusal.source.loadFailed': 'Could not load source {id}: {message}',
  'refusal.save.failed': 'Saving failed: {message}',
  'refusal.export.failed': 'Export failed: {message}',
  'refusal.plugin.renderFailed': '“{name}” could not be rendered.',
} as const;
