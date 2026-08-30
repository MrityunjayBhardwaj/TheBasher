// tripoProxy — where a Tripo call DEPARTS FROM, as distinct from where Tripo
// lives.
//
// 🔑 THE TWO ARE DIFFERENT FACTS AND THEY HAVE DIFFERENT OWNERS. `tripoDialect`
// states Tripo's address — a fact about the service, true from anywhere. This
// file states the address OUR CALL USES, which is a fact about the runtime the
// call originates in. They coincide everywhere except a browser, and a browser
// is what Basher is.
//
// ## Why a browser needs anything at all
//
// Measured against the live API with a valid key:
//
//   OPTIONS /v3/account/balance   (Origin: http://localhost:5180,
//                                  Access-Control-Request-Headers: authorization)
//     → HTTP 401, and NO access-control-* headers
//   GET     /v3/account/balance   (Origin: http://localhost:5180, valid Bearer)
//     → HTTP 200, and NO access-control-* headers
//
// Every request this client makes carries `Authorization: Bearer …`, which is
// not a CORS-safelisted header, so a browser must preflight. Tripo answers the
// preflight with 401 and no `Access-Control-Allow-Origin`, so the real request
// is never sent. This holds for BOTH API generations — v2 and v3 were measured
// separately — so it is a property of the service, not of a generation, and
// migrating does not fix it.
//
// ## 🔑 ONLY THE API HOST IS BLOCKED. THE ASSET HOST IS NOT.
//
// A generated model is downloaded from a DIFFERENT host, and that one already
// answers a browser:
//
//   GET https://tripo-data.rg1.data.tripo3d.com/… (Origin: http://localhost:5180)
//     → HTTP 200, access-control-allow-origin: *
//                 access-control-allow-headers: *
//                 access-control-allow-methods: *
//
// So the download stays DIRECT and is deliberately not routed here. Proxying it
// would push tens of megabytes per generation through the dev server for no
// reason (the measured mesh was 42.9 MB), and would invent a production
// dependency where none exists. The signed URL carries its own credential, so
// it is a simple request with no preflight to fail.
//
// ## Why the table lives here and not in `vite.config.ts`
//
// The mapping from a same-origin path to an upstream host has exactly two
// readers — the dev server that serves the path, and the client that calls it.
// If either states it independently they can disagree, and the failure is a 404
// that looks like the service being down. One table, both readers, no drift.
//
// REF: src/core/modelgen/tripoDialect.ts (the service's own address);
//      vite.config.ts (the other reader); issue #804.

import { TRIPO_API_VERSIONS, TRIPO_V2_BASE_URL, TRIPO_V3_BASE_URL } from './tripoDialect';
import type { TripoApiVersion } from './tripoDialect';

/**
 * The same-origin prefix every proxied Tripo path starts with.
 *
 * Double-underscored so it reads as infrastructure rather than as an app route,
 * and so it cannot collide with anything the router might later want.
 */
export const TRIPO_PROXY_PREFIX = '/__tripo';

/** One API generation's route, as both readers need it. */
export interface TripoProxyRoute {
  readonly version: TripoApiVersion;
  /** What the client calls. Same-origin, so no preflight and no CORS. */
  readonly path: string;
  /** The upstream ORIGIN the dev server forwards to — scheme and host only. */
  readonly target: string;
  /** The upstream path prefix `path` is rewritten to. */
  readonly upstreamPrefix: string;
}

const BASE_URL_OF: Record<TripoApiVersion, string> = {
  v2: TRIPO_V2_BASE_URL,
  v3: TRIPO_V3_BASE_URL,
};

/**
 * Split a dialect's base URL into the two halves a proxy needs.
 *
 * Derived rather than typed out, because a hand-written copy of a host is a
 * second statement of the same fact and the two drift silently — the symptom
 * would be a 404 from our own dev server, which reads exactly like Tripo being
 * down.
 */
function routeFor(version: TripoApiVersion): TripoProxyRoute {
  const url = new URL(BASE_URL_OF[version]);
  return {
    version,
    path: `${TRIPO_PROXY_PREFIX}/${version}`,
    target: url.origin,
    // `pathname` keeps v2's `/v2/openapi` and v3's `/v3` without either being
    // restated here. Trailing slashes are stripped so joining a dialect path
    // (which always begins with `/`) cannot produce a double slash.
    upstreamPrefix: url.pathname.replace(/\/+$/, ''),
  };
}

/** Every route, in the order the versions are declared. */
export const TRIPO_PROXY_ROUTES: readonly TripoProxyRoute[] = TRIPO_API_VERSIONS.map(routeFor);

/** The route for one API generation. */
export function tripoProxyRoute(version: TripoApiVersion): TripoProxyRoute {
  const route = TRIPO_PROXY_ROUTES.find((r) => r.version === version);
  /* c8 ignore next 3 -- unreachable while TRIPO_API_VERSIONS is the domain of
     both this lookup and the type; kept so a future version added to the type
     but not the list fails loudly rather than returning undefined. */
  if (!route) throw new Error(`tripoProxyRoute: no route for API version "${version}"`);
  return route;
}

/**
 * The base URL a call originating IN A PAGE should use.
 *
 * 🔴 THIS PATH IS SERVED BY THE VITE DEV AND PREVIEW SERVERS AND BY NOTHING
 * ELSE. A production build dropped on a static host has no such route, so the
 * call 404s. That is not an oversight being papered over — it is the deployment
 * question #804 raises and this file cannot answer, and the reason the probe
 * that follows a failure here must say WHY it failed rather than falling
 * through to a stub in silence.
 */
export function tripoBrowserBaseUrl(version: TripoApiVersion): string {
  return tripoProxyRoute(version).path;
}

/**
 * Rewrite a proxied path to its upstream form.
 *
 * Exported for the dev server's `rewrite` hook AND for the test that proves a
 * round trip, so the rule is stated once. A path outside the prefix is returned
 * unchanged rather than mangled — the server only ever hands us matching paths,
 * and silently rewriting a non-match would hide a misconfigured route.
 */
export function rewriteTripoProxyPath(pathname: string): string {
  const route = TRIPO_PROXY_ROUTES.find((r) => pathname.startsWith(`${r.path}/`));
  if (!route) return pathname;
  return route.upstreamPrefix + pathname.slice(route.path.length);
}
