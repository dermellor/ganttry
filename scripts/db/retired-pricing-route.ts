// `GET /api/pricing/<id>` — retired, and answered anyway. **Dated.**
//
// It served one plugin's model from an address of its own, which is the
// privilege issue #17 removed: a plugin nobody wrote into this repo could never
// have had a route here. Its successor is the generic public plugin route.
//
// Not a redirect and not an alias, because the payload changed shape: the old
// one folded every matrix cell into its tier under `values`, and that folding is
// the plugin's knowledge rather than the host's. A consumer silently handed the
// new shape would render a price list with empty columns and nobody would hear
// about it; a 410 naming the successor stops its build instead.
//
// The route stays answered rather than being dropped. An unrouted `/api/pricing/…`
// falls through to the SPA and returns 200 with HTML, so a build-time
// `fetch(...).json()` fails on a JSON parse error that says nothing about what
// happened.
//
// It lives in a module of its own rather than in `http.ts` for one reason: it has
// to name the plugin it used to serve, and the CI check forbids a plugin id in
// core code (scripts/ci/check-plugin-isolation.mjs). A one-file, allowlisted
// exception is deletable in a single commit once the deprecation window closes;
// an exception carved into the dispatcher would outlive the route.

const PLUGIN_ID = 'dev.zeitlines.product-roadmap';

/** The 410, with the concrete successor URL for this id when there is one. */
export function retiredPricingResponse(pathname: string): Response {
  const id = pathname.replace(/^\/api\/pricing\/?/, '').replace(/\/+$/, '');
  const successor = `/api/public/plugin/${PLUGIN_ID}/${id || '<timelineId>'}`;
  return new Response(
    JSON.stringify({
      error: 'gone',
      message:
        'GET /api/pricing/<id> has been retired. The pricing model is served by the generic public ' +
        `plugin route: GET ${successor}. The payload shape changed — a matrix cell is its own row in ` +
        "the „tier-values\" collection instead of being folded into each tier's `values` map.",
      successor,
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
