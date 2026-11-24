// #1715 — one ComfyUI workflow node whose sockets come from its workflow file.
//
// Done when: two different workflow files on two copies of the node produce two different socket
// sets (asserted here on the node instances, through the same accessor connect and the Nodes view
// use), and a socket is never built from anything but the file's Basher markers
// (`workflowSockets.test.ts` holds the look-alike gate). Plus:
//   - the sockets are typed: still image / frames inputs take a still / frames, a number input a
//     Number, a text input a String or a Prompt; every output an Image of its declared extent;
//   - changing the file changes the sockets, and a wire on a socket that went is kept, read as
//     unconnected, and back in use when a file with that socket returns;
//   - a number input keyed (the I key's road, `controller:<nodeId>`) reaches what the frame
//     runner submits.

import { beforeEach, describe, expect, it } from 'vitest';
import { StubComfyUICapability, type ComfyInputs } from '../core/comfy';
import type { ComfyApiJson } from '../core/comfy/comfyGraph';
import stillEdit from '../core/comfy/fixtures/workflow-still-edit.json';
import video from '../core/comfy/fixtures/workflow-video.json';
import lookalikes from '../core/comfy/fixtures/workflow-lookalikes.json';
import {
  __resetRegistryForTests,
  applyOp,
  emptyDagState,
  evaluate,
  requireNodeType,
  type DagState,
  type Op,
} from '../core/dag';
import { inputsOfNode, outputsOfNode } from '../core/dag/instanceSockets';
import { useDagStore } from '../core/dag/store';
import { MemoryStorage } from '../core/storage';
import { dispatchFirstKeyComposite } from '../app/animate/dispatchMutator';
import { controllerValueReader } from '../app/render/controllerValue';
import { compileWorkflowFrame } from '../render/compileWorkflowFrame';
import { runComfyUIWorkflow } from '../render/runComfyUIWorkflow';
import { registerAllNodes } from './registerAll';
import type { ImageValue } from './types';

const STILL = stillEdit as unknown as ComfyApiJson;
const VIDEO = video as unknown as ComfyApiJson;
const LOOKALIKES = lookalikes as unknown as ComfyApiJson;
const file = (apiJson: ComfyApiJson, name: string) => ({
  apiJson,
  meta: { name, importedAt: 'test', fps: 30, frames: 1 },
});

beforeEach(() => {
  __resetRegistryForTests();
  registerAllNodes();
});

const apply = (s: DagState, ops: Op[]) => ops.reduce((acc, op) => applyOp(acc, op).next, s);
const add = (id: string, nodeType: string, params: Record<string, unknown> = {}): Op => ({
  type: 'addNode',
  nodeId: id,
  nodeType,
  params,
});
const wire = (from: string, fs: string, to: string, ts: string): Op => ({
  type: 'connect',
  from: { node: from, socket: fs },
  to: { node: to, socket: ts },
});

/** Each socket as `name:type`, `(takes)` for an image, as connect sees them. */
function sockets(s: DagState, id: string) {
  const def = requireNodeType('ComfyUIWorkflow');
  const params = s.nodes[id].params;
  const typeOf = (t: string | readonly string[]) => (Array.isArray(t) ? t.join('|') : t);
  return {
    inputs: Object.entries(inputsOfNode(def, params)).map(
      ([k, d]) => `${k}:${typeOf(d.type)}${typeof d.takes === 'string' ? `(${d.takes})` : ''}`,
    ),
    outputs: Object.keys(outputsOfNode(def, params)),
  };
}

