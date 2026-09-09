// motion.generate — the agent half of A1's three-way parity.
//
// What these tests pin is that the TOOL adds nothing of its own on top of the
// road a DIRECTOR takes — no extra op, no provenance flag, no branch — and that
// its context wiring fails legibly rather than silently.
//
// The comparator moved at #948. It used to be `buildGeneratedMotionOps`, the
// one-shot importer road; a director stopped taking that road at #935 and now
// mints a `MotionGenerate` producer, so comparing the tool against the importer
// was measuring agreement with a road nobody walks. It is now compared against
// mint + bake — the two halves the director's road itself composes.

import { beforeEach, describe, expect, it } from 'vitest';
import {
  __resetRegistryForTests,
  applyOp,
  emptyDagState,
  evaluate,
  getNodeType,
  listNodeTypes,
} from '../../core/dag';
import { registerAllNodes } from '../../nodes/registerAll';
import { StubMotionGenerationCapability, DEFAULT_MOTIONGEN_MODEL } from '../../core/motiongen';
import { __resetBvhImportCounterForTests } from '../../core/import/bvhImportChain';
import { aBlockedRecord } from '../../core/licensing/blockedModelForTests';
import { motionGenerateTool } from './motionGenerate';
import { registerAllTools, listTools, __resetToolRegistryForTests } from './index';
import type { ToolContext } from './types';
import type { DagState } from '../../core/dag/state';
import { applyOp } from '../../core/dag/ops';
import { bakeGeneratedClipOps } from '../../app/asset/bakeGeneratedClip';
import { mintMotionGenerateOps } from '../../app/asset/mintMotionGenerate';
import { resolvePendingMotionGenerations } from '../../app/asset/resolveMotionGenerate';
import type { AnimationClipValue } from '../../nodes/types';

const BLOCKED = aBlockedRecord().id;

beforeEach(() => {
  __resetRegistryForTests();
  registerAllNodes();
  __resetBvhImportCounterForTests();
});

function stateWithTime(): DagState {
  let s = emptyDagState();
  s = applyOp(s, { type: 'addNode', nodeId: 'time', nodeType: 'TimeSource', params: {} }).next;
  return s;
}

/**
 * Rewrite freshly-minted node ids to stable placeholders, in order of first
 * appearance. The BVH import chain mints ids with a random suffix, so two calls
 * are structurally identical and textually different BY DESIGN — the chain's own
 * tests sidestep this by passing explicit ids, which the agent surface
 * deliberately does not do. Normalising compares what is actually being claimed:
 * the SHAPE of the ops, not the identity of nodes that are meant to be new.
 */
function normaliseIds(ops: readonly unknown[]): unknown {
  const seen = new Map<string, string>();
  const rename = (id: string): string => {
    if (!seen.has(id)) seen.set(id, `id_${seen.size}`);
    return seen.get(id)!;
  };
  const walk = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') {
      return Object.fromEntries(
        Object.entries(v as Record<string, unknown>).map(([k, val]) => [
          k,
          k === 'nodeId' || k === 'node' ? rename(String(val)) : walk(val),
        ]),
      );
    }
    return v;
  };
  return walk(ops);
}

function ctx(over: Partial<ToolContext> = {}): ToolContext {
  return {
    dagState: stateWithTime(),
    motionCapability: new StubMotionGenerationCapability(),
    motionModel: DEFAULT_MOTIONGEN_MODEL,
    ...over,
  };
}

