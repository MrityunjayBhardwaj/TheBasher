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
  TRIPO_ASSET_PROXY_PATH,
  TRIPO_PROXY_PREFIX,
  TRIPO_PROXY_ROUTES,
  isTripoAssetUrl,
  rewriteTripoProxyPath,
  tripoAssetTargetOf,
  tripoBrowserAssetUrl,
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

describe('the asset road: a generated model is fetched same-origin too (#832)', () => {
  // The reason this exists is a MEASUREMENT that contradicted this file's own
  // opening comment. On a real signed URL, from the app's origin:
  //   HTTP 200, content-length 7465804, server: AmazonS3, vary: Origin
  //   and no `access-control-allow-origin` of any kind.
  // The bytes arrive and the browser is forbidden to read them.
  const SIGNED =
    'https://tripo-data.rg1.data.tripo3d.com/tcli_abc/20260830/x/tripo_pbr_model_x.glb' +
    '?Policy=eyJTdGF0ZW1lbnQiOlt7IlJlc291cmNlIjoiaHR0cHM6Ly9x_&Signature=AbC~dEf-gH__&Key-Pair-Id=K1676C64NMVM2J';

  it('round-trips a signed URL through the proxy path without losing the signature', () => {
    // 🔑 THE FAILURE THIS PINS IS SILENT. A signed URL carries `&` and `=` inside
    // its Policy and Signature. Splicing it into a query string instead of
    // encoding it whole truncates the signature at its first `&`, and the
    // download then 403s with a perfectly plausible "expired link" story that
    // sends the reader to the wrong problem entirely.
    const proxied = tripoBrowserAssetUrl(SIGNED);
    expect(proxied.startsWith(`${TRIPO_ASSET_PROXY_PATH}?url=`)).toBe(true);
    expect(tripoAssetTargetOf(proxied.slice(TRIPO_ASSET_PROXY_PATH.length))).toBe(SIGNED);
  });

  it('FALSIFICATION: a spliced (unencoded) URL loses everything after the first &', () => {
    // The pair for the test above — it is only meaningful if the naive way
    // actually breaks. It does.
    const spliced = `${TRIPO_ASSET_PROXY_PATH}?url=${SIGNED}`;
    expect(tripoAssetTargetOf(spliced.slice(TRIPO_ASSET_PROXY_PATH.length))).not.toBe(SIGNED);
  });

  describe('the allowlist is a security boundary, not a tidiness rule', () => {
    // Without it the dev server is an open forwarder any page can aim at cloud
    // metadata or at a service on the developer's own network.
    it.each([
      ['http, not https', 'http://tripo-data.rg1.data.tripo3d.com/x.glb'],
      ['a lookalike suffix', 'https://nottripo3d.com/x.glb'],
      ['the domain as a prefix of another', 'https://tripo3d.com.evil.test/x.glb'],
      ['cloud metadata', 'http://169.254.169.254/latest/meta-data/'],
      ['loopback', 'http://127.0.0.1:8600/generate'],
      ['not a URL at all', 'not-a-url'],
    ])('refuses %s', (_label, url) => {
      expect(isTripoAssetUrl(url)).toBe(false);
      expect(tripoAssetTargetOf(`?url=${encodeURIComponent(url)}`)).toBeNull();
    });

    it('accepts the asset host the service actually hands back', () => {
      expect(isTripoAssetUrl(SIGNED)).toBe(true);
    });

    it('accepts a DIFFERENT region on the same domain, which is why this is a suffix match', () => {
      // `rg1` is a region. Pinning the literal host would break the day a task
      // lands in another one, and it would break as a CORS error again.
      expect(isTripoAssetUrl('https://tripo-data.rg9.data.tripo3d.com/x.glb')).toBe(true);
    });

    it('refuses a missing parameter rather than fetching something empty', () => {
      expect(tripoAssetTargetOf('')).toBeNull();
      expect(tripoAssetTargetOf('?other=1')).toBeNull();
    });
  });
});
