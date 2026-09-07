// #930 — one vocabulary for what a clip does past its last key.
//
// The row that carries the issue is "cycle-in-place is reachable AND distinct
// from cycle-with-offset". Everything else here is the safety net around it:
// the two carriers agreeing on a default, and the migration that makes changing
// that default safe for stored work.

import { describe, expect, it } from 'vitest';
import { ClipLoopSchema, clipExtendRules, clipLoopOf, isCycling } from './clipLoop';
import { AnimationClipParams, buildClipBoneSamplers } from './AnimationClip';
import { TransformClipParams } from './TransformClip';
import { migrateClipLoopToTriState } from '../core/project/migrations';

/** A clip whose bone TRAVELS: one metre per period along z. */
const travelling = (loop: 'hold' | 'cycle' | 'cycle-offset') => ({
  duration: 1,
  loop,
  keyframes: [
    {
      bone: 0,
      time: 0,
      position: [0, 0, 0] as [number, number, number],
      rotation: [0, 0, 0] as [number, number, number],
    },
    {
      bone: 0,
      time: 1,
      position: [0, 0, 1] as [number, number, number],
      rotation: [0, 0, 0] as [number, number, number],
    },
  ],
});

const zAt = (loop: 'hold' | 'cycle' | 'cycle-offset', t: number): number => {
  const sampler = buildClipBoneSamplers(travelling(loop)).get(0)!;
  return sampler(t).position[2];
};

describe('#930 — the clip loop vocabulary', () => {
  // ── THE ROW THE ISSUE EXISTS FOR ─────────────────────────────────────────
  it('cycle-in-place is REACHABLE and is not cycle-with-offset', () => {
    // One period past the end. In place replays the range, so it is back at the
    // start; with offset it has covered a second metre.
    expect(zAt('cycle', 1.5)).toBeCloseTo(0.5, 6);
    expect(zAt('cycle-offset', 1.5)).toBeCloseTo(1.5, 6);
    // ANTI-VACUITY: the fixture must actually travel, or "in place" and "with
    // offset" agree for a reason that has nothing to do with the rule.
    expect(zAt('cycle-offset', 1.5)).not.toBeCloseTo(zAt('cycle', 1.5), 3);
  });

  it('holding pins the LAST KEY, and is distinct from both cycling modes', () => {
    expect(zAt('hold', 1.5)).toBeCloseTo(1, 6);
    expect(zAt('hold', 9)).toBeCloseTo(1, 6);
  });

  it('rotation never offsets — it is bounded and a residual would compound', () => {
    expect(clipExtendRules('cycle-offset')).toEqual({
      position: 'cycle-offset',
      rotation: 'cycle',
    });
    expect(clipExtendRules('cycle')).toEqual({ position: 'cycle', rotation: 'cycle' });
    expect(clipExtendRules('hold')).toEqual({ position: 'hold', rotation: 'hold' });
  });

  it('clipExtendRules is TOTAL — an unrecognised stored value holds, never undefined', () => {
    // It used to fall out of a switch as `undefined`, which destructures into a
    // crash two frames from the bad data. Params arrive from stored JSON, where
    // the type is a promise rather than a guarantee.
    for (const junk of [true, false, 'loop', 'clamp', null, undefined, 42]) {
      expect(clipExtendRules(junk as never)).toEqual({ position: 'hold', rotation: 'hold' });
    }
  });

  // ── the two carriers now agree ───────────────────────────────────────────
  it('BOTH carriers default to hold — the opposite defaults are gone', () => {
    expect(AnimationClipParams.parse({}).loop).toBe('hold');
    expect(TransformClipParams.parse({}).loop).toBe('hold');
  });

  it('BOTH carriers take all three — one concept, one spelling (#934)', () => {
    // This row used to say the opposite: a TransformClip could not express
    // cycle-offset, because it folds TIME and had no way to add a per-period
    // offset, so accepting the value would have degraded it to plain cycling.
    // "Unreachable beats degraded" was the right call while that was true. #934
    // gave the carrier a real offset, so the narrow schema is gone and the subset
    // split with it.
    //
    // Asserted through the NODES' own schemas rather than only through
    // ClipLoopSchema: the claim is that the two CARRIERS agree, and reading the
    // shared schema twice would prove only that it equals itself.
    for (const value of ['hold', 'cycle', 'cycle-offset']) {
      expect(ClipLoopSchema.safeParse(value).success).toBe(true);
      expect(AnimationClipParams.shape.loop.safeParse(value).success).toBe(true);
      expect(TransformClipParams.shape.loop.safeParse(value).success).toBe(true);
    }
  });

  it('the old spellings are refused rather than silently accepted', () => {
    for (const old of [true, false, 'loop', 'clamp']) {
      expect(AnimationClipParams.safeParse({ loop: old }).success).toBe(false);
    }
  });

  it('clipLoopOf answers the unset question ONCE, agreeing with the schema', () => {
    expect(clipLoopOf(undefined)).toBe('hold');
    expect(clipLoopOf(true)).toBe('hold');
    expect(clipLoopOf('cycle')).toBe('cycle');
    expect(isCycling('hold')).toBe(false);
    expect(isCycling('cycle')).toBe(true);
    expect(isCycling('cycle-offset')).toBe(true);
  });
});

