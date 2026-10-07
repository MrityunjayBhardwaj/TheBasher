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
// These tests pin the win (compact, three keys, a one-sentence summary and a small example per
// entry — the durable regression guard; a total byte ceiling was it until #1575),
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

  // THE REGRESSION PIN (#332, reshaped at #1575). The old full-metadata payload measured 26,116 B on
  // the wire — the single tool result that tipped a turn over the cost guard. The picker is name +
  // first-sentence summary + specExample, contract DROPPED, compact.
  //
  // It was pinned by a TOTAL byte ceiling, which could not tell a regression (the contract back, a
  // paragraph for a summary, pretty-print: kilobytes each) from growth (one honest mutator: 113–461 B).
  // So each new mutator tripped it and the fix was to raise it — 8192 → 9216 at #1201, 9216 → 10240
  // at #1510 — while the regression it was written for sat inside the headroom: `setPoseMemberMode`
  // shipped a 306-character "summary", its whole description. The pin is now on what it guards,
  // per entry and by name, so an honest mutator passes untouched and each regression fails.
  //
  // No total: the picker is ~2.3k tokens a call against a 150k-token turn budget. At ~250 B a
  // mutator, 100 of them is ~25 KB; the answer then is listing by namespace, not a byte cap.
  const wire = (): { text: string; mutators: Record<string, unknown>[] } => {
    const { text } = listMutatorsTool.handler({}, ctx()) as { text: string };
    return {
      text,
      mutators: (JSON.parse(text) as { mutators: Record<string, unknown>[] }).mutators,
    };
  };

  it('the PICKER on the wire is compact, and carries exactly name + summary + specExample', () => {
    const { text, mutators } = wire();
    // Pretty-print is pure overhead the model re-parses every round.
    expect(text).toBe(JSON.stringify(JSON.parse(text)));
    expect(mutators).toHaveLength(listMutators().length);
    for (const m of mutators) {
      // The ~5 KB contract (and the full description) stay behind getMutator.
      expect(Object.keys(m).sort(), String(m.name)).toEqual(['name', 'specExample', 'summary']);
    }
  });

  it('every PICKER summary is one sentence, and every specExample is small', () => {
    // 220: the longest honest summary measures 205 (`timeline.setKeyframeInterp`, 2026-10-07). A
    // run-on is what `firstSentence` returns when the first sentence is followed by something it
    // does not read as a boundary (a lower-case word): the measured ones were 306–552 characters.
    // 256 B: the largest example measures 233 (`camera.trajectory`).
    const long = wire()
      .mutators.filter((m) => String(m.summary).length > 220)
      .map((m) => `${String(m.name)}: ${String(m.summary).length}-character summary`);
    expect(long, 'end the first sentence before a capital or a backtick').toEqual([]);
    const big = wire()
      .mutators.filter((m) => JSON.stringify(m.specExample).length > 256)
      .map((m) => `${String(m.name)}: ${JSON.stringify(m.specExample).length} B specExample`);
    expect(big, 'a specExample is the smallest spec that parses, not a tour').toEqual([]);
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