describe('motion.generate produces a clip and adds no road of its own', () => {
  it("returns exactly the ops the DIRECTOR's road builds — no tool-level extras", async () => {
    // The load-bearing assertion. If the tool ever grows an op the director's road
    // does not also produce, that op IS the divergence #948 records, and this reds
    // the moment it appears.
    //
    // The seed is FIXED on both sides. It is a required param with no default, so
    // an unseeded call picks one at random and the two graphs would differ in the
    // one field that is supposed to make them reproducible.
    const state = stateWithTime();

    const mint = mintMotionGenerateOps(state, {
      prompt: 'a figure walks forward',
      seed: 7,
      model: DEFAULT_MOTIONGEN_MODEL,
    });
    let forked = state;
    for (const op of mint.ops) forked = applyOp(forked, op).next;
    await resolvePendingMotionGenerations(forked, new StubMotionGenerationCapability());
    const direct = [...mint.ops, ...bakeGeneratedClipOps(forked)];

    const viaTool = await motionGenerateTool.handler(
      { prompt: 'a figure walks forward', seed: 7 },
      ctx({ dagState: state }),
    );

    // THE POPULATION, beside the verdict. Two empty arrays are deep-equal, so a
    // comparator with nothing in it agrees perfectly and measures nothing. This
    // pins that the director's road actually built AND COOKED something before
    // the tool is asked to match it.
    expect(direct.length).toBeGreaterThan(6);
    expect(direct.some((o) => o.type === 'setParam' && o.paramPath === 'sourceHash')).toBe(true);

    expect(viaTool.ops).toHaveLength(direct.length);
    expect(normaliseIds(viaTool.ops)).toEqual(normaliseIds(direct));
  });

  it('#957 — every node type the ops ADD is named in the description', async () => {
    // The description is the contract the MODEL plans against, and it is prose, so
    // it drifts in silence: no type reads it, no linter reads it, and a description
    // that has become false is indistinguishable from one that is true.
    //
    // This row is the near miss from #948 turned into a gate. That change took the
    // tool from minting two nodes to minting three; the description was rewritten in
    // the same commit, correctly, and NOTHING would have failed had it not been. The
    // direction that matters is ops -> description: a node the tool starts adding
    // without announcing it is a capability the model cannot plan around, and that
    // is the half no reviewer reliably notices.
    //
    // Only node types the ops ADD, and only by name. What a description CLAIMS
    // ('carrying no mark of having been generated') is not mechanically checkable,
    // and a gate that pretended otherwise would pass on wording rather than on
    // behaviour. The vocabulary is the checkable part — and it is the part renames
    // and splits break, invisibly, exactly as they broke sockets and params.
    const result = await motionGenerateTool.handler(
      { prompt: 'a figure walks forward' },
      ctx({ dagState: stateWithTime() }),
    );
    const added = [
      ...new Set(
        result.ops.flatMap((op) => (op.type === 'addNode' ? [op.nodeType as string] : [])),
      ),
    ].sort();
    // The population beside the verdict: with no ops this row would pass by
    // examining nothing, which is the failure mode it exists to prevent elsewhere.
    expect(added, 'the tool added no nodes — the check below would be vacuous').not.toEqual([]);
    const unannounced = added.filter((t) => !motionGenerateTool.description.includes(t));
    expect(
      unannounced,
      `the ops add node types the description never names: ${JSON.stringify(unannounced)}`,
    ).toEqual([]);
  });

  it('the emitted clip evaluates to a real AnimationClip with keyframes', async () => {
    // Observation at the OUTPUT, not at the call: ops being produced is not the
    // same fact as a clip existing in an evaluated graph.
    let state = stateWithTime();
    const result = await motionGenerateTool.handler(
      { prompt: 'a figure waves', seconds: 1, fps: 24 },
      ctx({ dagState: state }),
    );
    for (const op of result.ops) state = applyOp(state, op).next;

    const clipNode = Object.values(state.nodes).find((n) => n.type === 'AnimationClip');
    expect(clipNode, 'no AnimationClip in the graph').toBeTruthy();
    const clip = evaluate(state, clipNode!.id, {
      ctx: { time: { frame: 0, seconds: 0, normalized: 0 } },
    }).value as AnimationClipValue;
    // The same assertions the imported-BVH clip gets, deliberately — a generated
    // clip needing a weaker check would not be the same kind of object.
    expect(clip.kind).toBe('AnimationClip');
    expect(clip.duration).toBeGreaterThan(0);
    // Optional since #901; an `AnimationClip` node still always answers one.
    // No pose (#920) — the clip describes the motion; a consumer with a Time
    // samples it. Keys and the rig they are indexed against travel together.
    expect(clip.keyframes.length).toBeGreaterThan(0);
    expect(clip.skeleton.bones.length).toBeGreaterThan(0);
  });

  it('is deterministic — the same prompt and seed produce the same ops', async () => {
    // Determinism is a claim about the MOTION, not about node identity — fresh
    // ids are supposed to be fresh, so they are normalised away before comparing.
    const state = stateWithTime();
    const a = await motionGenerateTool.handler(
      { prompt: 'walk', seed: 7 },
      ctx({ dagState: state }),
    );
    const b = await motionGenerateTool.handler(
      { prompt: 'walk', seed: 7 },
      ctx({ dagState: state }),
    );
    const c = await motionGenerateTool.handler(
      { prompt: 'walk', seed: 8 },
      ctx({ dagState: state }),
    );
    expect(normaliseIds(a.ops)).toEqual(normaliseIds(b.ops));
    // …and a different seed really does move differently, or the check above
    // would pass for a generator that ignores the seed entirely.
    expect(normaliseIds(c.ops)).not.toEqual(normaliseIds(a.ops));
  });

  it('never dispatches — the caller gets ops, the live graph is untouched (V7)', async () => {
    const state = stateWithTime();
    const before = JSON.stringify(state);
    await motionGenerateTool.handler({ prompt: 'walk' }, ctx({ dagState: state }));
    expect(JSON.stringify(state)).toBe(before);
  });
});

