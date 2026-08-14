// Registers the CSS stub hooks for the test run. Split from the hooks module
// because `module.register` loads its argument in a separate thread — the file
// that calls it and the file that implements the hooks cannot be the same one.
import { register } from 'node:module';

register('./css-hooks.mjs', import.meta.url);
