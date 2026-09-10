// Mutator catalog — the slim LLM-facing picker (#332).
//
// agent.listMutators used to return the full metadata (name + description +
// contract + specExample) for ALL 26 mutators in a single tool result: ~26 KB,
// ~22% of the turn budget for one call, and the payload that tipped "point the
// camera at the cube" over the cost guard. It now returns just enough to pick
// AND propose in ONE result (~7 KB):
//   listMutators → name + first-sentence summary + specExample  (the picker)
//   getMutator   → adds the full description + contract          (only on a gate rejection)
// The contract (~5 KB, validation metadata the model never passes) is dropped
// from the list; the specExample the model copies stays inline, so the happy
// path is still list → propose with no extra discovery round (measured: a 3rd
// round costs ~22 KB of re-sent schema/prompt overhead, dwarfing the ~2 KB of
// examples it would defer).
//
// These tests pin the win (the byte ceiling — the durable regression guard),
// prove the summary is DERIVED from the description so it can never drift, and
// prove #23 survives (the specExample the model copies is still inline).

import { describe, expect, it, beforeEach } from 'vitest';
import { registerAllNodes } from '../../nodes/registerAll';
import { getNodeType } from '../../core/dag/registry';
import {
  __resetMutatorRegistryForTests,
  firstSentence,
  getMutatorMetadata,
  listMutators,
  listMutatorSummaries,
  registerAllMutators,
} from './index';
import { listMutatorsTool, getMutatorTool } from './tool';
import type { ToolContext } from '../tools/types';
import { emptyDagState } from '../../core/dag';

const ctx = (): ToolContext => ({ dagState: emptyDagState() });

describe('mutator catalog — PICKER/DETAIL split (#332)', () => {
  beforeEach(() => {
    __resetMutatorRegistryForTests();
    registerAllNodes();
    registerAllMutators();
  });

  it('the listMutators PICKER result stays under a hard byte ceiling', () => {
    // THE REGRESSION PIN. The old full-metadata payload measured 26,116 B on
    // the wire — the single tool result that tipped a turn over the cost guard.
    // The new picker (name + first-sentence summary + specExample, contract
    // DROPPED, compact) measures ~7 KB. Re-adding the contract, un-trimming the
    // descriptions, or re-adding pretty-print fails HERE, loudly, instead of
    // silently re-inflating every agent turn. 8 KB leaves headroom for a few
    // new mutators; still ~70% under the 26 KB it replaced.
    const payload = listMutatorsTool.handler({}, ctx()).text;
    expect(payload.length).toBeLessThan(8192);
  });

  it('every summary is a genuine prefix of its description — DERIVED, never authored', () => {
    // The summary is the first sentence of the description (V101 projection,
    // applied to prose): it can never say something the description does not.
    for (const m of listMutators()) {
      const summary = firstSentence(m.description);
      expect(m.description.startsWith(summary)).toBe(true);
      expect(summary.length).toBeGreaterThan(0);
    }
  });

  it('the PICKER carries name + summary + specExample, and NOT the heavy contract', () => {
    const summaries = listMutatorSummaries();
    expect(summaries.map((s) => s.name).sort()).toEqual(
      listMutators()
        .map((m) => m.name)
        .sort(),
    );
    for (const s of summaries) {
      // Exactly these three keys — the specExample the model copies stays
      // inline (#23), but the ~5 KB contract is deferred to getMutator.
      expect(Object.keys(s).sort()).toEqual(['name', 'specExample', 'summary']);
    }
  });

  it('#23 survives — the picker specExample matches the mutator definition, so the model never guesses', () => {
    const byName = new Map(listMutators().map((m) => [m.name, m]));
    for (const s of listMutatorSummaries()) {
      // The picker's specExample IS the mutator's own — the model copies a
      // value that parses through the real spec, no round-trip needed.
      expect(s.specExample).toEqual(byName.get(s.name)!.specExample);
    }
  });

  it('getMutator adds the full contract on top of the picker fields', () => {
    for (const { name } of listMutatorSummaries()) {
      const meta = getMutatorMetadata(name);
      expect(meta, `getMutatorMetadata("${name}")`).toBeDefined();
      expect(meta!.contract).toBeDefined();
      expect(meta!.specExample).toBeDefined();
    }
  });

  it('agent.getMutator returns detail for a known name and ERRORs on an unknown one', () => {
    const ok = getMutatorTool.handler({ name: 'mutator.rotate' }, ctx()).text;
    expect(ok).toContain('specExample');
    expect(ok).toContain('mutator.rotate');

    const bad = getMutatorTool.handler({ name: 'mutator.nope' }, ctx()).text;
    expect(bad).toContain('ERROR');
    expect(bad).toContain('agent.listMutators');
  });
});