describe('#1715 — the ComfyUI workflow node’s sockets come from its file', () => {
  it('two copies holding two files have two different, typed socket sets', () => {
    const s = apply(emptyDagState(), [
      add('a', 'ComfyUIWorkflow', { graph: file(STILL, 'still edit') }),
      add('b', 'ComfyUIWorkflow', { graph: file(VIDEO, 'video') }),
    ]);
    expect(sockets(s, 'a')).toEqual({
      inputs: ['picture:Image(still)', 'prompt:String|Prompt', 'strength:Number', 'time:Time'],
      outputs: ['result'],
    });
    expect(sockets(s, 'b')).toEqual({
      inputs: ['footage:Image(frames)', 'seed:Number', 'style:String|Prompt', 'time:Time'],
      outputs: ['clip', 'poster'],
    });
  });

  it('a node with no file has only its time input, and no output', () => {
    const s = apply(emptyDagState(), [add('n', 'ComfyUIWorkflow')]);
    expect(sockets(s, 'n')).toEqual({ inputs: ['time:Time'], outputs: [] });
  });

  it('a file with no Basher output is collected whole: one still `out`, read off no node', () => {
    const s = apply(emptyDagState(), [
      add('v', 'ComfyUIWorkflow', { graph: file(LOOKALIKES, 'vanilla') }),
      add('m', 'ComfyUIWorkflow', { graph: file(STILL, 'still edit') }),
    ]);
    // The look-alikes give no input, and the whole workflow is one still output.
    expect(sockets(s, 'v')).toEqual({ inputs: ['time:Time'], outputs: ['out'] });
    expect((evaluate(s, 'v', { socket: 'out' }).value as ImageValue).extent).toEqual({
      kind: 'still',
    });
    // A file that declares an output has only its declared ones.
    expect(sockets(s, 'm').outputs).toEqual(['result']);
  });

  it('each output says what it makes: a still, or the node’s frame range', () => {
    const s = apply(emptyDagState(), [
      add('b', 'ComfyUIWorkflow', { graph: file(VIDEO, 'video'), frameStart: 5, frameEnd: 9 }),
    ]);
    const at = (socket: string) => (evaluate(s, 'b', { socket }).value as ImageValue).extent;
    expect(at('clip')).toEqual({ kind: 'frames', range: { start: 5, end: 9, fps: 30 } });
    expect(at('poster')).toEqual({ kind: 'still' });
  });

  it('changing the file changes the sockets; a wire that lost its socket is kept and ignored', () => {
    let s = apply(emptyDagState(), [
      add('v', 'Value', { value: 0.25 }),
      add('a', 'ComfyUIWorkflow', { graph: file(STILL, 'still edit') }),
      wire('v', 'out', 'a', 'strength'),
    ]);
    const hashWith = (st: DagState) =>
      (evaluate(st, 'a', { socket: 'result' }).value as ImageValue).sourceHash;
    const wired = hashWith(s);
    // Swap to the video file: no `strength` socket, no `result` output.
    s = apply(s, [{ type: 'setParam', nodeId: 'a', paramPath: 'graph', value: file(VIDEO, 'v') }]);
    expect(sockets(s, 'a').inputs).not.toContain('strength:Number');
    expect(s.nodes.a.inputs.strength).toEqual({ node: 'v', socket: 'out' });
    expect(() => apply(s, [wire('v', 'out', 'a', 'strength')])).toThrow(/has no input socket/);
    // Back to the still file: the kept wire is read again, so the picture is the wired one.
    s = apply(s, [
      { type: 'setParam', nodeId: 'a', paramPath: 'graph', value: file(STILL, 'still edit') },
    ]);
    expect(hashWith(s)).toBe(wired);
  });

  it('a keyed number input reaches what the frame runner submits', async () => {
    let s = apply(emptyDagState(), [
      add('time', 'TimeSource'),
      add('a', 'ComfyUIWorkflow', {
        graph: file(STILL, 'still edit'),
        frameStart: 0,
        frameEnd: 0,
        outputPath: 'renders/job/edit',
      }),
      wire('time', 'out', 'a', 'time'),
    ]);
    useDagStore.getState().hydrate(s);
    // `strength` is marker 4: key it as the I key does, at 0.9.
    const keyed = dispatchFirstKeyComposite({
      targetId: 'a',
      paramPath: 'controller:4',
      value: 0.9,
      seconds: 0,
    });
    expect(keyed.ok).toBe(true);
    s = useDagStore.getState().state;
    expect(controllerValueReader(s, 'a')('4', 0)).toBe(0.9);

    const storage = new MemoryStorage();
    const cap = new StubComfyUICapability();
    const sent: unknown[] = [];
    const submitBatch = cap.submitBatch.bind(cap);
    cap.submitBatch = async (wf, inputs: ComfyInputs, onEvent) => {
      sent.push(wf);
      return submitBatch(wf, inputs, onEvent);
    };
    await runComfyUIWorkflow('a', s, {
      capability: cap,
      storage,
      compileWorkflow: compileWorkflowFrame({ storage }),
      controllerValue: controllerValueReader(s, 'a'),
      onFrameComplete: () => {},
    });
    const submitted = sent[0] as ComfyApiJson;
    expect(submitted['4'].inputs.values_json).toBe('[0.9]');
    // Unkeyed text keeps the file's default.
    expect(submitted['3'].inputs.values_json).toBe('["a red door"]');
  });
});
