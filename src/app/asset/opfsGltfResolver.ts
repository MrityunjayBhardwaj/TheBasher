// Multi-file `.gltf` sibling resolution for OPFS-backed assets (#82).
//
// Why this exists:
//   A `.gltf` file is JSON that may reference sibling resources (`.bin`
//   buffers, `.png`/`.jpg` textures) by relative URI. three.js's
//   GLTFLoader resolves those URIs by string-concatenating onto the
//   "directory" of the URL it was handed (`LoaderUtils.extractUrlBase` +
//   `LoaderUtils.resolveURL` — straight `path + url`). When `opfsLoader`
//   wraps the bytes as a single `blob:` URL, the blob URL has no useful
//   directory — `extractUrlBase('blob:http://host/uuid')` returns
//   `blob:http://host/` and `path + 'foo.bin'` = `blob:http://host/foo.bin`,
//   which `fetch` rejects. So a multi-file `.gltf` silently fails to
//   load its buffers/textures — the user sees an "import" finish but
//   with empty geometry / missing textures.
//
// Fix shape:
//   - For multi-file `.gltf` only (self-contained data-URI `.gltf` and
//     `.glb` are unaffected), route through a sentinel URL scheme
//     `basher-opfs:///<opfsPath>` that three.js can resolve relative
//     siblings against using its own concatenation logic
//     (`basher-opfs:///dir/main.gltf` + `foo.bin` → `basher-opfs:///dir/foo.bin`).
//   - Pre-resolve every sibling URI to an OPFS blob URL at load time,
//     storing each in a module-level cache keyed by its sentinel URL.
//   - Register a `LoadingManager.setURLModifier` that does a sync map
//     lookup; on a hit it returns the blob URL, on a miss the URL is
//     passed through unchanged (so non-sentinel URLs — Draco WASM,
//     KTX2 transcoder, etc. — keep working).
//
// The sentinel scheme is deliberately not a real protocol — `fetch` is
// never called on a `basher-opfs:///` URL. The URL modifier intercepts
// every URL three.js touches before it reaches FileLoader's fetch.
//
// REF: THESIS §14, §33, §48; #82; B12 (glTF loader boundary).

import type { StorageCapability } from '../../core/storage/StorageCapability';

export const BASHER_OPFS_SCHEME = 'basher-opfs:///';

// Sentinel-URL → blob-URL. Module-level: a URL modifier is installed
// once on the GLTFLoader's manager; subsequent loads of different
// multi-file `.gltf` assets all share this map. Entries persist for
// the session — same OPFS state should resolve the same way.
const opfsUrlCache = new Map<string, string>();

/** Build a sentinel URL for an OPFS-relative path. */
export function opfsUrlFor(opfsPath: string): string {
  return BASHER_OPFS_SCHEME + opfsPath;
}

/** True iff the URL uses the sentinel scheme. */
export function isBasherOpfsUrl(url: string): boolean {
  return url.startsWith(BASHER_OPFS_SCHEME);
}

/**
 * Sync lookup for the LoadingManager URL modifier. Returns the cached
 * blob URL when `url` is a known sentinel; returns null when the URL
 * is unknown (caller should pass the URL through unchanged).
 */
export function resolveBasherOpfsUrl(url: string): string | null {
  return opfsUrlCache.get(url) ?? null;
}

interface GltfUriHolder {
  readonly uri?: string;
}

interface GltfJson {
  readonly buffers?: readonly GltfUriHolder[];
  readonly images?: readonly GltfUriHolder[];
}

function isExternalUri(uri: string | undefined): uri is string {
  if (typeof uri !== 'string' || uri === '') return false;
  if (uri.startsWith('data:')) return false;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(uri)) return false;
  return true;
}

/**
 * True iff `json` is a glTF document that references at least one
 * external sibling resource (relative `.bin` buffer or relative
 * texture file). Self-contained `.gltf` (data-URI buffers + embedded
 * or absent textures) returns false.
 */
export function gltfReferencesExternalSiblings(json: unknown): boolean {
  if (json === null || typeof json !== 'object') return false;
  const g = json as GltfJson;
  for (const b of g.buffers ?? []) {
    if (isExternalUri(b.uri)) return true;
  }
  for (const im of g.images ?? []) {
    if (isExternalUri(im.uri)) return true;
  }
  return false;
}

