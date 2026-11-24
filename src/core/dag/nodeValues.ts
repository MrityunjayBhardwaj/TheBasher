// #1953 — the values a node shows on itself in the Nodes view (design board 8b: "values on nodes").
//
// A node in the Nodes tab carries its KEY values inline — a box's size, an array's count and
// offset, a light's kind and intensity — editable in place through the same rows the inspector
// draws. Which ones is read from what the node type already declares, never from a list kept here:
//
//   • the params the type homes in its PRIMARY inspector section (the first of
//     `inspectorSections`, the section the inspector opens expanded), in their declared order;
//   • except the transform: an Object's pose is the viewport's and the inspector's, and the
//     design's object end shows its sockets, not a position;
//   • only values a small row can hold: a number, an x/y/z, a switch, a choice from a list. A
//     material, a free text, a reference stay in the panel;
//   • not the operator's own on/off (`muted` / `mute`), which is the stack's control, not a value;
//   • at most MAX_NODE_VALUES of them: the rest are one N away, in the Nodes tab's own panel.
//
// The layout spaces nodes by these rows (`nodeValuesHeight`), so the view adds no layout of its own.
//
// REF: src/core/dag/types.ts (NodeDefinition.inspectorSections, .home); src/core/dag/layout.ts.

import { z } from 'zod';
import { getNodeType, paramFieldsOf } from './registry';
import type { DagState } from './state';
import type { NodeId } from './types';

/** The most values a node carries on itself. */
export const MAX_NODE_VALUES = 3;
/** The height of a one-line value row (a number, a switch, a choice), in node-view units. */
export const NODE_VALUE_ROW = 26;
/** The height of an x/y/z row: its label over three fields. */
export const NODE_VALUE_VEC_ROW = 46;

const OWN_SWITCHES = new Set(['muted', 'mute']);

function unwrap(schema: unknown): unknown {
  if (schema instanceof z.ZodDefault) return unwrap(schema.removeDefault());
  if (schema instanceof z.ZodOptional || schema instanceof z.ZodNullable)
    return unwrap(schema.unwrap());
  return schema;
}

const isVec3 = (v: unknown): v is readonly [number, number, number] =>
  Array.isArray(v) && v.length === 3 && v.every((x) => typeof x === 'number');

/** What kind of row a value takes on a node, or null when it takes none. */
export function nodeValueKind(
  fieldSchema: unknown,
  value: unknown,
): 'number' | 'vec3' | 'switch' | 'choice' | null {
  if (typeof value === 'number') return 'number';
  if (isVec3(value)) return 'vec3';
  if (typeof value === 'boolean') return 'switch';
  if (typeof value === 'string' && unwrap(fieldSchema) instanceof z.ZodEnum) return 'choice';
  return null;
}

/** The params `id` shows on itself in the Nodes view, in order (see the header). */
export function nodeValueParams(state: DagState, id: NodeId): readonly string[] {
  const node = state.nodes[id];
  const def = node ? getNodeType(node.type) : undefined;
  const primary = def?.inspectorSections?.[0];
  if (!node || !def?.home || !primary || primary === 'transform') return [];
  const fields = paramFieldsOf(def) ?? {};
  const params = (node.params ?? {}) as Record<string, unknown>;
  const out: string[] = [];
  for (const [key, section] of Object.entries(def.home)) {
    if (out.length >= MAX_NODE_VALUES) break;
    if (section !== primary || OWN_SWITCHES.has(key) || !(key in params)) continue;
    if (nodeValueKind(fields[key], params[key]) !== null) out.push(key);
  }
  return out;
}

/** The height `id`'s value rows add to its box in the Nodes view (0 for a node with none). */
export function nodeValuesHeight(state: DagState, id: NodeId): number {
  const params = (state.nodes[id]?.params ?? {}) as Record<string, unknown>;
  return nodeValueParams(state, id).reduce(
    (h, key) => h + (isVec3(params[key]) ? NODE_VALUE_VEC_ROW : NODE_VALUE_ROW),
    0,
  );
}
