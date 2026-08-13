// The public API of the component layer.
//
// Every import of a component goes through this file, including the plugins'
// (which reach it via `src/pluginHost/api.ts`). Two things follow from that:
// a component that is not exported here does not exist as far as the rest of the
// codebase is concerned, and this list is the inventory the playground and the
// contract are checked against.
//
// Ordered roughly by how fundamental a thing is, not alphabetically — the
// alphabet puts `Avatar` above `Button` and tells the reader nothing.

// The builder every component is written against. Exported because call sites
// that assemble markup as a string need `html()`, and the migration of the
// remaining template literals is not finished.
export * from './dom';

// Typography and the small marks.
export * from './Text';
export * from './Marks';
export * from './Separator';

// Controls.
export * from './Button';
export * from './Input';
export * from './SegmentedControl';

// Forms.
export * from './Field';
export * from './Chip';
export * from './Suggest';
export * from './Tabs';

// Surfaces that float.
export * from './Menu';

// Surfaces that do not.
export * from './Callout';
export * from './Dialog';
export * from './Panel';
export * from './Prose';
export * from './DescriptionList';
export * from './Table';
export * from './Graph';
export * from './Toolbar';
export * from './Layout';
export * from './Skeleton';
