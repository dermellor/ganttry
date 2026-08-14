// The reference catalogue. Every key the interface has is defined here first, and
// `messages.de.ts` is typed as a total record over this object — so a key added
// here and forgotten there does not compile.
//
// **Two namespaces, because „Interface text" (AGENTS.md) names two kinds of text
// with two different limits.**
//
//   - Everything else is a **label or a heading**, and the limit is the one the
//     rule has always had: at most one sentence and eight words.
//   - `refusal.*` is the third category — what the app says about something the
//     user just did: a validation message, a save error, a server's reason for a
//     503. Those are allowed to be a full sentence, and the rule already said so
//     („A long refusal is still allowed, and it is not written inline").
//
// The prefix is what makes that claim **greppable**. Before this file the same
// distinction existed by accident: a long refusal escaped `check-ui-text.mjs`
// because it sat in a rule module rather than at a rendering site, so „is this a
// refusal?" was answered by where the string happened to live. `npm run
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

  // ── Custom fields ────────────────────────────────────────────────────────
  'field.key': 'Key',
  'field.label': 'Label',
  'field.add': '+ Field',
  'field.none': 'No fields of your own yet.',
  'field.contextMenu': 'Offer in the right-click menu too',
  'field.options.hint': 'one per line: value = label #colour',
  'field.optional': 'optional',

  // ── Filter, grouping, presentation ───────────────────────────────────────
  'filter.all': 'All values',
  // The „Ohne …" bucket the core composes from a field's label. The label is the
  // user's own word for their field and is never translated — only the frame is.
  'filter.emptyBucket': 'Without {field}',
  'group.default': 'Group (default)',
  'view.empty': 'No entries in this view.',
  'view.empty.filtered': 'No entries pass the filter.',

  // ── Saved views ──────────────────────────────────────────────────────────
  'savedView.plural': 'Saved views',
  'savedView.name': 'Name of the view',
  'savedView.name.new': 'Name of the new view',
  'savedView.shared': 'Visible to everyone in this instance',
  'savedView.saveCurrent': 'Save the current setting…',
  'savedView.leave': 'Leave the view',
  'savedView.close': 'Close view settings',

  // ── The timeline's own settings ──────────────────────────────────────────
  'timeline.settings.grouping': 'Grouping on open',
  'timeline.settings.export': 'Download as HTML',
  'timeline.none': 'No timeline loaded.',
  'timeline.noChange': 'No change.',
  'timeline.saved': 'Saved.',

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

  // ── Refusals and results: what the app says about what you just did ──────
  // Allowed a full sentence. See the header of this file for why the prefix is
  // the claim rather than the file the string sits in.
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
} as const;
