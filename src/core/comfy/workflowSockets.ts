// workflowSockets — #1715: the sockets of a ComfyUI workflow node, read off its workflow file.
//
// ONE pure function, `socketsOfWorkflow(apiJson)`, is the only place a workflow's sockets are
// derived. Every Basher input marker (`basher_controller`) becomes an input and every Basher
// output marker (`basher_export`) an output; nothing else in the file is looked at, so a
// LoadImage or a CLIPTextEncode never turns into a socket however input-like it looks. That is
// the boundary of the two-node contract (docs/COMFYUI-BASHER-NODES.md): the workflow's author
// declares what Basher may drive and read, and Basher never infers it from foreign nodes.
//
// Types, from the marker's own `kind`:
//   controller float | int → number (keyable, through `controller:<nodeId>`)
//   controller string      → text   (keyable, the same way)
//   controller image       → still image   (an Image socket that takes a still)
//   controller video       → frames        (an Image socket that takes frames)
//   controller bool        → no socket: a constant switch, set on the node, never keyed
//   export image (default) → still image;  export video → frames
// A controller with `feedback_of` naming one of the file's exports is FED: Basher's runner
// fills it with that export's picture from the frame before, so it is listed apart and is
// not a socket anyone can wire.
//
// The result is cached by the apiJson object, which the node stores and replaces whole when
// the file changes, so every reader (the node definition, the Nodes view, the agent) shares
// one derivation per file.

import { scanBasherControllers, type BasherControllerDecl } from './basherControllers';
import { scanBasherExports } from './basherExports';
import type { ComfyApiJson } from './comfyGraph';

/** What a workflow socket carries, in the words the director sees. */
export type WorkflowSocketType = 'still' | 'frames' | 'number' | 'text';

/** One input socket, from one `basher_controller`. `socket` is its id on the node (the
 *  marker's name, made unique); `nodeId` is the marker's id in the file. */
export interface WorkflowInput {
  readonly socket: string;
  readonly nodeId: string;
  readonly type: WorkflowSocketType;
  /** Number and text inputs are keyable; their resting value is the marker's default. */
  readonly defaultValue: number | string | null;
}

/** One output socket, from one `basher_export`. */
export interface WorkflowOutput {
  readonly socket: string;
  readonly nodeId: string;
  readonly type: 'still' | 'frames';
}

/** An image input the runner feeds with one of the workflow's own outputs, one frame back. */
export interface WorkflowFedInput {
  readonly nodeId: string;
  readonly name: string;
  /** The output socket it is fed from. */
  readonly from: string;
  /** What the node shows for it. */
  readonly label: string;
}

export interface WorkflowSockets {
  readonly inputs: readonly WorkflowInput[];
  readonly outputs: readonly WorkflowOutput[];
  readonly fed: readonly WorkflowFedInput[];
  /** What in the file could not become a socket as written, in plain words. */
  readonly problems: readonly string[];
}

/** Socket ids the node declares itself, which a marker's name must not take. */
const RESERVED = new Set(['time']);

const EMPTY: WorkflowSockets = { inputs: [], outputs: [], fed: [], problems: [] };
const cache = new WeakMap<object, WorkflowSockets>();

function inputType(decl: BasherControllerDecl): WorkflowSocketType | null {
  switch (decl.kind) {
    case 'float':
    case 'int':
      return 'number';
    case 'string':
      return 'text';
    case 'image':
      return 'still';
    case 'video':
      return 'frames';
    case 'bool':
      return null;
  }
}

/** The socket id for `name`: the name itself, or the name with the marker's id when it is
 *  taken already (two markers named alike, or a name the node uses). */
function uniqueSocket(name: string, nodeId: string, taken: Set<string>, problems: string[]) {
  if (!taken.has(name) && !RESERVED.has(name)) {
    taken.add(name);
    return name;
  }
  const id = `${name} #${nodeId}`;
  problems.push(`Two markers are called "${name}"; the one in node ${nodeId} shows as "${id}".`);
  taken.add(id);
  return id;
}

/**
 * The sockets of a workflow node whose file is `apiJson`: one input per Basher input marker,
 * one output per Basher output marker, in the file's node order. A null or missing file has
 * none. Pure, and the same object for the same file.
 */
export function socketsOfWorkflow(apiJson: ComfyApiJson | null | undefined): WorkflowSockets {
  if (!apiJson || typeof apiJson !== 'object') return EMPTY;
  const known = cache.get(apiJson);
  if (known) return known;

  const problems: string[] = [];
  const outTaken = new Set<string>();
  const outputs: WorkflowOutput[] = scanBasherExports(apiJson).map((d) => ({
    socket: uniqueSocket(d.name, d.nodeId, outTaken, problems),
    nodeId: d.nodeId,
    type: d.kind === 'video' ? 'frames' : 'still',
  }));
  const outputNames = new Set(outputs.map((o) => o.socket));

  const inTaken = new Set<string>();
  const inputs: WorkflowInput[] = [];
  const fed: WorkflowFedInput[] = [];
  for (const decl of scanBasherControllers(apiJson)) {
    if (decl.feedbackOf !== undefined) {
      if (decl.kind !== 'image') {
        problems.push(
          `"${decl.name}" asks to be fed "${decl.feedbackOf}", but only a still image input can be.`,
        );
      } else if (!outputNames.has(decl.feedbackOf)) {
        problems.push(`"${decl.name}" is fed "${decl.feedbackOf}", which is not an output here.`);
      } else {
        fed.push({
          nodeId: decl.nodeId,
          name: decl.name,
          from: decl.feedbackOf,
          label: `previous frame of ${decl.feedbackOf}`,
        });
      }
      continue;
    }
    const type = inputType(decl);
    if (type === null) continue;
    inputs.push({
      socket: uniqueSocket(decl.name, decl.nodeId, inTaken, problems),
      nodeId: decl.nodeId,
      type,
      defaultValue:
        type === 'number' || type === 'text' ? (decl.defaultValue as number | string) : null,
    });
  }

  const result: WorkflowSockets = { inputs, outputs, fed, problems };
  cache.set(apiJson, result);
  return result;
}

/** How a socket type reads on the node. */
export function workflowSocketLabel(type: WorkflowSocketType): string {
  switch (type) {
    case 'still':
      return 'still image';
    case 'frames':
      return 'frames';
    case 'number':
      return 'number';
    case 'text':
      return 'text';
  }
}
