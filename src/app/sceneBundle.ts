// Scene bundle — the native single-file `.basher` scene format.
//
// A `.basher` file is the SHAREABLE, self-contained counterpart of a project:
// the DAG state PLUS every OPFS-backed asset the DAG references, embedded as
// base64 so the file opens identically on any machine. It is the symmetric
// importer side of exportDag.ts (which emits the legacy DAG-only `.basher.json`).
//
// THREE things live here, all transport/serialization concerns (no UI, no boot):
//   1. SceneBundleSchema — the on-disk envelope. Backward-compatible with the
//      legacy DAG-only payload (no `bundleVersion`, no `assets`), so an old
//      `.basher.json` still opens.
//   2. collectAssetRefs — the DEDUCTIVE walk that finds every OPFS asset the DAG
//      references. It mirrors the three authoritative ref→path mappings rather
//      than hardcoding per-node-type knowledge, so a NEW node type carrying any
//      of those ref shapes is captured automatically (the H77 substrate-leak
//      guard: a "portable" file that silently drops a referenced asset is the
//      failure this walk exists to prevent).
//   3. bundleToProject — normalize the envelope into a fresh Project, running the
//      EXACT load ladder loadProject uses (migrateProjectFormat → ProjectSchema
//      .parse → migrateNodes) so versioning/migration round-trips.
//
// The three OPFS-backed asset reference shapes (the complete span as of v0.6):
//   - GltfAsset.assetRef         → a string under `user-imports/<folder>/...`
//                                  (embed the WHOLE folder — multi-file glTF has
//                                  sibling .bin/textures next to the .gltf, #82).
//   - GeometryRef{kind:'baked'}  → baked-geometry/<hash>-<vertexCount>.bin
//                                  (Apply-Transform output, #151).
//   - BakedTextureRef            → baked-texture/<hash>.<ext> (BakedMesh material
//                                  maps AND primitive/material `maps.*`, #178).
//   - Scene env file assetRef    → env-hdri/<hash>.<ext> (imported .hdr/.exr for
//                                  scene-level HDRI/IBL, UX #9). The assetRef IS
//                                  the exact path — embedded verbatim.
// App-shipped `assets/...` (seedOpfs) are intentionally NOT embedded: they are
// re-seeded on every Basher instance, so they are always present on re-open.
//
// REF: exportDag.ts (the legacy DAG-only emitter this is symmetric to); io.ts
//      `loadProject` (the load ladder mirrored by bundleToProject); importRefs.ts
//      (nodesReferencingImport — the assetRef→user-imports convention); vyapti
//      V34 (one substrate), hetvabhasa H77 (substrate leak).

import { z } from 'zod';
import type { DagState } from '../core/dag/state';
import type { StorageCapability } from '../core/storage/StorageCapability';
import { PROJECT_FORMAT_VERSION, ProjectSchema, type Project } from '../core/project/schema';
import { migrateNodes, migrateProjectFormat } from '../core/project/migrations';
import { USER_IMPORTS_ROOT, listFilesDeep } from './asset/importCommon';
import { BAKED_GEOMETRY_ROOT, bakedGeometryPath } from './asset/bakedGeometryStore';
import { BAKED_TEXTURE_ROOT } from './asset/bakedTextureStore';
import { ENV_HDRI_ROOT } from './asset/envHdriStore';

/** The current `.basher` envelope (bundle) version — distinct from the project
 *  formatVersion. Bumped when the ENVELOPE shape changes (asset encoding etc),
 *  independent of the DAG schema. v1 = JSON + base64-embedded assets. */
export const SCENE_BUNDLE_VERSION = 1;

/** Native scene-file extension (decided over `.bash`, which collides with bash
 *  shell scripts: OS associations, editor highlighting, security scanners). */
export const SCENE_BUNDLE_EXTENSION = '.basher';

/**
 * The on-disk `.basher` envelope. `state` is kept LOOSE here (records of
 * unknown) on purpose — the envelope is the transport; the real semantic gate is
 * `ProjectSchema.parse` inside {@link bundleToProject}, which runs AFTER the
 * format-migration ladder (mirroring loadProject's order: migrate THEN validate).
 *
 * Backward-compat: `bundleVersion`, `exportedAt`, and `assets` are optional, so
 * the legacy DAG-only `.basher.json` exportDag.ts emits still parses (it has no
 * assets and no bundleVersion).
 */
