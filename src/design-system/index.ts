// The design system: tokens, components, and the document layer they assume.
//
// Importing this module is what puts the token layer and the base stylesheet on
// the page — the component stylesheets come with the components themselves, so
// a build only carries the CSS for what it actually renders. That is why there
// is no single `all.css`: it would undo the code splitting the plugin boundary
// depends on (see AGENTS.md → „Plugins" and scripts/ci/check-bundle-split.sh).
//
// The contract for using any of this is in docs/design-system.md.

import './tokens/tokens.css';
import './tokens/icons.css';
import './styles/base.css';

export * from './components';
export { tokens, TOKEN_NAMES } from './tokens';
