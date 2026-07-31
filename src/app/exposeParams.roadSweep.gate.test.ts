// The ROAD SWEEP gate (#394, PLAN-3 §5 gate 3) — every road that turns a SELECTION into a
// param write is adjudicated, in writing, exactly once.
//
// ── WHAT THIS GUARDS, AND WHY A GREEN SUITE IS NOT THE SAME THING ───────────────────
//
// PLAN-3's whole argument is that a surface row generated FROM a node writes back to THAT
// node, and that an ownership oracle is only for callers holding no row. The failure that
// argument exists to prevent is silent by construction: a road resolves the wrong layer,
// the write succeeds, the store changes, undo records an entry, and the viewport does not
// move. Nothing throws. That defect shipped three times (#516, #518, #522) before anything
// watched for it.
//
// Tests cover the roads that EXIST. What no test can cover is the road somebody adds next
// week — and a forgotten road and a deliberate one look identical from the outside. So this
// gate is a CENSUS, not a prohibition: it enumerates the roads from the tracked source and
// requires that each be named in exactly one of two lists. A new road fails until a human
// says which it is. That is the same mechanism `GHOSTLESS_KINDS` and `ACCEPTED_CARRIERS`
// use, and the reason is [[V120]]'s: the meaning has to be written down or the set decays
// into whatever the code happens to do.
//
// ── THE OPT-OUT LIST IS THE LOAD-BEARING HALF ───────────────────────────────────────
//
// A gate whose exception list is an unexplained set of paths excuses the thing it was built
// to catch. Every entry here carries the reason it does not need the projection, and every
// reason is one of exactly two shapes:
//
//   (a) the write target is the node's OWN param — the transform band a poser owns, a
//       channel node's own keyframes — so provenance and resolution give the same answer
//       and there is nothing for an oracle to get wrong;
//   (b) the target id comes from the road's OWN enumeration rather than from the raw
//       selection, which IS provenance, just sourced somewhere other than an inspector row.
//
// A road that fits NEITHER shape does not belong on this list. If one ever seems to, that
// is the finding — not a third bullet.
//
// ── WHAT THIS CANNOT GUARD, stated because a gate that hides its blind spot reads as
//    more coverage than it has ────────────────────────────────────────────────────────
//
//   • It is a FILE-level census, not a call-level one. A file correctly listed as routing
//     through the projection could grow a second, unrouted write and stay green. The
//     per-call property is what the behavioural tests and the byte-identical gate cover;
//     this one covers the set of files, which is the axis they cannot see.
//   • A write assembled through a helper this gate's patterns do not name is invisible to
//     it. That is why the two component sets are asserted NON-EMPTY and at a floor below:
//     a pattern that silently stops matching would otherwise turn the census green by
//     emptying its own subject — the exact way a source-scan gate expires without saying so
//     ([[H219]]).
//   • It scans NON-TEST tracked source only. Fixtures build writes freely and a working
//     tree usually holds a dozen untracked probes; a gate that is red locally and green in
//     CI gets switched off.
//
// REF: src/app/exposeParams.ts (the projection), src/app/promoteParam.ts, src/test-utils/
//      sourceScan.ts (`stripComments`), src/test-utils/retiredKinds.gate.test.ts (the
//      census-with-reasons precedent); PLAN-3 §5 gate 3; #394, #516, #518, #522.

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { stripComments } from '../test-utils/sourceScan';

/** A road reads the selection if it asks the selection store who is selected. */
const SELECTION_PATTERNS = [/useSelectionStore/, /selectedNodeId/, /primaryNodeId/];

/** …and it writes a param if it emits a `setParam` op or builds a driver/channel onto one. */
const WRITE_PATTERNS = [
  /type:\s*'setParam'/,
  /buildBindDriverOps/,
  /buildPromoteParamOps/,
  /buildAddChannelOps/,
];

/**
 * Roads that MUST resolve through the projection, asserted positively rather than merely
 * left off the opt-out list — an empty positive set would make this whole gate a list of
 * excuses.
 */
const PROJECTION_ROADS = new Set(['src/app/NPanel.tsx', 'src/app/PromoteParamControl.tsx']);

/**
 * What "consults the projection" looks like in source. `resolveControlHost` is on this list
 * because it IS a projection read — it answers "which control already serves this chain?"
 * by walking `exposeParams`, and a road that asks it has asked the projection. Naming only
 * the entry point would have made the promote road look unrouted while being the most
 * projection-dependent road there is.
 */
const CONSULTS_PROJECTION = /exposeParams|resolveExposedTarget|resolveControlHost/;

/**
 * Roads that legitimately do NOT consult the projection, each with the reason, and each
 * reason of shape (a) or (b) above. Asserted as a SET: a novel road fails, and an entry
 * that no longer matches is reported as prunable rather than silently carried.
 */
