// Orchestrator unit tests — focused parsers, not the full LLM loop.
//
// Wave A4 (#14): parseProposePlanClosureSpec must reject closure specs
// containing unknown edge kinds. Without this, an LLM (or a future
// Mutator with a typo) could emit a kind that silently no-ops the
// closure walk inside expandClosure, leaving the closure too narrow
// and downstream ops failing the gate with no useful retry signal.
//
// REF: PLAN.md p2.5.3-identify-v2 §2 Wave A4.

import { describe, expect, it } from 'vitest';
import { parseProposePlanClosureSpec } from './orchestrator';

describe('parseProposePlanClosureSpec — edge-kind validation (#14)', () => {
  it('accepts a valid spec with known edge kinds', () => {
    const text = JSON.stringify({
      ok: true,
      mutator: 'mutator.rotate',
      intent: 'r',
      closureRoots: ['box'],
      closureFollowedEdges: ['parent'],
      nodesInClosure: 1,
      warnings: [],
    });
    const spec = parseProposePlanClosureSpec(text);
    expect(spec).not.toBeNull();
    expect(spec!.rootSelectors).toEqual(['box']);
    expect(spec!.followedEdges).toEqual(['parent']);
  });

  it('accepts multi-kind specs ("parent" + "children")', () => {
    const text = JSON.stringify({
      ok: true,
      closureRoots: ['box'],
      closureFollowedEdges: ['parent', 'children'],
    });
    const spec = parseProposePlanClosureSpec(text);
    expect(spec).not.toBeNull();
    expect(spec!.followedEdges).toEqual(['parent', 'children']);
  });

  it('accepts forward-declared P3+ kinds (animation, time, pass-input, camera, lights)', () => {
    const text = JSON.stringify({
      ok: true,
      closureRoots: ['box'],
      closureFollowedEdges: ['animation', 'time', 'pass-input', 'camera', 'lights'],
    });
    const spec = parseProposePlanClosureSpec(text);
    expect(spec).not.toBeNull();
  });

  it('rejects an unknown edge kind ("socketName")', () => {
    const text = JSON.stringify({
      ok: true,
      closureRoots: ['box'],
      closureFollowedEdges: ['parent', 'socketName'],
    });
    expect(parseProposePlanClosureSpec(text)).toBeNull();
  });

  it('rejects a typo of a real kind ("childern")', () => {
    const text = JSON.stringify({
      ok: true,
      closureRoots: ['box'],
      closureFollowedEdges: ['childern'], // typo
    });
    expect(parseProposePlanClosureSpec(text)).toBeNull();
  });

  it('rejects edges with non-string entries', () => {
    const text = JSON.stringify({
      ok: true,
      closureRoots: ['box'],
      closureFollowedEdges: ['parent', 42],
    });
    expect(parseProposePlanClosureSpec(text)).toBeNull();
  });

  it('returns null on missing or false ok', () => {
    expect(
      parseProposePlanClosureSpec(
        JSON.stringify({ ok: false, closureRoots: ['box'], closureFollowedEdges: ['parent'] }),
      ),
    ).toBeNull();
  });

  it('returns null on malformed JSON', () => {
    expect(parseProposePlanClosureSpec('not-json')).toBeNull();
  });

  it('returns null on undefined input', () => {
    expect(parseProposePlanClosureSpec(undefined)).toBeNull();
  });
});
