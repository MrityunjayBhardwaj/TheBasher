// #1557 — a project's template library: sub-networks saved as reusable node types.
//
// A template DEFINITION is a node type, as a Houdini digital asset's definition is
// (`hou.HDADefinition`: "A digital asset definition defines a node type"). It is stored once,
// in the project, beside the graph, and registered as a type while the project is open
// (`syncLibraryTypes`). An INSTANCE is an ordinary node of that type, with a real copy of the
// definition's body behind its `body` socket (#1557 D1): the evaluator, delete, duplicate, the
// inspector and the agent all read real nodes, and a node can only belong to one sub-network.
//
// What the type declares, worked out from the definition alone (`templateNodeType`):
// - one Number/Vector3/… socket per input, and the same name as a named input of its body, so a
//   body-input leaf reading `k` reads whatever is wired into the instance's `k` (#1548, #1357);
// - a `body` socket of the output's type, which owns the instance's copy of the body;
// - one output, `out`: the body's value. An instance keeps no history of its own, so a Solver
//   inside one reads its inputs on every frame (#1645).
//
// Type names are namespaced `template.<Name>`. No built-in type has a dot in its name, so a
// template never shadows one, including a built-in added after the project was saved.

import { z } from 'zod';
import { defineNodeType, isDefinedNodeType, undefineNodeType } from '../dag/registry';
import { NodeRefSchema, NodeSchema } from '../dag/types';
import type { InputDescriptor, NodeDefinition, SocketTypeName } from '../dag/types';

export const TEMPLATE_TYPE_PREFIX = 'template.';
const TEMPLATE_TYPE = /^template\.[A-Za-z][A-Za-z0-9_]*$/;
const INPUT_NAME = /^[A-Za-z][A-Za-z0-9_]*$/;
/** The socket an instance's copy of the body hangs from. Not a name an input can take. */
export const TEMPLATE_BODY_SOCKET = 'body';

export const TemplateDefinitionSchema = z
  .object({
    /** The node type an instance has: `template.<Name>`. */
    type: z.string().regex(TEMPLATE_TYPE, 'a template type is named template.<Name>'),
    /** What a person reads in the node list. */
    label: z.string().min(1),
    /** Each input is a socket on the instance and a named input of its body. */
    inputs: z.record(z.string().regex(INPUT_NAME), z.object({ type: z.string().min(1) })),
    /** The type of the instance's output, and of its body. */
    output: z.object({ type: z.string().min(1) }),
    /** The body, its nodes keyed by a name local to the definition (each node's `id` is its
     *  key), and the node and socket whose value is the instance's output. */
    body: z.object({
      nodes: z.record(z.string().min(1), NodeSchema),
      out: NodeRefSchema,
    }),
  })
  .superRefine((def, ctx) => {
    if (TEMPLATE_BODY_SOCKET in def.inputs)
      ctx.addIssue({
        code: 'custom',
        path: ['inputs', TEMPLATE_BODY_SOCKET],
        message: `"${TEMPLATE_BODY_SOCKET}" is the socket the body hangs from, so no input can take it`,
      });
    for (const [key, node] of Object.entries(def.body.nodes)) {
      if (node.id !== key)
        ctx.addIssue({
          code: 'custom',
          path: ['body', 'nodes', key, 'id'],
          message: `a body node's id is its key ("${key}"), not "${node.id}"`,
        });
    }
    if (!def.body.nodes[def.body.out.node])
      ctx.addIssue({
        code: 'custom',
        path: ['body', 'out', 'node'],
        message: `the body's output names "${def.body.out.node}", which is not a node of the body`,
      });
  });
export type TemplateDefinition = z.infer<typeof TemplateDefinitionSchema>;

export const LibrarySchema = z
  .object({ templates: z.array(TemplateDefinitionSchema) })
  .superRefine((lib, ctx) => {
    const seen = new Set<string>();
    lib.templates.forEach((t, i) => {
      if (seen.has(t.type))
        ctx.addIssue({
          code: 'custom',
          path: ['templates', i, 'type'],
          message: `two templates define "${t.type}"`,
        });
      seen.add(t.type);
    });
  });
export type Library = z.infer<typeof LibrarySchema>;

export const EMPTY_LIBRARY: Library = { templates: [] };

const single = (type: string): InputDescriptor =>
  ({ type: type as SocketTypeName, cardinality: 'single' }) as InputDescriptor;

/** The node type a definition declares. */
export function templateNodeType(def: TemplateDefinition): NodeDefinition {
  const inputs: Record<string, InputDescriptor> = {};
  const bodyInputs: Record<string, InputDescriptor> = {};
  for (const [name, input] of Object.entries(def.inputs)) {
    inputs[name] = single(input.type);
    bodyInputs[name] = single(input.type);
  }
  inputs[TEMPLATE_BODY_SOCKET] = { ...single(def.output.type), body: true };
  return {
    type: def.type,
    version: 1,
    pure: true,
    cost: 'cheap',
    paramSchema: z.object({}),
    inputs,
    outputs: { out: single(def.output.type) },
    bodyInputs,
    evaluate: (_params: unknown, values: Record<string, unknown>) => values[TEMPLATE_BODY_SOCKET],
  } as unknown as NodeDefinition;
}

/** What each template type was last defined from, so an unchanged definition is not defined
 *  again: a redefinition moves the registry's epoch, and every cache worked out from types
 *  starts over (#1647). */
const definedFrom = new Map<string, string>();

/**
 * Make the registered template types exactly `library`'s: define each new or changed one and
 * remove each the library no longer has. Called whenever the open project changes, before its
 * graph is hydrated, so every node of a template type has its type.
 */
export function syncLibraryTypes(library: Library): void {
  const wanted = new Map(library.templates.map((t) => [t.type, t]));
  for (const type of [...definedFrom.keys()]) {
    if (wanted.has(type)) continue;
    if (isDefinedNodeType(type)) undefineNodeType(type);
    definedFrom.delete(type);
  }
  for (const [type, def] of wanted) {
    const key = JSON.stringify(def);
    if (definedFrom.get(type) === key && isDefinedNodeType(type)) continue;
    defineNodeType(templateNodeType(def));
    definedFrom.set(type, key);
  }
}
