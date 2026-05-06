// mesh.add — agent tool wrapping buildAddPrimitiveOps.
//
// Pure: returns Op[] (never dispatches). Supports adding any PrimitiveKind
// (meshes, lights, cameras, empties) into the scene.
//
// REF: THESIS.md §39-40, vyapti V7.

import { z } from 'zod';
import type { ToolDefinition, ToolContext } from './types';
import type { Op } from '../../core/dag/types';
import { buildAddPrimitiveOps } from '../../app/addPrimitives';

const kindSchema = z.enum([
  'Cube',
  'Sphere',
  'DirectionalLight',
  'PointLight',
  'SpotLight',
  'AreaLight',
  'AmbientLight',
  'PerspectiveCamera',
  'OrthographicCamera',
  'Group',
  'Transform',
]);

export const meshAddSchema = z.object({
  kind: kindSchema.describe('The type of primitive to add'),
  position: z
    .array(z.number())
    .length(3)
    .default([0, 0, 0])
    .describe('Spawn position as [x, y, z]'),
});

export type MeshAddArgs = z.infer<typeof meshAddSchema>;

export const meshAddTool: ToolDefinition<MeshAddArgs> = {
  name: 'mesh.add',
  description:
    'Add a primitive mesh, light, camera, or empty to the scene. ' +
    'Returns an Op[] that creates and optionally wires the node into the Scene aggregator. ' +
    'Supports: Cube, Sphere, DirectionalLight, PointLight, SpotLight, AreaLight, ' +
    'AmbientLight, PerspectiveCamera, OrthographicCamera, Group, Transform.',
  paramSchema: meshAddSchema,
  handler(args: MeshAddArgs, ctx: ToolContext): Op[] {
    const result = buildAddPrimitiveOps(
      ctx.dagState,
      args.kind,
      args.position as [number, number, number],
    );
    if (!result) {
      throw new Error('mesh.add: no Scene output found in the DAG');
    }
    return result.ops;
  },
};
