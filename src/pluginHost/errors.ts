// The errors a host write can throw, as part of the contract.
//
// `ConflictError` lived in `src/editor.ts`, which is app feature code the plugin
// barrel deliberately does not pull in — so a plugin could send `If-Match` through
// `HostApi.data` and had no way to catch the one failure that header exists to
// produce. It caught it by importing the app's editor instead (#117).
//
// A class rather than a status code or a flag, because the call site is a `catch`:
// „was this a version conflict" has to be answerable on an error object that has
// already been thrown past several frames, and every alternative (checking
// `message`, reading a property that may not be there) is the version that breaks
// silently when the wording changes.

/**
 * A write was refused because the row changed since it was read.
 *
 * Thrown by any host write that sent `If-Match`. Recoverable, and the recovery is
 * always the same shape: tell the user, reload the row, let them decide. A plugin
 * that swallows it presents stale data as saved.
 */
export class ConflictError extends Error {
  constructor(message = 'version conflict') {
    super(message);
    this.name = 'ConflictError';
  }
}
