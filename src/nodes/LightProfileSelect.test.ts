// LightProfileSelect — the profile switch (epic #201, slice #208 increment 2).
// Verifies it picks the live rig by name (the ClipSelect pattern) and surfaces
// null-on-miss so a gone profile is visible, not silently the first rig.

import { beforeEach, describe, expect, it } from 'vitest';
import { __resetRegistryForTests, applyOp, emptyDagState } from '../core/dag';
import type { DagState } from '../core/dag/state';
import type { EvalCtx, Op } from '../core/dag/types';
import {
  LightProfileSelectNode,
  LightProfileSelectParams,
  profileOptions,
  wiredProfileRigs,
} from './LightProfileSelect';
import { optionsOf, placeholderOf, widgetOf } from './paramWidget';
import { registerAllNodes } from './registerAll';
import type { LightRigValue } from './types';

function rig(name: string): LightRigValue {
  return { kind: 'LightRig', name, center: [0, 0, 0], radius: 6, lights: [] };
}

// `evaluate` takes the frame context positionally. These rows passed without it only because
// vitest checks no types and typecheck compiles no test file (#472); the select ignores time.
const CTX: EvalCtx = { time: { frame: 0, seconds: 0, normalized: 0 } };

describe('LightProfileSelect node (#208)', () => {
  const rigs = [rig('Key setup'), rig('Rim setup')];

  it('picks the rig whose name matches selectedProfile', () => {
    const params = LightProfileSelectParams.parse({ selectedProfile: 'Rim setup' });
    const value = LightProfileSelectNode.evaluate(params, { rigs }, CTX);
    expect(value?.name).toBe('Rim setup');
  });

  it('returns null when no rig name matches (a gone profile is visible, not the first)', () => {
    const params = LightProfileSelectParams.parse({ selectedProfile: 'Deleted' });
    expect(LightProfileSelectNode.evaluate(params, { rigs }, CTX)).toBeNull();
  });

  it('returns null for the empty default (no profile selected yet)', () => {
    const params = LightProfileSelectParams.parse({});
    expect(LightProfileSelectNode.evaluate(params, { rigs }, CTX)).toBeNull();
  });

  it('tolerates a single (non-array) rig binding', () => {
    const params = LightProfileSelectParams.parse({ selectedProfile: 'Key setup' });
    const value = LightProfileSelectNode.evaluate(params, { rigs: rig('Key setup') }, CTX);
    expect(value?.name).toBe('Key setup');
  });
});

describe('the profile picker offers what the select can choose (#1064)', () => {
  beforeEach(() => {
    __resetRegistryForTests();
    registerAllNodes();
  });

  /** A select wired to `wired` rigs (in order), plus `loose` rigs in the graph but not wired. */
  function graph(wired: readonly string[], loose: readonly string[] = []): DagState {
    const ops: Op[] = [
      { type: 'addNode', nodeId: 'sel', nodeType: 'LightProfileSelect', params: {} },
    ];
    wired.forEach((name, i) => {
      ops.push(
        { type: 'addNode', nodeId: `rig_${i}`, nodeType: 'LightRig', params: { name } },
        {
          type: 'connect',
          from: { node: `rig_${i}`, socket: 'out' },
          to: { node: 'sel', socket: 'rigs' },
        },
      );
    });
    loose.forEach((name, i) => {
      ops.push({ type: 'addNode', nodeId: `loose_${i}`, nodeType: 'LightRig', params: { name } });
    });
    let s = emptyDagState();
    for (const op of ops) s = applyOp(s, op).next;
    return s;
  }

  it('the param declares the options control, its provider, and its word for none', () => {
    const field = LightProfileSelectParams.shape.selectedProfile;
    expect({
      widget: widgetOf(field),
      provider: optionsOf(field) === profileOptions,
      none: placeholderOf(field),
    }).toEqual({ widget: 'options', provider: true, none: 'no profile' });
  });

  it('offers every wired rig by name, in edge order', () => {
    const s = graph(['Key', 'Rim', 'Fill']);
    expect(wiredProfileRigs(s, 'sel').map((r) => r.id)).toEqual(['rig_0', 'rig_1', 'rig_2']);
    expect(profileOptions(s, 'sel')).toEqual([
      { value: 'Key', label: 'Key' },
      { value: 'Rim', label: 'Rim' },
      { value: 'Fill', label: 'Fill' },
    ]);
  });

  it('does not offer a rig that is in the graph but not wired into this select', () => {
    const s = graph(['Key'], ['Loose']);
    // Positive control: the loose rig really is in the graph.
    expect(Object.values(s.nodes).filter((n) => n.type === 'LightRig')).toHaveLength(2);
    expect(profileOptions(s, 'sel').map((o) => o.value)).toEqual(['Key']);
  });

  it('lists a blank-named rig disabled, with the reason, instead of hiding it', () => {
    const s = graph(['Key', '']);
    expect(profileOptions(s, 'sel')).toEqual([
      { value: 'Key', label: 'Key' },
      { value: '', label: 'unnamed rig', disabledReason: 'name it to select it' },
    ]);
  });

  it('lists a second rig with a taken name disabled: choosing the name selects the first', () => {
    const s = graph(['Key', 'Key']);
    expect(profileOptions(s, 'sel')).toEqual([
      { value: 'Key', label: 'Key' },
      { value: 'Key', label: 'Key', disabledReason: 'a rig above has the same name' },
    ]);
  });

  it('a select with no rigs, or a node that does not exist, offers nothing', () => {
    expect(profileOptions(graph([]), 'sel')).toEqual([]);
    expect(profileOptions(graph(['Key']), 'no_such_node')).toEqual([]);
  });
});
