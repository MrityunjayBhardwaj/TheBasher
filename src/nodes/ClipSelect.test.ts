// ClipSelect evaluator tests — Wave C.
//
// Pins the select-by-name contract (CONTEXT.md D-06): no substring
// match (test 4 uses 'walk' vs 'walks' to catch that); null on miss
// (no silent fallback to first clip — surfaces the "selected clip
// is gone" state to the renderer).
//
// REF: PLAN.md Wave C; CONTEXT.md D-06.

import { describe, expect, it } from 'vitest';
import { ClipSelectNode, ClipSelectParams } from './ClipSelect';
import type { TransformClipValue } from './types';

function makeClip(name: string): TransformClipValue {
  return { kind: 'TransformClip', name, duration: 1, tracks: {} };
}

function evalSelect(
  selectedClipName: string,
  clips: TransformClipValue[] | TransformClipValue | undefined,
): TransformClipValue | null {
  const parsed = ClipSelectParams.parse({ selectedClipName });
  return ClipSelectNode.evaluate(
    parsed,
    clips !== undefined ? { clips } : {},
  ) as TransformClipValue | null;
}

describe('ClipSelect evaluator', () => {
  it('undefined clips input → returns null', () => {
    expect(evalSelect('walk', undefined)).toBeNull();
  });

  it('single matching clip → returns it (kind TransformClip)', () => {
    const walk = makeClip('walk');
    const result = evalSelect('walk', [walk]);
    expect(result).not.toBeNull();
    expect(result!.kind).toBe('TransformClip');
    expect(result!.name).toBe('walk');
  });

  it('single non-matching clip → returns null (no silent fallback)', () => {
    const walk = makeClip('walk');
    expect(evalSelect('idle', [walk])).toBeNull();
  });

  it('three clips, pick the middle one by exact name', () => {
    // Includes a substring-similar entry ('walks') that a `.includes`
    // bug would erroneously return for `selectedClipName: 'walk'`.
    const clips = [makeClip('walk'), makeClip('walks'), makeClip('idle')];
    expect(evalSelect('walks', clips)!.name).toBe('walks');
    expect(evalSelect('walk', clips)!.name).toBe('walk');
    expect(evalSelect('idle', clips)!.name).toBe('idle');
  });

  it("empty-string selectedClipName matches a clip literally named ''", () => {
    const empty = makeClip('');
    const walk = makeClip('walk');
    expect(evalSelect('', [empty, walk])!.name).toBe('');
    expect(evalSelect('', [walk])).toBeNull();
  });

  it('deterministic: identical inputs → identical output reference', () => {
    const walk = makeClip('walk');
    const a = evalSelect('walk', [walk]);
    const b = evalSelect('walk', [walk]);
    expect(a).toBe(b); // pass-through preserves the input reference
  });
});