/** Best-effort MIME guess from a sibling URI. Falls back to octet-stream. */
function mimeFromUri(uri: string): string {
  const lower = uri.toLowerCase();
  if (lower.endsWith('.bin')) return 'application/octet-stream';
  if (lower.endsWith('.png')) return 'image/png';
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg';
  if (lower.endsWith('.webp')) return 'image/webp';
  if (lower.endsWith('.ktx2')) return 'image/ktx2';
  if (lower.endsWith('.basis')) return 'image/basis';
  return 'application/octet-stream';
}

/** Directory part of an OPFS path (no trailing slash). Empty when path is root-level. */
function dirOf(path: string): string {
  const i = path.lastIndexOf('/');
  return i < 0 ? '' : path.slice(0, i);
}

function joinOpfs(dir: string, rel: string): string {
  return dir === '' ? rel : `${dir}/${rel}`;
}

/**
 * OPFS path of a glTF sibling resource referenced by a relative URI,
 * resolved against the main `.gltf`/`.glb`'s directory. Shared with the
 * #90 importer's `resolveBuffer` so the renderer (sentinel-URL) path and
 * the importer (byte-level) path agree on where siblings live.
 * glTF URIs are percent-encoded (spec §3.9.3.1) → decoded here.
 */
export function opfsSiblingPath(mainPath: string, relUri: string): string {
  return joinOpfs(dirOf(mainPath), decodeURIComponent(relUri));
}

function uniqueUris(json: GltfJson): string[] {
  const out = new Set<string>();
  for (const b of json.buffers ?? []) {
    if (isExternalUri(b.uri)) out.add(b.uri);
  }
  for (const im of json.images ?? []) {
    if (isExternalUri(im.uri)) out.add(im.uri);
  }
  return [...out];
}

/**
 * Pre-resolve a multi-file `.gltf` and all its siblings into the
 * sentinel-URL cache. Returns the sentinel URL three.js should load
 * as the main asset. The caller is responsible for calling this
 * before `useGLTF(sentinelUrl, …)` runs.
 *
 * Asynchronous because OPFS reads are async; the URL modifier itself
 * stays sync (Map lookup) because three.js's loader pipeline requires
 * a sync resolveURL.
 *
 * Throws if a referenced sibling is missing from OPFS — surfacing the
 * failure loudly at import time beats a silent partial load.
 */
export async function loadMultiFileGltf(
  storage: StorageCapability,
  mainPath: string,
  jsonBytes: Uint8Array,
): Promise<string> {
  const text = new TextDecoder().decode(jsonBytes);
  // Parse here even if the caller already parsed: cheap relative to OPFS
  // IO, and keeps this module's contract a single self-contained step.
  const json = JSON.parse(text) as GltfJson;
  const baseDir = dirOf(mainPath);

  const mainUrl = opfsUrlFor(mainPath);
  if (!opfsUrlCache.has(mainUrl)) {
    const buf = new ArrayBuffer(jsonBytes.byteLength);
    new Uint8Array(buf).set(jsonBytes);
    opfsUrlCache.set(mainUrl, URL.createObjectURL(new Blob([buf], { type: 'model/gltf+json' })));
  }

  for (const uri of uniqueUris(json)) {
    // glTF URIs are percent-encoded (spec §3.9.3.1); the on-disk OPFS
    // name is the DECODED form (the importer writes files under the
    // entry's actual name, and `opfsSiblingPath:128` already decodes on
    // the buffer-resolve side). Both halves of the sibling-resolution
    // boundary must agree on the decoded path — otherwise a fixture
    // with a space-or-unicode filename imports but never renders. This
    // is the percent-encoding divergence flagged in RESEARCH §2 for #82.
    const siblingPath = joinOpfs(baseDir, decodeURIComponent(uri));
    const siblingUrl = opfsUrlFor(siblingPath);
    if (opfsUrlCache.has(siblingUrl)) continue;
    const bytes = await storage.read(siblingPath);
    const buf = new ArrayBuffer(bytes.byteLength);
    new Uint8Array(buf).set(bytes);
    opfsUrlCache.set(siblingUrl, URL.createObjectURL(new Blob([buf], { type: mimeFromUri(uri) })));
  }

  return mainUrl;
}

/** Test-only — drop the cache and revoke every blob URL it issued. */
export function __resetOpfsGltfResolverCacheForTests(): void {
  for (const url of opfsUrlCache.values()) URL.revokeObjectURL(url);
  opfsUrlCache.clear();
}