describe('a missing piece of context fails legibly, and names the right setting', () => {
  it('reports no capability rather than throwing', async () => {
    const result = await motionGenerateTool.handler(
      { prompt: 'walk' },
      ctx({ motionCapability: undefined }),
    );
    expect(result.ops).toEqual([]);
    expect(result.text).toMatch(/no motion-generation capability/i);
  });

  it('reports a missing checkpoint SEPARATELY from a missing capability', async () => {
    // Two different misconfigurations. Collapsing them into one message sends the
    // reader to the wrong setting, which is a worse failure than either.
    const result = await motionGenerateTool.handler(
      { prompt: 'walk' },
      ctx({ motionModel: undefined }),
    );
    expect(result.ops).toEqual([]);
    expect(result.text).toMatch(/no motion checkpoint/i);
    expect(result.text).not.toMatch(/no motion-generation capability/i);
  });

  it('returns a BLOCKED refusal as readable text, and KEEPS the generator', async () => {
    // A licence refusal is something the model can act on — it is a settings
    // change. Throwing would end the turn with nothing for it to read.
    //
    // The producer still ships, and that is deliberate parity rather than an
    // oversight: a director's road mints before it cooks, so a blocked checkpoint
    // leaves them a node carrying the prompt and the seed, re-cookable the moment
    // Settings changes. A tool that returned nothing would make the agent's road
    // the one where a refusal costs you the request.
    const result = await motionGenerateTool.handler(
      { prompt: 'walk' },
      ctx({ motionModel: BLOCKED }),
    );
    expect(result.text).toMatch(/BLOCKED/);
    // The generator and its sink, and NOT a cooked clip: no keys were written.
    expect(
      result.ops
        .filter((o) => o.type === 'addNode')
        .map((o) => o.nodeType)
        .sort(),
    ).toEqual(['AnimationClip', 'MotionGenerate', 'Skeleton']);
    expect(result.ops.some((o) => o.type === 'setParam' && o.paramPath === 'sourceHash')).toBe(
      false,
    );
  });

  it('refuses a degenerate request through the same path', async () => {
    const result = await motionGenerateTool.handler(
      // fps is schema-bounded at the tool boundary too, so go through the
      // capability's own validation with a value the tool schema permits.
      { prompt: 'walk', fps: 0.5, seconds: 0.5 },
      ctx(),
    );
    // 0.5fps over 0.5s is legal — two frames minimum. The clip still lands.
    expect(result.ops.length).toBeGreaterThan(0);
  });
});

describe('the tool is actually reachable by the agent', () => {
  it('is registered by registerAllTools, not merely defined', async () => {
    // A tool that exists and is never registered is a tool the agent cannot call,
    // and nothing else in this file would notice.
    __resetToolRegistryForTests();
    registerAllTools();
    expect(listTools().map((t) => t.name)).toContain('motion.generate');
    __resetToolRegistryForTests();
  });

  it('its schema rejects an empty prompt at the boundary', () => {
    expect(motionGenerateTool.paramSchema.safeParse({ prompt: '' }).success).toBe(false);
    expect(motionGenerateTool.paramSchema.safeParse({ prompt: 'walk' }).success).toBe(true);
  });

  it('does NOT accept a checkpoint as an argument — it is configuration', () => {
    // Naming the checkpoint per call would spread the licence surface across
    // every prompt. The schema is strict about it by omission; assert that the
    // omission is deliberate rather than forgotten.
    const parsed = motionGenerateTool.paramSchema.safeParse({ prompt: 'walk', model: BLOCKED });
    expect(parsed.success).toBe(true);
    expect(parsed.success && 'model' in parsed.data).toBe(false);
  });
});

