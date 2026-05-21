// Resolve an asset path (OPFS-relative or a passthrough URL) to a URL the
// viewport's `useGLTF` can fetch.
//
// Two paths:
//   1. Passthrough — anything starting with `/`, `http(s):`, `blob:`,
//      `data:` is returned as-is. Useful for tests, dev fixtures, and the
//      future Blender bridge that streams over HTTP.
//   2. OPFS read — for OPFS-relative paths (e.g. `assets/cube.gltf`),
//      read the bytes via the StorageCapability and create a stable
//      `blob:` URL.
//
// React Suspense pattern: `useResolvedAssetUrl` returns synchronously when
// the URL is cached, otherwise throws a Promise to trigger Suspense.
//
// Multi-file `.gltf` (#82): when the resolved file is JSON glTF that
// references external sibling URIs (a `.bin` buffer or relative
// texture), the single-blob wrap above is insufficient — three.js
// can't resolve siblings against a `blob:` URL. The loader detects
// that case (JSON-parse + URI scan) and routes through
// `opfsGltfResolver`, which pre-loads every sibling into a sentinel
// URL cache (`basher-opfs:///<opfsPath>`). The viewport's
// `useGltfLoaderExtend` installs a LoadingManager URL modifier that
// resolves those sentinels back to blob URLs at fetch time.
//
// REF: THESIS.md §14, §33; vyapti V6.

import { getStorage } from '../boot';
import { gltfReferencesExternalSiblings, loadMultiFileGltf } from './opfsGltfResolver';

const urlCache = new Map<string, string>();
const promiseCache = new Map<string, Promise<string>>();

function isPassthroughUrl(p: string): boolean {
  return (
    p.startsWith('/') ||
    p.startsWith('http://') ||
    p.startsWith('https://') ||
    p.startsWith('blob:') ||
    p.startsWith('data:')
  );
}

function load(path: string): Promise<string> {
  if (isPassthroughUrl(path)) {
    return Promise.resolve(path);
  }
  return (async () => {
    const storage = await getStorage();
    const bytes = await storage.read(path);
    if (path.toLowerCase().endsWith('.gltf')) {
      // Cheap parse-and-scan first; only route to the multi-file path
      // when the JSON actually references external siblings. Catches
      // self-contained data-URI `.gltf` (the bundled cube/sphere/cone)
      // on the legacy blob-URL fast-path with no behaviour change.
      try {
        const json = JSON.parse(new TextDecoder().decode(bytes)) as unknown;
        if (gltfReferencesExternalSiblings(json)) {
          return loadMultiFileGltf(storage, path, bytes);
        }
      } catch {
        // Not valid JSON — fall through to the legacy blob-URL path.
        // A `.gltf` with invalid JSON is the consumer's problem to
        // surface; we don't want to mask the actual parse error here.
      }
    }
    const ab = new ArrayBuffer(bytes.byteLength);
    new Uint8Array(ab).set(bytes);
    const blob = new Blob([ab], { type: 'model/gltf+json' });
    return URL.createObjectURL(blob);
  })();
}

/**
 * Suspense-friendly resolver. Returns a URL synchronously if cached;
 * otherwise throws the in-flight resolution Promise. React Suspense
 * boundaries above (the viewport's `<Suspense>`) catch the throw.
 */
export function useResolvedAssetUrl(path: string): string {
  const cached = urlCache.get(path);
  if (cached) return cached;
  let p = promiseCache.get(path);
  if (!p) {
    p = load(path).then((url) => {
      urlCache.set(path, url);
      return url;
    });
    promiseCache.set(path, p);
  }
  throw p;
}

/** Async accessor for non-React callers (tests, future tools). */
export function resolveAssetUrl(path: string): Promise<string> {
  return load(path);
}

/** Test-only — clear caches and revoke any active blob URLs. */
export function __resetAssetUrlCacheForTests(): void {
  for (const url of urlCache.values()) URL.revokeObjectURL(url);
  urlCache.clear();
  promiseCache.clear();
}
