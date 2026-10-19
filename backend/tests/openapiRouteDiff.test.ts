/**
 * Live route ↔ OpenAPI drift check (issue #748).
 *
 * Runs in the `test:contract` CI step next to the response-contract suite.
 * It walks the real Express router tree, compares it with the operations the
 * OpenAPI document declares, and fails with a two-sided diff:
 *
 *   + METHOD /path   served by the app but missing from the spec
 *   - METHOD /path   declared in the spec but not served by the app
 *
 * Fixing a failure means documenting the route (`@openapi` JSDoc or
 * `src/api/docs.ts`), removing the stale spec entry, or, for a path no
 * router walk can see, adding it to the allowlist below with a reason.
 */
import { createApp } from '../src/api/app';
import { openapiSpec } from '../src/api/docs';
import { collectLiveRoutes, collectSpecOperations } from './helpers/liveRoutes';

/** Operations served outside the Express router stack, with the reason. */
const NOT_IN_ROUTER_STACK: Record<string, string> = {
  'GET /tasks/{id}/stream': 'WebSocket upgrade handler on the HTTP server',
};

function formatDiff(undocumented: string[], unserved: string[]): string {
  const lines = [
    ...undocumented.map((op) => `  + ${op}   (served, not in spec)`),
    ...unserved.map((op) => `  - ${op}   (in spec, not served)`),
  ];
  return `OpenAPI route drift (${lines.length}):\n${lines.join('\n')}`;
}

describe('OpenAPI route drift (#748)', () => {
  let app: ReturnType<typeof createApp>;

  beforeAll(() => {
    app = createApp({
      disableCompression: true,
      enableHeartbeatCleanup: false,
      enableQueueWorker: false,
    });
  });

  afterAll((done) => {
    app.close(done);
  });

  it('has no drift between live routes and the spec', () => {
    const live = collectLiveRoutes(app.httpServer, app.versionDispatchedRoutes);
    const spec = collectSpecOperations(openapiSpec);

    // A broken walker would report an empty tree and pass vacuously.
    expect(live).toContain('GET /health');
    expect(live).toContain('POST /api/tasks');

    const undocumented = live.filter((op) => !spec.includes(op) && !(op in NOT_IN_ROUTER_STACK));
    const unserved = spec.filter((op) => !live.includes(op) && !(op in NOT_IN_ROUTER_STACK));

    if (undocumented.length > 0 || unserved.length > 0) {
      throw new Error(formatDiff(undocumented, unserved));
    }
  });

  it('only allowlists operations the spec still declares', () => {
    const spec = collectSpecOperations(openapiSpec);
    const stale = Object.keys(NOT_IN_ROUTER_STACK).filter((op) => !spec.includes(op));
    expect(stale).toEqual([]);
  });
});
