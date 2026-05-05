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
  // empty: formatVersion=1 is current
};

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
      throw new Error(
        `No migration for ${def.type} v${working.version} → v${working.version + 1}`,
      );
    }
    working = {
      ...working,
      version: working.version + 1,
      params: step(working.params),
    };
  }
  return working;
}

function snapshotCurrentNodeVersions(
  nodes: Record<string, Node>,
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const node of Object.values(nodes)) {
    out[node.type] = Math.max(out[node.type] ?? 0, node.version);
  }
  return out;
}
