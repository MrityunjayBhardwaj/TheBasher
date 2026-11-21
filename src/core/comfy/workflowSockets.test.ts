// #1715 — done when: two different workflow files on two copies of the node produce two
// different socket sets, and a test reds if a socket is built from anything other than the
// file's Basher nodes.

import { describe, expect, it } from 'vitest';
import type { ComfyApiJson } from './comfyGraph';
import { socketsOfWorkflow } from './workflowSockets';
import stillEdit from './fixtures/workflow-still-edit.json';
import video from './fixtures/workflow-video.json';
import lookalikes from './fixtures/workflow-lookalikes.json';

const STILL = stillEdit as unknown as ComfyApiJson;
const VIDEO = video as unknown as ComfyApiJson;
const LOOKALIKES = lookalikes as unknown as ComfyApiJson;

const shape = (apiJson: ComfyApiJson) => {
  const s = socketsOfWorkflow(apiJson);
  return {
    inputs: s.inputs.map((i) => `${i.socket}:${i.type}`),
    outputs: s.outputs.map((o) => `${o.socket}:${o.type}`),
    fed: s.fed.map((f) => `${f.name}<-${f.from}`),
  };
};

describe('socketsOfWorkflow (#1715)', () => {
  it('two workflow files give two different socket sets, each from its own markers', () => {
    expect(shape(STILL)).toEqual({
      inputs: ['picture:still', 'prompt:text', 'strength:number'],
      outputs: ['result:still'],
      fed: [],
    });
    expect(shape(VIDEO)).toEqual({
      inputs: ['footage:frames', 'seed:number', 'style:text'],
      outputs: ['clip:frames', 'poster:still'],
      fed: ['previous<-clip'],
    });
  });

  it('builds no socket from a node that is not a Basher marker, however input-like', () => {
    // LoadImage titled "Basher input", a CLIPTextEncode prompt, a PrimitiveNode carrying a
    // name and a kind, a SaveImage prefixed basher_export, a misspelt class, a LoadVideo with a
    // name, a PreviewImage with a name and a kind: none of them is a marker.
    expect(socketsOfWorkflow(LOOKALIKES)).toEqual({
      inputs: [],
      outputs: [],
      fed: [],
      problems: [],
    });
  });

  it('every socket names a marker node of the file, and every marker is accounted for', () => {
    for (const wf of [STILL, VIDEO]) {
      const s = socketsOfWorkflow(wf);
      const ids = [...s.inputs, ...s.outputs, ...s.fed].map((x) => x.nodeId).sort();
      const markers = Object.entries(wf)
        .filter(([, n]) => n.class_type === 'basher_controller' || n.class_type === 'basher_export')
        .map(([id]) => id)
        .sort();
      expect(ids).toEqual(markers);
    }
  });

  it('number and text inputs carry the marker default; image inputs none', () => {
    const s = socketsOfWorkflow(STILL);
    expect(s.inputs.map((i) => i.defaultValue)).toEqual([null, 'a red door', 0.6]);
  });

  it('is the same result for the same file, and a new file gives a new result', () => {
    expect(socketsOfWorkflow(STILL)).toBe(socketsOfWorkflow(STILL));
    expect(socketsOfWorkflow(structuredClone(STILL))).toEqual(socketsOfWorkflow(STILL));
    expect(socketsOfWorkflow(null).inputs).toEqual([]);
  });

  it('a feedback that names no output, or a non-image one, is a problem and not a socket', () => {
    const s = socketsOfWorkflow({
      '1': {
        class_type: 'basher_controller',
        inputs: { name: 'prev', kind: 'image', feedback_of: 'nope' },
      },
      '2': {
        class_type: 'basher_controller',
        inputs: { name: 'n', kind: 'float', feedback_of: 'out' },
      },
      '3': { class_type: 'basher_export', inputs: { name: 'out', images: ['9', 0] } },
    });
    expect(s.inputs).toEqual([]);
    expect(s.fed).toEqual([]);
    expect(s.problems).toHaveLength(2);
  });

  it('two markers with one name both get a socket, the second named with its node', () => {
    const s = socketsOfWorkflow({
      '1': { class_type: 'basher_controller', inputs: { name: 'a', kind: 'float' } },
      '2': { class_type: 'basher_controller', inputs: { name: 'a', kind: 'string' } },
      '3': { class_type: 'basher_controller', inputs: { name: 'time', kind: 'float' } },
    });
    expect(s.inputs.map((i) => i.socket)).toEqual(['a', 'a #2', 'time #3']);
    expect(s.problems).toHaveLength(2);
  });

  it('a bool controller is a switch on the node, not a socket', () => {
    const s = socketsOfWorkflow({
      '1': { class_type: 'basher_controller', inputs: { name: 'on', kind: 'bool' } },
    });
    expect(s.inputs).toEqual([]);
  });
});
