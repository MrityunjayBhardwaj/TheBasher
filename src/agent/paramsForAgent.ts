// The params an agent is shown for a node (#1049).
//
// A stored polygon mesh keeps its whole geometry in a param, packed — megabytes for a real import.
// Handing that to a model buries the scene under bytes it cannot read and spends the context
// window on them. So every packed mesh, wherever it sits in a params tree, is shown as its element
// counts instead. Recognised by the packed shape rather than by node type, so a future producer
// that holds a mesh is summarised without being listed here.
//
// REF: src/app/meshGeometryData.ts (`isPackedMeshData`, `packedMeshSummary`); issue #1049.

import { isPackedMeshData, packedMeshSummary } from '../app/meshGeometryData';

export function paramsForAgent(params: unknown): unknown {
  if (isPackedMeshData(params)) return { storedMesh: packedMeshSummary(params) };
  if (Array.isArray(params)) return params.map(paramsForAgent);
  if (params !== null && typeof params === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(params as Record<string, unknown>)) {
      out[key] = paramsForAgent(value);
    }
    return out;
  }
  return params;
}
