// #608 step 3 — the DISCRIMINATOR: the test that separates "the role the producer
// DECLARES" from "the passKind the evaluated value CARRIES".
//
// Why it has to exist, and why it has to mint its own members. Every pass node
// registered today declares the role it emits, so a declaration-read and a
// value-read return the same answer on every fixture that exists. The whole unit
// tier is green on BOTH implementations; it cannot even tell you the change is
// still present. Sweeping the real registry harder does not help — the registry IS
// the degenerate population. The only instrument is a member that DISAGREES with
// itself, which has to be minted here.
//
// REF: issue #608; `src/nodes/passes/passRole.ts`; `src/core/dag/types.ts`
// (`PassRole`, `OutputDescriptor.role`).

import { beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { __resetRegistryForTests, applyOp, emptyDagState, type DagState } from './index';
import { getNodeType, listNodeTypes, registerNodeType } from './registry';
import { evaluate } from './evaluator';
import { __reseedAllNodesForTests } from '../../nodes/registerAll';
import { renderSummarizePassTool } from '../../agent/tools/renderSummarizePass';
import { passRoleOf, passRoleOfType } from './passRole';
import { DEFAULT_IMAGE_DESCRIPTOR, type ImagePassKind, type ImageValue } from '../../nodes/types';
import type { Op, PassRole } from './types';

/** The exact set of role-declaring outputs, pinned by node type. */
const DECLARED_ROLES: ReadonlyArray<readonly [string, PassRole]> = [
  ['BeautyPass', 'beauty'],
  ['DepthPass', 'depth'],
  ['NormalPass', 'normal'],
  ['IDPass', 'id'],
];

/**
 * A producer that DECLARES one role and EMITS another. This member does not and
 * should not exist in production — it exists so the two readings of "which pass is
 * this" can disagree, which is the only condition under which a test can tell them
 * apart.
 */
function registerLiar(nodeType: string, declares: PassRole, emits: ImagePassKind): void {
  registerNodeType({
    type: nodeType,
    version: 1,
    pure: true,
    cost: 'cheap',
    paramSchema: z.object({}),
    inputs: {},
    outputs: { out: { type: 'Image', cardinality: 'single', role: declares } },
    evaluate: (): ImageValue => ({
      kind: 'Image',
      passKind: emits,
      descriptor: DEFAULT_IMAGE_DESCRIPTOR,
      sourceHash: 'deadbeef',
    }),
  } as never);
}

function jobWith(passes: Array<[string, string]>): DagState {
  let s = emptyDagState();
  s = applyOp(s, { type: 'addNode', nodeId: 'time', nodeType: 'TimeSource', params: {} }).next;
  s = applyOp(s, {
    type: 'addNode',
    nodeId: 'job',
    nodeType: 'RenderJob',
    params: { jobId: 'jobA', frameStart: 0, frameEnd: 60, fps: 30, outputPath: 'renders/jobA' },
  }).next;
  s = applyOp(s, {
    type: 'connect',
    from: { node: 'time', socket: 'out' },
    to: { node: 'job', socket: 'time' },
  }).next;
  for (const [nodeId, nodeType] of passes) {
    s = applyOp(s, { type: 'addNode', nodeId, nodeType, params: {} } as Op).next;
    s = applyOp(s, {
      type: 'connect',
      from: { node: nodeId, socket: 'out' },
      to: { node: 'job', socket: 'pass-input' },
    }).next;
  }
  return s;
}

/**
 * Every registered output that declares a role, paired with the passKind its
 * evaluator actually emits. Factored out so the SAME check can be run over the real
 * registry (expect no disagreement) and over a registry seeded with a liar (expect
 * exactly that liar) — an agreement gate that cannot be made to fail is not a gate.
 */
function roleTagDisagreements(): string[] {
  const out: string[] = [];
  for (const type of listNodeTypes()) {
    const def = getNodeType(type);
    if (!def) continue;
    for (const [socket, desc] of Object.entries(def.outputs)) {
      if (!desc.role) continue;
      let s = emptyDagState();
      s = applyOp(s, { type: 'addNode', nodeId: 'probe', nodeType: type, params: {} } as Op).next;
      const value = evaluate(s, 'probe', {
        ctx: { time: { frame: 0, seconds: 0, normalized: 0 } },
        socket,
      }).value as ImageValue;
      if (value?.kind === 'Image' && value.passKind !== desc.role) {
        out.push(`${type}.${socket}: declares ${desc.role}, emits ${value.passKind}`);
      }
    }
  }
  return out;
}

beforeEach(() => {
  __resetRegistryForTests();
  __reseedAllNodesForTests();
});

describe('#608 — a pass role is read from the declaration, not the value', () => {
  it('THE DISCRIMINATOR: a producer declaring depth while emitting beauty is found as DEPTH', () => {
    registerLiar('LyingPass', 'depth', 'beauty');
    const ctx = { dagState: jobWith([['liar', 'LyingPass']]) };

    // Declaration says depth → the tool must find it under depth...
    const asDepth = renderSummarizePassTool.handler(
      { jobId: 'job', passKind: 'depth', frame: 0 },
      ctx,
    );
    const summary = JSON.parse(asDepth.text!);
    expect(summary.passId).toBe('liar');

    // ...and must NOT find it under beauty, which is what its VALUE claims.
    // A value-reading implementation answers the exact opposite on both halves.
    const asBeauty = renderSummarizePassTool.handler(
      { jobId: 'job', passKind: 'beauty', frame: 0 },
      ctx,
    );
    expect(asBeauty.text).toContain('no beauty pass connected');
  });

  it('a MediaClip on pass-input is NOT a beauty pass, however its value tags itself', () => {
    const ctx = { dagState: jobWith([['clip', 'MediaClip']]) };
    // The value says passKind: 'beauty'. The graph says: this producer declares no
    // role, so it is not a pass at all.
    const clipValue = evaluate(ctx.dagState, 'clip', {
      ctx: { time: { frame: 0, seconds: 0, normalized: 0 } },
      socket: 'out',
    }).value as ImageValue;
    expect(clipValue.passKind).toBe('beauty');
    expect(passRoleOf(ctx.dagState, { node: 'clip', socket: 'out' })).toBeUndefined();

    const r = renderSummarizePassTool.handler({ jobId: 'job', passKind: 'beauty', frame: 0 }, ctx);
    expect(r.text).toContain('no beauty pass connected');
  });

  it('pins the role-declaring set EXACTLY — a new pass node that omits it fails here', () => {
    const declared = listNodeTypes()
      .flatMap((type) =>
        Object.entries(getNodeType(type)?.outputs ?? {}).map(
          ([socket, desc]) => [type, socket, desc.role] as const,
        ),
      )
      .filter(([, , role]) => role !== undefined)
      .map(([type, , role]) => [type, role] as const)
      .sort((a, b) => a[0].localeCompare(b[0]));

    expect(declared).toEqual([...DECLARED_ROLES].sort((a, b) => a[0].localeCompare(b[0])));
  });

  it('every declared role matches the passKind its evaluator emits', () => {
    expect(roleTagDisagreements()).toEqual([]);
  });

  it('...and that agreement check can actually fail — it catches a minted liar', () => {
    // Guard the guard. The check above sweeps a population where the two spellings
    // agree by construction, so on its own it would pass even if it compared nothing.
    registerLiar('LyingPass', 'normal', 'id');
    expect(roleTagDisagreements()).toEqual(['LyingPass.out: declares normal, emits id']);
  });

  it('THE GATE: a second depth pass is refused, and the message names the incumbent', () => {
    expect(() =>
      jobWith([
        ['d1', 'DepthPass'],
        ['d2', 'DepthPass'],
      ]),
    ).toThrow(/already holds a depth pass \("d1"\); a role may be bound once/);
  });

  it('the gate is per ROLE, not a cap on the list — different roles all fit', () => {
    const s = jobWith([
      ['b', 'BeautyPass'],
      ['d', 'DepthPass'],
      ['n', 'NormalPass'],
      ['i', 'IDPass'],
    ]);
    expect((s.nodes.job.inputs['pass-input'] as unknown[]).length).toBe(4);
  });

  it('role-LESS producers stay unconstrained — the open-ended list survives', () => {
    // VideoStitch's frames are an ordered sequence, not a role map. Constraining
    // by role must not quietly become "one Image per list".
    const s = jobWith([
      ['clipA', 'MediaClip'],
      ['clipB', 'MediaClip'],
    ]);
    expect((s.nodes.job.inputs['pass-input'] as unknown[]).length).toBe(2);
  });

  it('the gate does not wedge: disconnect frees the role again', () => {
    let s = jobWith([['d1', 'DepthPass']]);
    s = applyOp(s, {
      type: 'disconnect',
      from: { node: 'd1', socket: 'out' },
      to: { node: 'job', socket: 'pass-input' },
    } as Op).next;
    s = applyOp(s, { type: 'addNode', nodeId: 'd2', nodeType: 'DepthPass', params: {} } as Op).next;
    s = applyOp(s, {
      type: 'connect',
      from: { node: 'd2', socket: 'out' },
      to: { node: 'job', socket: 'pass-input' },
    } as Op).next;
    expect(s.nodes.job.inputs['pass-input']).toEqual([{ node: 'd2', socket: 'out' }]);
  });

  it('does NOT move any pass sourceHash — a role is a graph fact, never a hash input', () => {
    // MEASURED, not assumed: these four values were produced by the same probe run
    // against e6cde05 (the tree before any of #608 landed) and against this branch,
    // and they agreed exactly. Pinning them here turns that one-off comparison into
    // a standing gate — the next person to add a field near pass construction finds
    // out here, rather than by every cached render silently re-minting.
    const EXPECTED: Record<string, string> = {
      BeautyPass: '9f0d51c2',
      DepthPass: 'fe466925',
      NormalPass: 'cc98ee0f',
      IDPass: 'deb9b365',
    };
    for (const [type, hash] of Object.entries(EXPECTED)) {
      let s = emptyDagState();
      s = applyOp(s, { type: 'addNode', nodeId: 'p', nodeType: type, params: {} } as Op).next;
      const value = evaluate(s, 'p', {
        ctx: { time: { frame: 0, seconds: 0, normalized: 0 } },
        socket: 'out',
      }).value as ImageValue;
      expect(`${type}:${value.sourceHash}`).toBe(`${type}:${hash}`);
    }
  });

  it('passRoleOfType answers from the declaration for every production pass', () => {
    for (const [type, role] of DECLARED_ROLES) {
      expect(passRoleOfType(type, 'out')).toBe(role);
    }
    expect(passRoleOfType('MediaClip', 'out')).toBeUndefined();
    expect(passRoleOfType('NoSuchNode', 'out')).toBeUndefined();
  });
});
