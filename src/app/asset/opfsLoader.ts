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
// REF: THESIS.md §14, §33; vyapti V6.

import { getStorage } from '../boot';

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
