// #733 — the critic sees what a plan DID, across BOTH halves of the graph.
//
// The row that matters most here is not the headline. It is `id-ref attachment`:
// a node held only by an id-reference must NOT be reported as stranded. A critic
// that walked edges alone would fail exactly that row, and would then certify the
// silent-failure class the edge-less sidecars have a history of producing.

import { describe, expect, it, beforeEach } from 'vitest';
import { __resetRegistryForTests, applyOp } from '../../core/dag';
import type { DagState } from '../../core/dag/state';
import type { Op } from '../../core/dag/types';
import { registerAllNodes } from '../../nodes/registerAll';
import { buildDefaultDagState } from '../../core/project/default';
import { describeEffect, critique, renderCritique, outputClosure } from './effect';

__resetRegistryForTests();
registerAllNodes();

let base: DagState;
beforeEach(() => {
  base = buildDefaultDagState();
});

const apply = (from: DagState, ops: Op[]): DagState => {
  let s = from;
  for (const op of ops) s = applyOp(s, op).next;
  return s;
};
const run = (ops: Op[]) => {
  const after = apply(base, ops);
  return {
    report: describeEffect(base, after, ops),
    findings: critique(describeEffect(base, after, ops)),
  };
};

describe('#733 critic — what the plan actually did', () => {
  it('THE PIN: a node added and wired to nothing is named as such', () => {
    // The exact shape the interface gate scored `valid`: every param correct,
    // connected to nothing, the cube untouched.
    const { report, findings } = run([
      {
        type: 'addNode',
        nodeId: 'n_scatter',
        nodeType: 'Scatter',
        params: { density: 1, seed: 0, bounds: [1, 1, 1], scaleJitter: 0, randomYaw: false },
      },
    ] as Op[]);
    expect(report.added.map((a) => a.id)).toEqual(['n_scatter']);
    expect(report.added[0].attachedFrom).toEqual([]);
    expect(report.added[0].attachedTo).toEqual([]);
    expect(findings.join('\n')).toContain('connected it to nothing');
    expect(findings.join('\n')).toContain('n_scatter');
    expect(report.reachesOutput).toBe(false);
  });

  it('CONTROL: an edit that does what it says produces NO findings', () => {
    const { report, findings } = run([
      { type: 'setParam', nodeId: 'n_box', paramPath: 'rotation', value: [0, 45, 0] },
    ] as Op[]);
    expect(report.changed).toEqual(['n_box']);
    expect(report.reachesOutput).toBe(true);
    expect(findings).toEqual([]);
    expect(renderCritique(findings)).toBe('');
  });

  it('🔴 ID-REF ATTACHMENT: a node held only by an id-reference is NOT stranded', () => {
    // A keyframe channel names its subject by id and has no wired edge at all.
    // An edge-only walker reports this as connected to nothing. It is not.
    const { report, findings } = run([
      {
        type: 'addNode',
        nodeId: 'n_chan',
        nodeType: 'KeyframeChannelNumber',
        params: { name: 'c', target: 'n_box', paramPath: 'position.y' },
      },
    ] as Op[]);
    const added = report.added.find((a) => a.id === 'n_chan')!;
    // The channel is a SIDECAR of n_box (role 'subject'), so its effect reaches the
    // scene through n_box's own resolution. It reads nothing and is not stranded.
    expect(added.attachedFrom).toContain('n_box');
    expect(added.attachedTo).toEqual([]);
    // A first draft said "it reads n_box but nothing reads IT" — exactly backwards.
    expect(findings).toEqual([]);
    expect(report.reachesOutput).toBe(true);
  });

  it('a node that READS something but nothing reads IT is distinguished from stranded', () => {
    // Road C's answer to "put an array modifier on the cube": the modifier reads the
    // cube's data, nothing reads the modifier, so the cube gets no copies on screen.
    const { findings } = run([
      { type: 'addNode', nodeId: 'n_array', nodeType: 'ArrayModifier', params: {} },
      { type: 'setParam', nodeId: 'n_array', paramPath: 'count', value: 5 },
      {
        type: 'connect',
        from: { node: 'n_box_data', socket: 'out' },
        to: { node: 'n_array', socket: 'target' },
      },
    ] as Op[]);
    const text = findings.join('\n');
    expect(text).toContain('nothing reads IT');
    expect(text).not.toContain('connected it to nothing');
    // The per-node finding already accounts for every addition, so the whole-plan
    // summary is NOT repeated underneath it — one sentence, not two.
    expect(text).not.toContain("Nothing the project's outputs can see changed");
    // `n_box_data` is the `from` of a connect — an edge lives on the CONSUMER, so the
    // producer's record is untouched and reporting it would be a false positive.
    expect(text).not.toContain('Named but unchanged');
  });

  it('CONTROL: it REPORTS and never refuses — the deliberate-orphan case keeps its escape', () => {
    // `mutator.nla.createAction` mints an Action wired to nothing on purpose.
    const { findings } = run([
      { type: 'addNode', nodeId: 'nla_action_1', nodeType: 'Action', params: {} },
    ] as Op[]);
    expect(findings.length).toBeGreaterThan(0);
    expect(findings.join('\n')).toContain('If that is deliberate');
    // Nothing here throws, rejects, or returns a verdict.
    expect(renderCritique(findings)).toContain('observations, not rejections');
  });

  it('a plan that applies and moves nothing is called out', () => {
    const { report, findings } = run([
      { type: 'setParam', nodeId: 'n_box', paramPath: 'rotation', value: [0, 0, 0] },
    ] as Op[]);
    expect(report.vacuous).toBe(true);
    expect(findings.join('\n')).toContain('changed nothing at all');
  });

  it('the whole-plan summary fires when no addition explains it', () => {
    // A Shot has no consumer anywhere in the product yet, so it sits outside
    // everything the outputs read. Created in SETUP, then edited by the plan: the plan
    // adds nothing, so there is no per-node finding to make the summary a duplicate.
    // This is the case the summary exists for.
    const withShot = apply(base, [
      { type: 'addNode', nodeId: 'n_shot', nodeType: 'Shot', params: {} },
    ] as Op[]);
    expect(outputClosure(withShot).has('n_shot')).toBe(false);

    const ops = [{ type: 'setParam', nodeId: 'n_shot', paramPath: 'endTime', value: 4 }] as Op[];
    const after = apply(withShot, ops);
    const findings = critique(describeEffect(withShot, after, ops));
    const report = describeEffect(withShot, after, ops);

    expect(report.changed).toEqual(['n_shot']);
    expect(report.added).toEqual([]);
    expect(report.reachesOutput).toBe(false);
    expect(findings.join('\n')).toContain("Nothing the project's outputs can see changed");
  });

  it('the output closure is taken from the project outputs and spans id-refs', () => {
    const closure = outputClosure(base);
    // The seeded scene's render path.
    for (const id of ['n_render', 'n_scene', 'n_box', 'n_box_data', 'n_camera', 'n_light']) {
      expect(closure.has(id), `${id} should be inside the output closure`).toBe(true);
    }
    // A channel naming a live node is itself live (it overlays what the render reads).
    const after = apply(base, [
      {
        type: 'addNode',
        nodeId: 'n_chan',
        nodeType: 'KeyframeChannelNumber',
        params: { name: 'c', target: 'n_box', paramPath: 'position.y' },
      },
    ] as Op[]);
    expect(outputClosure(after).has('n_chan')).toBe(true);
  });

  it('🔴 deleting a live SIDECAR registers, and only the before-closure can see it', () => {
    // The discriminating case for the before-closure branch, and it is narrow. A node
    // can only be removed once nothing consumes it, so a removable node is usually
    // outside the closure already. A keyframe channel is the exception: it has no wired
    // edge at all, yet it is live because it is a sidecar of a live object. Delete it
    // and NOTHING else moves — no edge is torn down, no surviving node changes — so the
    // after closure is identical and the before closure is the only witness that
    // something the render could see has gone.
    const withChannel = apply(base, [
      {
        type: 'addNode',
        nodeId: 'n_chan',
        nodeType: 'KeyframeChannelNumber',
        params: { name: 'c', target: 'n_box', paramPath: 'position.y' },
      },
    ] as Op[]);
    expect(outputClosure(withChannel).has('n_chan')).toBe(true);

    const ops = [{ type: 'removeNode', nodeId: 'n_chan' }] as Op[];
    const after = apply(withChannel, ops);
    const report = describeEffect(withChannel, after, ops);

    expect(report.removed).toEqual(['n_chan']);
    expect(report.changed).toEqual([]); // nothing that survived moved at all
    expect(report.reachesOutput).toBe(true);
  });

  it('a removal the outputs could see counts as reaching them', () => {
    const { report } = run([
      {
        type: 'disconnect',
        from: { node: 'n_light', socket: 'out' },
        to: { node: 'n_scene', socket: 'lights' },
      },
    ] as Op[]);
    expect(report.reachesOutput).toBe(true);
  });

  // ── #1019 — a sidecar whose NAME is wrong is not a wiring problem ──────────────────
  //
  // The old sentence said "connected it to nothing" for these. Every one of these node
  // types declares `in: -` — no input sockets at all — so that advice can only be
  // followed by inventing a socket, which is the dominant failure on the raw-op road.

  it('THE PIN: a channel naming a node that does not exist says WHICH param and WHAT it names', () => {
    const { findings } = run([
      {
        type: 'addNode',
        nodeId: 'n_chan',
        nodeType: 'KeyframeChannelNumber',
        params: { name: 'c', target: 'Cube', paramPath: 'position.y' },
      },
    ] as Op[]);
    const text = findings.join('\n');
    expect(text).toContain('`target` names "Cube"');
    expect(text).toContain('not a node in this scene');
    expect(text).toContain('by NAME, not by a wire');
    // The misdiagnosis must be GONE, not merely joined by the truth.
    expect(text).not.toContain('connected it to nothing');
  });

  it('an EMPTY reference is distinguished from a wrong one', () => {
    const { findings } = run([
      {
        type: 'addNode',
        nodeId: 'n_chan',
        nodeType: 'KeyframeChannelNumber',
        params: { name: 'c', target: '', paramPath: 'position.y' },
      },
    ] as Op[]);
    const text = findings.join('\n');
    expect(text).toContain('`target` is empty');
    expect(text).not.toContain('names ""');
    expect(text).not.toContain('connected it to nothing');
  });

  it('THE REPORT CONTRACT: a LIVE reference is not a bad ref', () => {
    // Asserted on the report, not on the sentence. Through `critique` the liveness test
    // is unreachable — a live subject ref puts the node in `attachedFrom`, so it is not
    // stranded and the sentence is never built. `badRefs` is part of the report's public
    // shape, so the claim belongs where a future consumer would read it.
    const { report } = run([
      {
        type: 'addNode',
        nodeId: 'n_chan',
        nodeType: 'KeyframeChannelNumber',
        params: { name: 'c', target: 'n_box', paramPath: 'position.y' },
      },
    ] as Op[]);
    expect(report.added.find((a) => a.id === 'n_chan')!.badRefs).toEqual([]);
  });

  it('CONTROL: a channel naming a LIVE node is silent, as before', () => {
    const { findings } = run([
      {
        type: 'addNode',
        nodeId: 'n_chan',
        nodeType: 'KeyframeChannelNumber',
        params: { name: 'c', target: 'n_box', paramPath: 'position.y' },
      },
    ] as Op[]);
    expect(findings).toEqual([]);
  });

  it('CONTROL: a node with SOCKETS and no id-refs keeps the wiring sentence', () => {
    // Scatter declares no `idRefs`, so "connected it to nothing" is the true diagnosis
    // for it and must survive. This is the row that stops the new branch swallowing the
    // old one.
    const { findings } = run([
      {
        type: 'addNode',
        nodeId: 'n_scatter',
        nodeType: 'Scatter',
        params: { density: 1, seed: 0, bounds: [1, 1, 1], scaleJitter: 0, randomYaw: false },
      },
    ] as Op[]);
    const text = findings.join('\n');
    expect(text).toContain('connected it to nothing');
    expect(text).not.toContain('by NAME');
  });
});
