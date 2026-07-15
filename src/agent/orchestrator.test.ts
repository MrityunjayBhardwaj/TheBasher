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
import {
  buildUnknownToolError,
  parseProposePlanClosureSpec,
  parseProposePlanMeta,
} from './orchestrator';

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

describe('parseProposePlanMeta — Mutator metadata extraction (Wave C1)', () => {
  it('extracts mutator + intent + warnings from a successful payload', () => {
    const text = JSON.stringify({
      ok: true,
      mutator: 'mutator.duplicate',
      intent: 'Duplicate the cube',
      closureRoots: ['n_box'],
      closureFollowedEdges: ['parent'],
      nodesInClosure: 3,
      warnings: ['animation: shared with the source'],
    });
    const meta = parseProposePlanMeta(text);
    expect(meta).not.toBeNull();
    expect(meta!.mutator).toBe('mutator.duplicate');
    expect(meta!.intent).toBe('Duplicate the cube');
    expect(meta!.warnings).toEqual(['animation: shared with the source']);
  });

  it('returns empty warnings array when none present', () => {
    const text = JSON.stringify({ ok: true, mutator: 'mutator.rotate', intent: 'r' });
    const meta = parseProposePlanMeta(text);
    expect(meta!.warnings).toEqual([]);
  });

  it('filters non-string entries out of warnings', () => {
    const text = JSON.stringify({
      ok: true,
      mutator: 'm',
      intent: 'i',
      warnings: ['ok', 42, null, 'also ok'],
    });
    const meta = parseProposePlanMeta(text);
    expect(meta!.warnings).toEqual(['ok', 'also ok']);
  });

  it('returns null on rejected payload (ok: false)', () => {
    const text = JSON.stringify({ ok: false, mutator: 'm' });
    expect(parseProposePlanMeta(text)).toBeNull();
  });

  it('returns null on undefined / malformed input', () => {
    expect(parseProposePlanMeta(undefined)).toBeNull();
    expect(parseProposePlanMeta('not-json')).toBeNull();
  });
});

describe('buildUnknownToolError — Wave B mutator.X corrective hint (#31)', () => {
  // executeToolCall returns this whenever the LLM names a tool the
  // registry doesn't know. Two shapes — the `mutator.X` shape is the
  // primary fix for "the LLM keeps calling mutator.duplicate as a top-
  // level tool" (Goal 4 of PR #28). These tests pin the corrective
  // string so a future copy-edit can't silently drop the proposePlan
  // hint and resurrect the loop.

  it('mutator.X: surfaces both "unknown tool" AND the agent.proposePlan corrective shape', () => {
    const result = buildUnknownToolError('mutator.rotate');
    expect(result.ops).toEqual([]);
    expect(result.text).toContain('unknown tool');
    expect(result.text).toContain('"mutator.rotate"');
    // The corrective example must name the same mutator AND show the
    // proposePlan call shape — both are required so the LLM's next
    // round is a fix, not another mistake.
    expect(result.text).toContain('agent.proposePlan({ mutator: "mutator.rotate"');
    // The model already HAS the name (it tried to call it as a tool), so the
    // corrective points at getMutator for the spec shape — not listMutators.
    expect(result.text).toContain('agent.getMutator({ name: "mutator.rotate" })');
  });

  it('mutator.duplicate (Goal 4 case): same corrective shape with the actual name interpolated', () => {
    const result = buildUnknownToolError('mutator.duplicate');
    expect(result.text).toContain('agent.proposePlan({ mutator: "mutator.duplicate"');
  });

  it('non-mutator unknown tool: bare "unknown tool" without the proposePlan hint', () => {
    // The corrective shape is mutator-specific. For any other unknown
    // name the LLM should pick a real tool, not be misdirected into
    // proposePlan.
    const result = buildUnknownToolError('random.nonexistent');
    expect(result.ops).toEqual([]);
    expect(result.text).toBe('ERROR: unknown tool "random.nonexistent"');
    expect(result.text).not.toContain('proposePlan');
  });
});