export const SceneBundleSchema = z.object({
  formatVersion: z.number().int().positive(),
  bundleVersion: z.number().int().positive().optional(),
  id: z.string(),
  name: z.string(),
  exportedAt: z.number().optional(),
  state: z.object({
    nodes: z.record(z.string(), z.unknown()),
    outputs: z.record(z.string(), z.unknown()),
  }),
  /** OPFS path → base64 bytes. Absent/empty = a DAG-only (reference) bundle. */
  assets: z.record(z.string(), z.string()).optional(),
});

export type SceneBundle = z.infer<typeof SceneBundleSchema>;

// ---------------------------------------------------------------------------
// Asset reference collection (the deductive, leak-resistant walk)
// ---------------------------------------------------------------------------

export interface CollectedAssetRefs {
  /** `user-imports/<folder>` prefixes — each whole folder tree is embedded. */
  readonly gltfFolders: string[];
  /** Exact OPFS file paths for baked geometry. */
  readonly bakedGeometry: string[];
  /** Content hashes for baked textures (the `.<ext>` is resolved at I/O time
   *  by listing the baked-texture dir, since the ref carries only the hash). */
  readonly bakedTextureHashes: string[];
  /** Exact OPFS file paths for imported environment HDRIs (the Scene env
   *  `{kind:'file', assetRef}` — the assetRef IS the `env-hdri/<hash>.<ext>`
   *  path, so no dir listing is needed). UX #9. */
  readonly envHdri: string[];
}

/** Extract `user-imports/<folder>` from any path inside that import, else null. */
function userImportFolder(path: string): string | null {
  const parts = path.split('/');
  if (parts.length < 3 || parts[0] !== USER_IMPORTS_ROOT) return null;
  return `${parts[0]}/${parts[1]}`;
}

/** A baked GeometryDescriptor `{kind:'baked', hash, vertexCount}` (the OPFS
 *  geometry handle), wherever it appears nested in node params. */
function isBakedGeometryDescriptor(
  o: Record<string, unknown>,
): o is { kind: 'baked'; hash: string; vertexCount: number } {
  return o.kind === 'baked' && typeof o.hash === 'string' && typeof o.vertexCount === 'number';
}

/** A BakedTextureRef `{hash, colorSpace, flipY, ...}` (the OPFS texture handle),
 *  distinguished from a geometry descriptor by its colorSpace+flipY shape. */
function isBakedTextureRef(o: Record<string, unknown>): o is { hash: string } {
  return (
    typeof o.hash === 'string' &&
    typeof o.flipY === 'boolean' &&
    (o.colorSpace === 'srgb' || o.colorSpace === 'srgb-linear' || o.colorSpace === 'no-colorspace')
  );
}

/**
 * Walk every node's params and collect every OPFS-backed asset reference. This
 * is a SHAPE-driven recursive walk, not a per-node-type lookup: any value that
 * is a `user-imports/...` string, a baked GeometryDescriptor, or a
 * BakedTextureRef is captured wherever it nests. That is the H77 guard — a
 * future node type that carries one of these handles is embedded automatically,
 * so a "portable" `.basher` cannot silently drop a referenced asset.
 */