describe('#930 — the v11 → v12 migration keeps stored work behaving the same', () => {
  const run = (nodes: Record<string, unknown>) =>
    migrateClipLoopToTriState({ formatVersion: 11, state: { nodes } }) as {
      formatVersion: number;
      state: { nodes: Record<string, { params: { loop: unknown } }> };
    };

  const clip = (type: string, params: Record<string, unknown>) => ({ type, version: 1, params });

  it('a LOOPING AnimationClip becomes cycle-offset, not cycle', () => {
    // It travelled. Mapping it to plain `cycle` would take the travel out of
    // every stored walk — the character would moonwalk on the spot.
    const out = run({ a: clip('AnimationClip', { loop: true }) });
    expect(out.state.nodes.a.params.loop).toBe('cycle-offset');
  });

  it('an ABSENT AnimationClip loop follows the OLD default, which was looping', () => {
    // The whole reason a migration is owed: the schema default moved, so absent
    // must be written as what it was doing, not as what a new clip would do.
    const out = run({ a: clip('AnimationClip', {}) });
    expect(out.state.nodes.a.params.loop).toBe('cycle-offset');
  });

  it('a one-shot AnimationClip holds', () => {
    expect(run({ a: clip('AnimationClip', { loop: false }) }).state.nodes.a.params.loop).toBe(
      'hold',
    );
  });

  it("a TransformClip's 'loop' becomes cycle and 'clamp' becomes hold", () => {
    const out = run({
      a: clip('TransformClip', { loop: 'loop' }),
      b: clip('TransformClip', { loop: 'clamp' }),
      c: clip('TransformClip', {}),
    });
    expect(out.state.nodes.a.params.loop).toBe('cycle');
    expect(out.state.nodes.b.params.loop).toBe('hold');
    // Absent follows THIS carrier's old default ('clamp'), which is the OPPOSITE
    // of the sibling's. Writing both reads the same way is the tidiest mistake.
    expect(out.state.nodes.c.params.loop).toBe('hold');
  });

  it('stamps v12 and leaves other node types alone', () => {
    const out = run({ n: clip('Object', { position: [1, 2, 3] }) });
    expect(out.formatVersion).toBe(12);
    expect(out.state.nodes.n.params).toEqual({ position: [1, 2, 3] });
  });

  it('a migrated clip parses against the NEW schema — the pass and the schema agree', () => {
    // Without this the migration could write a value the schema refuses, and the
    // project would fail to load with a message pointing at the file rather than
    // at the pass that wrote it.
    for (const stored of [{ loop: true }, { loop: false }, {}]) {
      const out = run({ a: clip('AnimationClip', stored) });
      expect(AnimationClipParams.safeParse(out.state.nodes.a.params).success).toBe(true);
    }
    for (const stored of [{ loop: 'loop' }, { loop: 'clamp' }, {}]) {
      const out = run({ a: clip('TransformClip', stored) });
      expect(TransformClipParams.safeParse(out.state.nodes.a.params).success).toBe(true);
    }
  });
});