const OPT_OUTS: Record<string, string> = {
  'src/app/Gizmo.tsx':
    "(a) writes only the selected node's OWN transform band (position/rotation/scale), which no other layer in the chain can hold — the projection would resolve it to the same node by construction. It also runs at pointer-move rate, where building a projection per event is the measured H48 hazard.",
  'src/app/MultiSelectInspector.tsx':
    '(a) offers the transform fields only, and writes a field ONLY to a node whose own params already hold a vec3 there (the isVec3 guard skips the rest) — so it never writes past a node that does not own the field. Multi-select holds no rows by definition; the day it offers a DATA param (size, material) it needs the oracle and must leave this list.',
  'src/app/KeyboardShortcuts.tsx':
    "(b) the insert/delete-keyframe targets are the KEYFRAME CHANNEL node's own `keyframes` param, addressed from the timeline selection rather than the node selection. A channel's keyframes are not a param any object-addressed projection carries.",
  'src/timeline/TimelineCanvas.tsx':
    '(b) writes mute/solo on `row.channelId` — the channel node the ROW was built from, which is provenance, not resolution.',
  'src/timeline/LightStudioPanel.tsx':
    '(b) writes to ids from its OWN enumeration of lights and its own shading node, never to the raw selection.',
  'src/app/animate/dispatchApplyTransform.ts':
    '(b) the Apply road resolves the data half itself as part of baking, and its writes target nodes it just built or the asset it read the child from — ids it holds directly.',
};

function trackedSource(): string[] {
  return execFileSync('git', ['ls-files', 'src'], { encoding: 'utf8' })
    .split('\n')
    .filter((f) => /\.tsx?$/.test(f) && !/\.test\.tsx?$/.test(f) && !/^src\/test-utils\//.test(f));
}

function matchingFiles(patterns: readonly RegExp[]): Set<string> {
  const hits = new Set<string>();
  for (const file of trackedSource()) {
    const src = stripComments(readFileSync(file, 'utf8'));
    if (patterns.some((p) => p.test(src))) hits.add(file);
  }
  return hits;
}

describe('road sweep — every selection→write road is adjudicated', () => {
  const selectionReaders = matchingFiles(SELECTION_PATTERNS);
  const writeEmitters = matchingFiles(WRITE_PATTERNS);
  const roads = [...selectionReaders].filter((f) => writeEmitters.has(f)).sort();

  it('the subject is real — neither component set has quietly emptied', () => {
    // THE COMPANION [[H219]] REQUIRES. Without it, a pattern that stopped matching (a
    // renamed store, a helper that replaced a literal op) would empty the census and turn
    // this file green while covering nothing at all. The floors are measured, not guessed:
    // 41 selection readers and 50 write emitters at the time of writing.
    expect(selectionReaders.size).toBeGreaterThanOrEqual(30);
    expect(writeEmitters.size).toBeGreaterThanOrEqual(35);
    expect(roads.length).toBeGreaterThanOrEqual(5);
  });

  it('every road is either routed through the projection or explicitly opted out, with a reason', () => {
    const adjudicated = new Set([...PROJECTION_ROADS, ...Object.keys(OPT_OUTS)]);
    const unadjudicated = roads.filter((f) => !adjudicated.has(f));
    // The message names the file, because the point of failing is to make somebody decide.
    expect(
      unadjudicated,
      `New road(s) turning a selection into a param write. Decide for each: does it resolve ` +
        `through exposeParams (add to PROJECTION_ROADS), or does it write a node's own param / ` +
        `an id it already holds (add to OPT_OUTS with the reason)?`,
    ).toEqual([]);
  });

  it('no adjudicated entry is stale — a list that outlives its roads is a list nobody reads', () => {
    const live = new Set(roads);
    expect([...PROJECTION_ROADS].filter((f) => !live.has(f))).toEqual([]);
    expect(Object.keys(OPT_OUTS).filter((f) => !live.has(f))).toEqual([]);
  });

  it('every opt-out carries a substantive reason naming its shape', () => {
    for (const [file, reason] of Object.entries(OPT_OUTS)) {
      // A reason has to say WHICH of the two shapes it is; "not needed here" is how an
      // exception list becomes decoration.
      expect(reason, `${file} opt-out reason`).toMatch(/^\((a|b)\)/);
      expect(reason.length, `${file} opt-out reason too short to be a reason`).toBeGreaterThan(60);
    }
  });

  it('the roads that must consult the projection actually import it', () => {
    // The positive half. Without it this gate could be satisfied by moving every road onto
    // the opt-out list, which is the failure mode of every exception-list gate.
    for (const file of PROJECTION_ROADS) {
      const src = stripComments(readFileSync(file, 'utf8'));
      expect(src, `${file} is listed as routing through the projection`).toMatch(
        CONSULTS_PROJECTION,
      );
    }
  });
});