describe('firstSentence', () => {
  it('splits on a sentence boundary (period + space + capital)', () => {
    expect(firstSentence('Rotate a node. Adds the delta to the current rotation.')).toBe(
      'Rotate a node.',
    );
  });

  it('does not split inside a dotted path or an abbreviation', () => {
    // "material.color" has no space after the dot; "e.g." is followed by a
    // lowercase word — neither is a sentence boundary.
    expect(firstSentence('Writes material.color on the mesh. Then done.')).toBe(
      'Writes material.color on the mesh.',
    );
    expect(firstSentence('Offset e.g. by one unit. And more.')).toBe('Offset e.g. by one unit.');
  });

  it('returns the whole string for a single-sentence description', () => {
    expect(firstSentence('Delete one or more nodes.')).toBe('Delete one or more nodes.');
    expect(firstSentence('No trailing period')).toBe('No trailing period');
  });
});

// ---------------------------------------------------------------------------
// #1006 — a description must not point at a node that does not exist
// ---------------------------------------------------------------------------

/**
 * Every node-type reference a description makes, as `[named, resolves]`.
 *
 * The detector is narrow ON PURPOSE. It looks for words ending in `Node`, because
 * that is the shape the real defect had: `randomize` sent readers to `ScatterNode`,
 * which is the TypeScript export and the file name, while the id the registry
 * answers to is `Scatter`. Widening this to every capitalised word would flag
 * socket types and TS types, and a check that cries wolf gets deleted.
 *
 * A name resolves if the registry knows it, or knows it with `Node` trimmed —
 * the trimmed form being the export-vs-id drift this exists to catch.
 */
function nodeReferences(description: string): Array<[string, boolean]> {
  return [...description.matchAll(/\b([A-Z][A-Za-z0-9]*Node)\b/g)].map(([, name]) => [
    name,
    getNodeType(name) !== undefined || getNodeType(name.replace(/Node$/, '')) !== undefined,
  ]);
}

describe('mutator descriptions name only nodes that exist (#1006)', () => {
  beforeEach(() => {
    __resetMutatorRegistryForTests();
    registerAllNodes();
    registerAllMutators();
  });

  // 🔴 THE CONTROL COMES FIRST, because the live catalog currently contains ZERO
  // such references — so the row below has an EMPTY subject and would pass forever
  // whether the detector worked or not. This proves it can find one.
  it('CONTROL: the detector finds a dangling reference and clears a real one', () => {
    expect(nodeReferences('Use ScatterNode for position randomization.')).toEqual([
      ['ScatterNode', true], // resolves via the trimmed id `Scatter` — the drift, now benign
    ]);
    expect(nodeReferences('Use FictionalNode for nothing at all.')).toEqual([
      ['FictionalNode', false],
    ]);
    expect(nodeReferences('no node references here')).toEqual([]);
  });

  it('no registered mutator points at a node the registry cannot resolve', () => {
    const dangling: string[] = [];
    let examined = 0;
    for (const m of listMutators()) {
      for (const [name, resolves] of nodeReferences(m.description ?? '')) {
        examined++;
        if (!resolves) dangling.push(`${m.name} -> ${name}`);
      }
    }
    // Print the denominator beside the zero. A description that stops naming nodes
    // at all would also make this row green, and that is worth being able to see.
    console.log(
      `[#1006] node references examined=${examined} across ${listMutators().length} mutators`,
    );
    expect(dangling).toEqual([]);
  });
});
