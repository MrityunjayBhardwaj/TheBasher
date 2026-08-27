// motion.generate — the agent half of A1's three-way parity.
//
// The phase's claim is proven at the chain level (generatedMotion.test.ts: the
// Ops are deep-equal to an imported BVH's). What these tests pin is that the TOOL
// adds nothing of its own on top — no extra op, no provenance flag, no branch —
// and that its context wiring fails legibly rather than silently.

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
import {
  StubMotionGenerationCapability,
  buildGeneratedMotionOps,
  DEFAULT_MOTIONGEN_MODEL,
} from '../../core/motiongen';
import { __resetBvhImportCounterForTests } from '../../core/import/bvhImportChain';
import { aBlockedRecord } from '../../core/licensing/blockedModelForTests';
import { motionGenerateTool } from './motionGenerate';
import { registerAllTools, listTools, __resetToolRegistryForTests } from './index';
import type { ToolContext } from './types';
import type { DagState } from '../../core/dag/state';
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
  it('returns exactly the Ops the generation chain returns — no tool-level extras', async () => {
    // The load-bearing assertion. If the tool ever grows an op an import does not
    // also produce, that op IS the provenance branch A1 exists to avoid, and this
    // reds the moment it appears.
    const state = stateWithTime();
    const direct = await buildGeneratedMotionOps(
      new StubMotionGenerationCapability(),
      { request: { prompt: 'a figure walks forward', model: DEFAULT_MOTIONGEN_MODEL } },
      state,
    );
    const viaTool = await motionGenerateTool.handler(
      { prompt: 'a figure walks forward' },
      ctx({ dagState: state }),
    );

    expect(viaTool.ops).toHaveLength(direct.ops.length);
    expect(normaliseIds(viaTool.ops)).toEqual(normaliseIds(direct.ops));
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
    expect(clip.pose.kind).toBe('PosedSkeleton');
    expect(clip.pose.poses.length).toBeGreaterThan(0);
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

  it('returns a BLOCKED refusal as readable text rather than ending the turn', async () => {
    // A licence refusal is something the model can act on — it is a settings
    // change. Throwing would end the turn with nothing for it to read.
    const result = await motionGenerateTool.handler(
      { prompt: 'walk' },
      ctx({ motionModel: BLOCKED }),
    );
    expect(result.ops).toEqual([]);
    expect(result.text).toMatch(/BLOCKED/);
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

  it('measures the premise: exactly one socket consumes a pose, and it is single', () => {
    // Not a restatement of the guard below — its PREMISE, asserted where a
    // reader can see it. This reds the day a pose-folding node lands, which is
    // precisely when the description must be rewritten rather than left to
    // drift back into a promise nobody re-measured.
    expect(poseConsumingSockets()).toEqual(['LocomotionState.clip: AnimationClip (single)']);
  });

  it('does not offer layering while no two clips can meet', async () => {
    const sockets = poseConsumingSockets();
    const canFold =
      sockets.length > 1 || sockets.some((s) => s.endsWith('(list)') || s.endsWith('(multi)'));
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
