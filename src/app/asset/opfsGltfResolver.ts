// Multi-file `.gltf` sibling paths for stored assets (#82).
//
// A `.gltf` file is JSON that may reference sibling resources (`.bin` buffers,
// `.png`/`.jpg` textures) by relative URI. This module answers two questions about
// them: where a sibling lives in storage (`opfsSiblingPath`), and which siblings a
// picked file set is missing (`missingGltfSiblings`), so an incomplete pick fails at
// import with an actionable message.
//
// Until #1053 it also carried a sentinel URL scheme that let three.js's GLTFLoader
// fetch siblings for the clone renderer. The import reads sibling bytes directly now.
//
// REF: THESIS §14, §33, §48; #82.

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

/** Directory part of an OPFS path (no trailing slash). Empty when path is root-level. */
function dirOf(path: string): string {
  const i = path.lastIndexOf('/');
  return i < 0 ? '' : path.slice(0, i);
}

function joinOpfs(dir: string, rel: string): string {
  return dir === '' ? rel : `${dir}/${rel}`;
}

/**
 * Normalize an OPFS path by resolving `..` and `.` segments. The OPFS
 * `FileSystemDirectoryHandle.getDirectoryHandle` API rejects literal `..`
 * names with `"Name is not allowed"`, so any `..` produced by joining a
 * relative URI must be collapsed BEFORE the path reaches storage.
 *
 * Surfaces in the nested-entry fixture case (Wave F Task 12): a glTF at
 * `user-imports/<asset>/gltf/scene.gltf` references `../buffers/scene.bin`;
 * naive join → `user-imports/<asset>/gltf/../buffers/scene.bin` → OPFS
 * read throws. Normalization → `user-imports/<asset>/buffers/scene.bin`.
 *
 * Throws when `..` escapes the path root (anti path-traversal — a sibling
 * URI must NOT be able to reach outside its OPFS subtree).
 */
function normalizeOpfsPath(path: string): string {
  const out: string[] = [];
  for (const part of path.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') {
      if (out.length === 0) {
        throw new Error(`opfsSiblingPath: relative path escapes root: ${path}`);
      }
      out.pop();
      continue;
    }
    out.push(part);
  }
  return out.join('/');
}

/**
 * OPFS path of a glTF sibling resource referenced by a relative URI,
 * resolved against the main `.gltf`/`.glb`'s directory.
 * glTF URIs are percent-encoded (spec §3.9.3.1) → decoded here.
 * `..` segments (nested-entry exports — `gltf/scene.gltf` referencing
 * `../buffers/foo.bin`) are normalized so the resulting path is valid
 * for `FileSystemDirectoryHandle.getDirectoryHandle`.
 */
export function opfsSiblingPath(mainPath: string, relUri: string): string {
  return normalizeOpfsPath(joinOpfs(dirOf(mainPath), decodeURIComponent(relUri)));
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
 * Given a `.gltf` entry's JSON bytes, its relativePath within a picked file set,
 * and the relativePaths present in that set, return the external sibling URIs
 * (decoded, for display) that are MISSING. Empty ⇒ self-contained, or every
 * sibling is present. Sibling URIs are resolved against the entry's directory
 * with the SAME join+decode+normalize as `opfsSiblingPath` (so flat AND nested
 * exports match) — the picked-set check must agree with where the loader will
 * later look on the OPFS side.
 *
 * Used at import time to fail EARLY with an actionable message when a multi-file
 * `.gltf` is picked WITHOUT its `.bin`/textures (a plain file picker can't
 * capture siblings) — instead of writing a partial asset and dying mid-load on a
 * cryptic NotFoundError. A non-parseable .gltf returns [] (let the real loader
 * surface that error).
 */
export function missingGltfSiblings(
  jsonBytes: Uint8Array,
  entryRelativePath: string,
  presentRelativePaths: ReadonlySet<string>,
): string[] {
  let json: GltfJson;
  try {
    json = JSON.parse(new TextDecoder().decode(jsonBytes)) as GltfJson;
  } catch {
    return [];
  }
  const missing: string[] = [];
  for (const uri of uniqueUris(json)) {
    const sibling = opfsSiblingPath(entryRelativePath, uri);
    if (!presentRelativePaths.has(sibling)) missing.push(decodeURIComponent(uri));
  }
  return missing;
}

/**
 * A concise, actionable banner for a multi-file `.gltf` picked or dropped
 * WITHOUT its sibling resources. A 3D-ripper export (or any unpacked `.gltf`)
 * can reference dozens of textures / a `.bin` by relative URI; a browser hands
 * the app only the single file the user picked, never its siblings. Dumping
 * every long hashed filename is an unreadable wall that buries the one thing
 * the user must do — import the whole FOLDER. So: lead with the fix, show the
 * count, and give at most two example names.
 */
export function formatMissingSiblingsError(entryName: string, missing: readonly string[]): string {
  const n = missing.length;
  const sample = missing.slice(0, 2).map((m) => m.split('/').pop() ?? m);
  const eg = n <= 2 ? sample.join(', ') : `${sample.join(', ')}, +${n - 2} more`;
  const files = n === 1 ? 'file' : 'files';
  return `import failed: "${entryName}" is a multi-file glTF — it needs ${n} sibling ${files} (e.g. ${eg}) that a single-file pick can't include. Import the whole FOLDER instead: drag the folder onto Basher, or use File ▸ Import Folder….`;
}
