// The params an agent is shown for a node (#1049).
//
// A stored polygon mesh keeps its whole geometry in a param, packed — megabytes for a real import.
// Handing that to a model buries the scene under bytes it cannot read and spends the context
// window on them. So every packed mesh, wherever it sits in a params tree, is shown as its element
// counts instead. Recognised by the packed shape rather than by node type, so a future producer
// that holds a mesh is summarised without being listed here.
//
// A template's definition (#1557) carries a whole copy of its body, every node's params
// included, and each of its instances already shows the agent that body as real nodes. So a
// definition is shown by its interface — type, label, inputs, output — and its body by the types
// of its nodes and where its output comes from.
//
// REF: src/app/meshGeometryData.ts (`isPackedMeshData`, `packedMeshSummary`); issue #1049;
//      src/core/dag/templates.ts (`TemplateDefinitionSchema`); issue #1557.

import { isPackedMeshData, packedMeshSummary } from '../app/meshGeometryData';
import { TEMPLATE_TYPE_PREFIX } from '../core/dag/templates';

interface DefinitionShape {
  type: string;
  label: unknown;
  inputs: unknown;
  output: unknown;
  body: { nodes: Record<string, { type?: unknown }>; out: unknown };
}

function isTemplateDefinition(v: unknown): v is DefinitionShape {
  if (v === null || typeof v !== 'object') return false;
  const d = v as Partial<DefinitionShape>;
  return (
    typeof d.type === 'string' &&
    d.type.startsWith(TEMPLATE_TYPE_PREFIX) &&
    d.body !== null &&
    typeof d.body === 'object' &&
    d.body.nodes !== null &&
    typeof d.body.nodes === 'object' &&
    d.body.out !== undefined
  );
}

function definitionSummary(d: DefinitionShape) {
  const nodeTypes: Record<string, number> = {};
  for (const node of Object.values(d.body.nodes)) {
    const type = String(node?.type);
    nodeTypes[type] = (nodeTypes[type] ?? 0) + 1;
  }
  return {
    type: d.type,
    label: d.label,
    inputs: d.inputs,
    output: d.output,
    body: { nodes: Object.keys(d.body.nodes).length, nodeTypes, out: d.body.out },
  };
}

export function paramsForAgent(params: unknown): unknown {
  if (isPackedMeshData(params)) return { storedMesh: packedMeshSummary(params) };
  if (isTemplateDefinition(params)) return definitionSummary(params);
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
