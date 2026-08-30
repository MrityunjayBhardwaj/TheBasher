import type { Connect, Plugin } from 'vite';
import { Readable } from 'node:stream';
import { TRIPO_ASSET_PROXY_PATH, tripoAssetTargetOf } from '../../src/core/modelgen/tripoProxy';

/**
 * Forward one generated-model download from a same-origin path (#832).
 *
 * WHY THIS IS NOT A `server.proxy` ENTRY. Vite's proxy table maps a path prefix
 * onto ONE fixed upstream. A generated model lives at a signed URL that differs
 * every time — different path, different query, potentially a different regional
 * host — so the target has to travel as a parameter, which only a middleware can
 * read.
 *
 * WHY IT EXISTS AT ALL. The asset host answers a browser with HTTP 200 and no
 * `access-control-allow-origin`, so the bytes arrive and the page is forbidden to
 * read them. Measured on a real signed URL; the reasoning is in `tripoProxy.ts`.
 *
 * 🔴 THE ALLOWLIST INSIDE `tripoAssetTargetOf` IS LOAD-BEARING. Without it this
 * is an open forwarder that any page reaching the dev server can aim at a cloud
 * metadata endpoint or at a service on the developer's own network. A target it
 * will not serve is answered with a status and never fetched.
 *
 * Dev and preview only, exactly like `/__tripo`. A static production build has
 * neither route — the open half of #804.
 */
const handler: Connect.NextHandleFunction = (req, res, next) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') return next();

  // `req.url` is relative to the mount point, so the query survives and the path
  // does not — which is all `tripoAssetTargetOf` reads.
  const target = tripoAssetTargetOf(req.url ?? '');
  if (!target) {
    res.statusCode = 400;
    res.setHeader('Content-Type', 'application/json');
    res.end(
      JSON.stringify({
        error:
          'A `url` parameter naming an https host under tripo3d.com is required. ' +
          'This forwarder deliberately serves nothing else.',
      }),
    );
    return;
  }

  void (async () => {
    try {
      const upstream = await fetch(target, { method: req.method === 'HEAD' ? 'HEAD' : 'GET' });
      res.statusCode = upstream.status;
      const type = upstream.headers.get('content-type');
      const length = upstream.headers.get('content-length');
      if (type) res.setHeader('Content-Type', type);
      if (length) res.setHeader('Content-Length', length);
      // No CORS header is invented: by the time the page reads this it is
      // fetching its own origin, which is the entire point.
      res.setHeader('Cache-Control', 'no-store');

      if (req.method === 'HEAD' || !upstream.body) {
        res.end();
        return;
      }
      // Streamed, not buffered: a generated mesh has been measured at 42.9 MB and
      // holding one in the dev server's heap per download is cost with no upside.
      Readable.fromWeb(upstream.body as Parameters<typeof Readable.fromWeb>[0]).pipe(res);
    } catch (err) {
      // The upstream failing to answer is a different outcome from a refusal and
      // the page must be able to tell them apart, so it gets its own status.
      res.statusCode = 502;
      res.setHeader('Content-Type', 'application/json');
      res.end(
        JSON.stringify({
          error: `Could not reach the asset host: ${
            err instanceof Error ? err.message : String(err)
          }`,
        }),
      );
    }
  })();
};

export function tripoAssetProxyPlugin(): Plugin {
  return {
    name: 'basher:tripo-asset-proxy',
    apply: 'serve',
    // ONE handler on both servers. `preview` serves the production bundle over
    // the same routes, and the download is just as blocked there — registering
    // only on dev would make `npm run preview` fail in a way dev never does.
    configureServer: (server) => {
      server.middlewares.use(TRIPO_ASSET_PROXY_PATH, handler);
    },
    configurePreviewServer: (server) => {
      server.middlewares.use(TRIPO_ASSET_PROXY_PATH, handler);
    },
  };
}
