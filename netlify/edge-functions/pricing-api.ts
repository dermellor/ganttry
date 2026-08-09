// Netlify Edge Function — the retired public pricing endpoint.
//
// `GET /api/pricing/<id>` served one plugin's model from an address of its own.
// That was the last piece of the privilege issue #17 removes: a plugin nobody
// wrote into this repo could never have had a route here, so „no plugin has a
// privilege a third party lacks" was false as long as this one did.
//
// It now answers **410 Gone** and names its successor:
//
//   GET /api/public/plugin/product-roadmap/<id>
//
// 410 rather than a redirect, and rather than an alias, because the payload
// changed shape: the old one folded each matrix cell into its tier under
// `values`, and that folding is the plugin's knowledge, not the host's. A
// generic route cannot perform it, so an alias would have to be a hand-written
// translation living outside the plugin — exactly the thing being removed. A
// consumer that silently received a differently-shaped body would render a price
// list with empty columns and nobody would hear about it; a 410 with the new
// address in the body stops the build instead.
//
// The function stays deployed rather than being deleted with its route. A
// deleted function makes the path fall through to the SPA, which answers 200
// with HTML — a build-time `fetch(...).json()` then fails on a parse error that
// says nothing about what happened. This says what happened.
//
// It can go once the deprecation window has passed and no consumer is left. Its
// successor is documented in „Publishing a plugin's data" (docs/plugin-public-read.md).

import type { Context, Config } from '@netlify/edge-functions';

const SUCCESSOR = '/api/public/plugin/product-roadmap/<timelineId>';

export default async function handler(req: Request, _ctx: Context): Promise<Response> {
  const id = new URL(req.url).pathname.replace(/^\/api\/pricing\//, '').replace(/\/+$/, '');
  return new Response(
    JSON.stringify({
      error: 'gone',
      message:
        'GET /api/pricing/<id> has been retired. The pricing model is served by the generic ' +
        `public plugin route: GET ${SUCCESSOR}. The payload shape changed — matrix cells are ` +
        'their own rows in the `tier-values` collection instead of being folded into each ' +
        "tier's `values` map.",
      successor: id ? `/api/public/plugin/product-roadmap/${id}` : SUCCESSOR,
    }),
    {
      status: 410,
      headers: {
        'Content-Type': 'application/json',
        // Not cached: a consumer that fixes its URL must not keep hitting a
        // cached refusal, and there is nothing here worth serving from an edge.
        'Cache-Control': 'no-store',
        'Access-Control-Allow-Origin': '*',
      },
    },
  );
}

export const config: Config = {
  path: '/api/pricing/*',
};
