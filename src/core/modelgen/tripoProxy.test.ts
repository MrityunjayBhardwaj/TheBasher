// The Tripo transport's origin — that a page's call departs from a same-origin
// path, and that the path resolves back to the service's real address.
//
// What these tests can and cannot prove is the whole point of #804, so it is
// stated once here: a contract test proves the CONTRACT, never the
// REACHABILITY. Nothing below establishes that a browser can reach Tripo — only
// that the two readers of the route table agree, and that the round trip is
// identity. The reachability claim is an observation against a running dev
// server, recorded in the PR, and it cannot be made from a unit test.

import { describe, it, expect } from 'vitest';
import {
  TRIPO_PROXY_PREFIX,
  TRIPO_PROXY_ROUTES,
  rewriteTripoProxyPath,
  tripoBrowserBaseUrl,
  tripoProxyRoute,
} from './tripoProxy';
import {
  TRIPO_API_VERSIONS,
  TRIPO_V2_BASE_URL,
  TRIPO_V3_BASE_URL,
  DEFAULT_TRIPO_API_VERSION,
  tripoDialect,
} from './tripoDialect';
import { browserTripoOptions } from './index';

describe('the route table covers what the client can hold', () => {
  it('has a route for every declared API version', () => {
    expect(TRIPO_PROXY_ROUTES.map((r) => r.version)).toEqual([...TRIPO_API_VERSIONS]);
  });

  it('routes are same-origin — no scheme, no host, so no preflight', () => {
    for (const route of TRIPO_PROXY_ROUTES) {
      expect(route.path.startsWith('/')).toBe(true);
      expect(route.path).not.toMatch(/^https?:/);
      expect(route.path.startsWith(`${TRIPO_PROXY_PREFIX}/`)).toBe(true);
    }
    expect(TRIPO_PROXY_ROUTES.length).toBeGreaterThan(0);
  });

  it('paths are distinct, so one version cannot shadow another', () => {
    const paths = TRIPO_PROXY_ROUTES.map((r) => r.path);
    expect(new Set(paths).size).toBe(paths.length);
  });
});

describe('target and prefix are DERIVED from the dialect, not restated', () => {
  it.each([
    ['v2', TRIPO_V2_BASE_URL],
    ['v3', TRIPO_V3_BASE_URL],
  ] as const)('%s recomposes exactly to its dialect base URL', (version, baseUrl) => {
    const route = tripoProxyRoute(version);
    // The load-bearing property: target + upstreamPrefix IS the service address.
    // If someone hand-edits either half, this fails rather than 404ing at runtime.
    expect(route.target + route.upstreamPrefix).toBe(baseUrl);
    expect(route.target).toBe(new URL(baseUrl).origin);
  });

  it('v2 and v3 live on DIFFERENT hosts — the reason a route is per-version', () => {
    expect(tripoProxyRoute('v2').target).not.toBe(tripoProxyRoute('v3').target);
  });
});

describe('rewriting a proxied path is a round trip to the service address', () => {
  it.each([...TRIPO_API_VERSIONS])(
    '%s: proxy path + dialect path rewrites to the upstream path',
    (version) => {
      const route = tripoProxyRoute(version);
      const dialect = tripoDialect(version);
      // Exactly what the client will send: its base URL plus a dialect path.
      const sent = `${tripoBrowserBaseUrl(version)}${dialect.balancePath}`;
      const rewritten = rewriteTripoProxyPath(sent);
      expect(rewritten).toBe(`${route.upstreamPrefix}${dialect.balancePath}`);
      // And the absolute URL the dev server ends up requesting is the one a
      // node caller would have requested directly.
      expect(route.target + rewritten).toBe(`${dialect.baseUrl}${dialect.balancePath}`);
    },
  );

  it('never produces a double slash', () => {
    for (const version of TRIPO_API_VERSIONS) {
      const dialect = tripoDialect(version);
      const out = rewriteTripoProxyPath(
        `${tripoBrowserBaseUrl(version)}${dialect.taskPath('abc')}`,
      );
      expect(out).not.toMatch(/\/\//);
    }
  });

  it('leaves a path outside the prefix ALONE rather than mangling it', () => {
    // A silent rewrite here would hide a misconfigured route: the server would
    // forward an app path upstream and the 404 would look like Tripo's.
    expect(rewriteTripoProxyPath('/api/scene')).toBe('/api/scene');
    expect(rewriteTripoProxyPath('/')).toBe('/');
    // The prefix alone is not a route — only `prefix/version/...` is.
    expect(rewriteTripoProxyPath(TRIPO_PROXY_PREFIX)).toBe(TRIPO_PROXY_PREFIX);
  });

  it('does not rewrite the ASSET host, which needs no proxy', () => {
    // Measured: tripo-data.rg1.data.tripo3d.com answers
    // `access-control-allow-origin: *`, so a 42.9 MB mesh download is already
    // reachable from a page and must stay direct.
    const assetUrl = 'https://tripo-data.rg1.data.tripo3d.com/tcli_x/20260829/model.glb?sig=1';
    expect(rewriteTripoProxyPath(assetUrl)).toBe(assetUrl);
  });
});

describe('browserTripoOptions hands back the version WITH its base URL', () => {
  it('defaults to the default API version', () => {
    const opts = browserTripoOptions();
    expect(opts.apiVersion).toBe(DEFAULT_TRIPO_API_VERSION);
    expect(opts.baseUrl).toBe(tripoBrowserBaseUrl(DEFAULT_TRIPO_API_VERSION));
  });

  it.each([...TRIPO_API_VERSIONS])('%s: the pair always agrees', (version) => {
    const opts = browserTripoOptions(version);
    expect(opts.apiVersion).toBe(version);
    // The failure this forecloses: a base URL for one generation under the
    // dialect of another sends v2 paths to a v3 route, which 404s and reads as
    // the service being down.
    expect(rewriteTripoProxyPath(`${opts.baseUrl}/x`)).toBe(
      `${tripoProxyRoute(version).upstreamPrefix}/x`,
    );
  });

  it('never returns an absolute URL — that would reintroduce the preflight', () => {
    for (const version of TRIPO_API_VERSIONS) {
      expect(browserTripoOptions(version).baseUrl).not.toMatch(/^https?:/);
    }
  });
});
