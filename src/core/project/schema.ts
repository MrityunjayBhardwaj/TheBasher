// Project file format. Versioned schema (V4): every saved project carries
// a `formatVersion` and `nodeVersions` so future schema bumps run through
// the migration ladder rather than crashing on load.
//
// V0.5 ships formatVersion=1 only. The first node-type version bump (P3+)
// triggers the first migration; the runner is wired and tested today.
//
// REF: THESIS.md §52, vyapti V4, krama K5.

import { z } from 'zod';
import { NodeSchema, NodeIdSchema, NodeRefSchema } from '../dag/types';

export const PROJECT_FORMAT_VERSION = 1;

export const ProjectSchema = z.object({
  formatVersion: z.literal(PROJECT_FORMAT_VERSION),
  id: z.string(),
  name: z.string(),
  createdAt: z.number(),
  updatedAt: z.number(),
  /** Per-node-type schema versions present in this file. Migration runner
   *  reads this on load and steps each node up to the current registered
   *  version. (THESIS.md §52.) */
  nodeVersions: z.record(z.string(), z.number().int().nonnegative()),
  /** The DAG itself — nodes keyed by id, plus the named output sockets. */
  state: z.object({
    nodes: z.record(NodeIdSchema, NodeSchema),
    outputs: z.record(z.string(), NodeRefSchema),
  }),
});

export type Project = z.infer<typeof ProjectSchema>;

export const PROJECT_FILENAME = 'project.json';
