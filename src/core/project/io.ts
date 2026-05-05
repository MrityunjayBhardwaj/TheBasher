// Project save/load — wraps a StorageCapability with format/migration logic.
//
// Save (K5 1-4):
//   1. Compose Project from current DagState + nodeVersions.
//   2. Validate against ProjectSchema.
//   3. Encode JSON; write through StorageCapability.write (which itself
//      read-back-verifies, K5 step 4).
//
// Load (K5 5-8):
//   1. Read bytes; decode JSON.
//   2. Run format migrations (no-op in v0.5 but the loop runs).
//   3. Validate against current ProjectSchema.
//   4. Run per-node migrations to current registered versions.
//   5. Caller hydrates the DAG store.
//
// REF: THESIS.md §52, krama K5.

import type { DagState } from '../dag/state';
import type { StorageCapability } from '../storage';
import { migrateNodes, migrateProjectFormat } from './migrations';
import {
  PROJECT_FILENAME,
  PROJECT_FORMAT_VERSION,
  ProjectSchema,
  type Project,
} from './schema';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export interface ComposeProjectArgs {
  id: string;
  name: string;
  state: DagState;
  createdAt?: number;
  updatedAt?: number;
}

export function composeProject(args: ComposeProjectArgs): Project {
  const nodeVersions: Record<string, number> = {};
  for (const node of Object.values(args.state.nodes)) {
    nodeVersions[node.type] = Math.max(nodeVersions[node.type] ?? 0, node.version);
  }
  const now = Date.now();
  return {
    formatVersion: PROJECT_FORMAT_VERSION,
    id: args.id,
    name: args.name,
    createdAt: args.createdAt ?? now,
    updatedAt: args.updatedAt ?? now,
    nodeVersions,
    state: {
      nodes: args.state.nodes,
      outputs: args.state.outputs,
    },
  };
}

export function projectPath(projectId: string): string {
  return `projects/${projectId}/${PROJECT_FILENAME}`;
}

export async function saveProject(
  storage: StorageCapability,
  project: Project,
): Promise<void> {
  const validated = ProjectSchema.parse(project);
  const json = JSON.stringify(validated, null, 2);
  await storage.write(projectPath(validated.id), encoder.encode(json));
}

export async function loadProject(
  storage: StorageCapability,
  projectId: string,
): Promise<Project> {
  const bytes = await storage.read(projectPath(projectId));
  const text = decoder.decode(bytes);
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    throw new Error(`loadProject: corrupt JSON in ${projectId}: ${(e as Error).message}`);
  }
  const migrated = migrateProjectFormat(raw);
  const project = ProjectSchema.parse(migrated);
  return migrateNodes(project);
}

export async function listProjects(storage: StorageCapability): Promise<string[]> {
  try {
    return await storage.list('projects');
  } catch {
    return [];
  }
}
