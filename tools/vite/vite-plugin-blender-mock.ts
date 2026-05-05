import type { Plugin, ViteDevServer } from 'vite';

/**
 * V0.5 Blender beacon mock middleware.
 *
 * Browser cannot host an HTTP server, so the Blender companion script is
 * authoritative. In dev, when no companion is running, this plugin serves a
 * placeholder so the polling loop has something to talk to. The endpoint is
 * dev-only; production builds never include it (acceptance test #6).
 *
 * The companion script (tools/blender-companion/serve.py) takes precedence
 * when running — Vite proxies /__blender/* to localhost:7777 first, falling
 * through to this mock only if the proxy connection refuses.
 *
 * REF: THESIS.md §32, dharana B5.
 */
export function blenderMockPlugin(): Plugin {
  return {
    name: 'basher:blender-mock',
    apply: 'serve',
    configureServer(server: ViteDevServer) {
      server.middlewares.use('/__assets/active', (req, res, next) => {
        if (req.method !== 'GET') return next();
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Cache-Control', 'no-store');
        res.end(
          JSON.stringify({
            ok: true,
            source: 'vite-mock',
            companionConnected: false,
            assetsDir: null,
            lastUpdate: null,
          }),
        );
      });
    },
  };
}
