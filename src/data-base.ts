/**
 * Base path this instance's build output is served from.
 *
 * `scripts/build-data.ts` writes to `public/<TIMELINES_DATA_DIR>/` and
 * `vite.config.ts` hands the matching URL prefix to the client, so two
 * instances can run from one checkout without overwriting each other. A plain
 * single-instance setup leaves both unset and stays on `/data`.
 */
export const DATA_BASE = (import.meta.env.VITE_DATA_BASE || '/data').replace(/\/+$/, '');

/** URL of a file inside this instance's build output. */
export function dataUrl(path: string): string {
  return `${DATA_BASE}/${path.replace(/^\/+/, '')}`;
}