export function collectAssetRefs(state: DagState): CollectedAssetRefs {
  const gltfFolders = new Set<string>();
  const bakedGeometry = new Set<string>();
  const bakedTextureHashes = new Set<string>();
  const envHdri = new Set<string>();

  const visit = (val: unknown): void => {
    if (val == null) return;
    if (typeof val === 'string') {
      if (val.startsWith(`${USER_IMPORTS_ROOT}/`)) {
        const folder = userImportFolder(val);
        if (folder) gltfFolders.add(folder);
      } else if (val.startsWith(`${ENV_HDRI_ROOT}/`)) {
        // The Scene env file source's assetRef is the exact OPFS path.
        envHdri.add(val);
      }
      return;
    }
    if (Array.isArray(val)) {
      for (const item of val) visit(item);
      return;
    }
    if (typeof val === 'object') {
      const o = val as Record<string, unknown>;
      if (isBakedGeometryDescriptor(o)) {
        bakedGeometry.add(bakedGeometryPath(o.hash, o.vertexCount));
      }
      if (isBakedTextureRef(o)) {
        bakedTextureHashes.add(o.hash);
      }
      for (const v of Object.values(o)) visit(v);
    }
  };

  for (const node of Object.values(state.nodes)) visit(node.params);

  return {
    gltfFolders: [...gltfFolders],
    bakedGeometry: [...bakedGeometry],
    bakedTextureHashes: [...bakedTextureHashes],
    envHdri: [...envHdri],
  };
}

/**
 * Resolve the collected refs into a concrete list of OPFS file paths to embed.
 * glTF folders expand to every file beneath them (multi-file glTF); baked
 * geometry paths are already exact; baked texture hashes resolve to
 * `baked-texture/<hash>.<ext>` by listing the store once and matching the hash.
 */
export async function resolveAssetFiles(
  storage: StorageCapability,
  refs: CollectedAssetRefs,
): Promise<string[]> {
  const files = new Set<string>();

  for (const folder of refs.gltfFolders) {
    const rels = await listFilesDeep(storage, folder);
    for (const rel of rels) files.add(`${folder}/${rel}`);
  }

  for (const path of refs.bakedGeometry) files.add(path);

  // Imported env HDRIs are exact paths already (the assetRef IS the path).
  for (const path of refs.envHdri) files.add(path);

  if (refs.bakedTextureHashes.length > 0) {
    let texChildren: string[] = [];
    try {
      texChildren = await storage.list(BAKED_TEXTURE_ROOT);
    } catch {
      texChildren = [];
    }
    const byHash = new Map<string, string>();
    for (const child of texChildren) {
      const dot = child.indexOf('.');
      const hash = dot > 0 ? child.slice(0, dot) : child;
      byHash.set(hash, child);
    }
    for (const hash of refs.bakedTextureHashes) {
      const child = byHash.get(hash);
      if (child) files.add(`${BAKED_TEXTURE_ROOT}/${child}`);
    }
  }

  return [...files];
}

// ---------------------------------------------------------------------------
// base64 codec (binary ↔ JSON-safe string)
// ---------------------------------------------------------------------------

/** Encode raw bytes as base64. Chunked so a large asset doesn't blow the
 *  `String.fromCharCode(...spread)` call-stack limit. */
export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

/** Decode a base64 string back into raw bytes. */
export function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

// ---------------------------------------------------------------------------
// Envelope → Project (the load ladder, mirrored from io.ts loadProject)
// ---------------------------------------------------------------------------

/**
 * Normalize a parsed envelope into a fresh {@link Project} under `newId`,
 * running the SAME ladder loadProject uses: format-migrate the raw payload, then
 * validate against the current ProjectSchema, then step each node to its
 * registered version. The result is a brand-new project (fresh timestamps), so
 * opening a `.basher` is non-destructive (it never collides with the file's
 * original id).
 *
 * `now` is injected (not read from Date.now) so the transform stays pure and
 * deterministically testable.
 */
export function bundleToProject(bundle: SceneBundle, newId: string, now: number): Project {
  const normalized = {
    formatVersion: bundle.formatVersion,
    id: newId,
    name: bundle.name,
    createdAt: now,
    updatedAt: now,
    // Recomputed authoritatively by migrateNodes; an empty record is a valid
    // ProjectSchema seed (the real per-node versions live on each node).
    nodeVersions: {},
    state: bundle.state,
  };
  const migrated = migrateProjectFormat(normalized);
  const validated = ProjectSchema.parse(migrated);
  return migrateNodes(validated);
}

/** True iff this bundle carries embedded assets (a self-contained file). */
export function isSelfContained(bundle: SceneBundle): boolean {
  return !!bundle.assets && Object.keys(bundle.assets).length > 0;
}

export { PROJECT_FORMAT_VERSION, BAKED_GEOMETRY_ROOT, USER_IMPORTS_ROOT };