describe('the agent-facing text offers only roads that exist (#758)', () => {
  /**
   * Every input socket in the live registry that consumes a pose-bearing value.
   * Derived, never spelled out: a hard-coded list would keep passing after a
   * fold node shipped, which is the one moment this guard has to speak.
   */
  function poseConsumingSockets(): string[] {
    const found: string[] = [];
    for (const type of listNodeTypes()) {
      const def = getNodeType(type);
      for (const [socket, spec] of Object.entries(def?.inputs ?? {})) {
        const s = spec as { type: string; cardinality?: string };
        if (s.type === 'AnimationClip' || s.type === 'PosedSkeleton') {
          found.push(`${type}.${socket}: ${s.type} (${s.cardinality})`);
        }
      }
    }
    return found.sort();
  }

  it('measures the premise: no ONE node takes two poses, and none takes a list', () => {
    // Not a restatement of the guard below — its PREMISE, asserted where a
    // reader can see it. This reds the day a pose-folding node lands, which is
    // precisely when the description must be rewritten rather than left to
    // drift back into a promise nobody re-measured.
    //
    // 🔴 THE PROPERTY IS PER-NODE, AND IT WAS NOT ALWAYS WRITTEN THAT WAY (#901).
    // This used to assert that exactly ONE socket in the whole registry consumed
    // a pose. That was a proxy for "no two clips can meet", and #901 falsified
    // the proxy without touching the property: `RetargetClip` is a second node
    // that takes a clip, and it still takes exactly ONE. Two clips meet when a
    // SINGLE node can hold both — two pose-bearing sockets on the same node, or
    // one that accepts a list. So the census keeps its exact shape and the
    // derivation moved to where the property actually lives. The guard did not
    // get weaker: a real fold node reds it either way, and this now also reds on
    // a list socket that the old count would have read as a single.
    //
    // #935 added a THIRD entry and it is deliberately not a fold: `AnimationClip`
    // gained a `source` socket naming the node that PRODUCED its keys, and it
    // takes exactly one. One pose socket on a node that has no other cannot hold
    // two clips, so the property is untouched and only the census moved — which
    // is the distinction this row exists to force someone to make.
    expect(poseConsumingSockets()).toEqual([
      'AnimationClip.source: AnimationClip (single)',
      'LocomotionState.clip: AnimationClip (single)',
      'RetargetClip.sourceClip: AnimationClip (single)',
    ]);
  });

  it('does not offer layering while no two clips can meet', async () => {
    const sockets = poseConsumingSockets();
    const perNode = new Map<string, number>();
    for (const s of sockets) {
      const type = s.slice(0, s.indexOf('.'));
      perNode.set(type, (perNode.get(type) ?? 0) + 1);
    }
    const canFold =
      [...perNode.values()].some((n) => n > 1) ||
      sockets.some((s) => s.endsWith('(list)') || s.endsWith('(multi)'));
    expect(canFold).toBe(false);

    // BOTH agent-facing surfaces, not just the catalogue entry. The result text
    // is the one the model reads immediately after acting, and it carried the
    // same promise.
    const result = await motionGenerateTool.handler({ prompt: 'walk' }, ctx());
    // `ToolResult.text` is optional, so this is a requirement, not a cast: a
    // result the model reads nothing from would satisfy the loop below
    // vacuously — the H451 shape, where the assertion holds for the very
    // implementation it forbids.
    expect(result.text).toBeTruthy();
    for (const text of [motionGenerateTool.description, result.text ?? '']) {
      expect(text.toLowerCase()).not.toMatch(/\blayer/);
    }
  });

  it('still names the road that DOES exist, so the correction did not just delete', () => {
    // A guard that only forbids can be satisfied by saying nothing. Retarget is
    // real and covered (generatedMotion.test.ts), so it must survive.
    expect(motionGenerateTool.description).toContain('mutator.animation.retarget');
  });
});
