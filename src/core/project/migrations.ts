// Migration runner. v0.5 ships with no migrations registered — the runner
// itself is mandatory before the first schema bump (THESIS.md §52, V4).
//
// Two ladders run on load:
//   1. Project-format migrations: formatVersion N → N+1 over the whole file.
//   2. Per-node migrations: each node's recorded version → its registered
//      definition version, using `def.migrations[v]`.
//
// A loaded project that's already current passes through unchanged.
//
// REF: THESIS.md §52, krama K5 step 7.

import { getNodeType } from '../dag/registry';
import type { Node } from '../dag/types';
import { PROJECT_FORMAT_VERSION, type Project } from './schema';

type FormatMigration = (raw: unknown) => unknown;

/** Ladder of project-format migrations keyed by source version. */
const formatMigrations: Record<number, FormatMigration> = {
  // v1 → v2 (#199): retire the AnimationLayer wrapper graph-wide.
  1: migrateAnimationLayers,
};

// ── v1 → v2: AnimationLayer retirement (#199) ──────────────────────────────
// Reverses what `addLayer` wired (addLayer.ts:88-123). For each AnimationLayer
// L wrapping target T with channels C wired into L.animation:
//   1. re-target each channel C to T (params.target = T) and FOLD L's gate/blend
//      onto it (mute/weight — the only behaviour the wrapper carried, V57 §11),
//   2. re-point every consumer edge L.out → T.out (the splice, reversed),
//   3. delete L. Its channels are now FREE-FLOATING direct channels.
// Runs on RAW JSON BEFORE ProjectSchema.parse, so the now-removed AnimationLayer
// node type is never looked up by the registry. solo / boneMask were inert
// (never filtered channels — AnimationLayer.ts:88-92) → dropped, but LOGGED when
// non-default so the loss is never silent (V38). REF: docs/UNIFICATION-DESIGN.md §4.

interface RawRef {
  node?: string;
  socket?: string;
}
interface RawNode {
  id?: string;
  type?: string;
  params?: Record<string, unknown>;
  inputs?: Record<string, RawRef | RawRef[]>;
}

function asRefs(binding: RawRef | RawRef[] | undefined): RawRef[] {
  if (Array.isArray(binding)) return binding;
  return binding ? [binding] : [];
}

/** Replace any ref to `fromNode` with `toNode` (preserving the socket) in a
 *  binding, keeping the binding's single-vs-list shape. */
function remapBinding(
  binding: RawRef | RawRef[] | undefined,
  fromNode: string,
  toNode: string,
): RawRef | RawRef[] | undefined {
  if (Array.isArray(binding)) {
    return binding.map((r) => (r.node === fromNode ? { ...r, node: toNode } : r));
  }
  if (binding && binding.node === fromNode) return { ...binding, node: toNode };
  return binding;
}

export function migrateAnimationLayers(raw: unknown): unknown {
  const proj = raw as {
    formatVersion?: number;
    state?: { nodes?: Record<string, RawNode>; outputs?: Record<string, RawRef> };
  };
  const nodes = proj.state?.nodes;
  if (!nodes) return { ...proj, formatVersion: 2 };

  const layers = Object.values(nodes).filter((n) => n?.type === 'AnimationLayer');
  for (const layer of layers) {
    const layerId = layer.id;
    if (!layerId) continue;
    const targetId = asRefs(layer.inputs?.target)[0]?.node;
    const channelRefs = asRefs(layer.inputs?.animation);
    const lw = typeof layer.params?.weight === 'number' ? (layer.params.weight as number) : 1;
    const muted = layer.params?.mute === true;

    // Surface the dropped inert semantics (no silent loss, V38).
    const boneMask = layer.params?.boneMask;
    if (layer.params?.solo === true || (Array.isArray(boneMask) && boneMask.length > 0)) {
      console.warn(
        `[migrateAnimationLayers] layer "${layerId}" had solo/boneMask set; these were ` +
          `never wired (inert) and are dropped (#199). Reintroduce as per-channel solo / a ` +
          `ChannelGroup if a real need appears.`,
      );
    }

    // 1 — re-target each channel to the wrapped node + fold gate/blend on.
    for (const cref of channelRefs) {
      const ch = cref.node ? nodes[cref.node] : undefined;
      if (!ch) continue;
      ch.params = ch.params ?? {};
      if (targetId) ch.params.target = targetId;
      if (lw !== 1) ch.params.weight = lw;
      if (muted) ch.params.mute = true;
    }

    // 2 — re-point every consumer edge L.out → T.out (reverse the splice).
    if (targetId) {
      for (const n of Object.values(nodes)) {
        if (!n.inputs) continue;
        for (const socket of Object.keys(n.inputs)) {
          n.inputs[socket] = remapBinding(n.inputs[socket], layerId, targetId)!;
        }
      }
      const outputs = proj.state?.outputs;
      if (outputs) {
        for (const k of Object.keys(outputs)) {
          if (outputs[k]?.node === layerId) outputs[k] = { ...outputs[k], node: targetId };
        }
      }
    }

    // 3 — delete the layer node; its channels are now free-floating.
    delete nodes[layerId];
  }

  return { ...proj, formatVersion: 2 };
}

export function registerFormatMigration(fromVersion: number, fn: FormatMigration): void {
  if (formatMigrations[fromVersion]) {
    throw new Error(`Format migration already registered from v${fromVersion}`);
  }
  formatMigrations[fromVersion] = fn;
}

export function migrateProjectFormat(raw: unknown): unknown {
  let cur = raw;
  let safety = 32;
  while (safety-- > 0) {
    const obj = cur as { formatVersion?: number };
    if (typeof obj?.formatVersion !== 'number') break;
    if (obj.formatVersion >= PROJECT_FORMAT_VERSION) break;
    const step = formatMigrations[obj.formatVersion];
    if (!step) {
      throw new Error(
        `No migration registered for project formatVersion ${obj.formatVersion} → ${obj.formatVersion + 1}`,
      );
    }
    cur = step(cur);
  }
  return cur;
}

/**
 * Walk every node in a (post-format-migration) project and step each one to
 * its registered version using its node-type's migration ladder.
 */
export function migrateNodes(project: Project): Project {
  const migratedNodes: Record<string, Node> = {};
  for (const [id, node] of Object.entries(project.state.nodes)) {
    migratedNodes[id] = migrateOneNode(node);
  }
  return {
    ...project,
    state: { ...project.state, nodes: migratedNodes },
    nodeVersions: snapshotCurrentNodeVersions(migratedNodes),
  };
}

function migrateOneNode(node: Node): Node {
  const def = getNodeType(node.type);
  if (!def) {
    throw new Error(
      `Cannot migrate node ${node.id}: unknown type "${node.type}". Register the type before loading.`,
    );
  }
  let working = node;
  let safety = 64;
  while (safety-- > 0) {
    if (working.version >= def.version) break;
    const step = def.migrations?.[working.version];
    if (!step) {
      throw new Error(`No migration for ${def.type} v${working.version} → v${working.version + 1}`);
    }
    working = {
      ...working,
      version: working.version + 1,
      params: step(working.params),
    };
  }
  return working;
}

function snapshotCurrentNodeVersions(nodes: Record<string, Node>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const node of Object.values(nodes)) {
    out[node.type] = Math.max(out[node.type] ?? 0, node.version);
  }
  return out;
}
