// The param-reach gate (#492) — every param on every split data kind must say who reads it,
// and the answer "nobody" must carry an issue.
//
// This is the axis the conformance matrix does not have. The matrix is one param deep by
// construction (see `paramReach.ts`), so a kind can pass all ten roads with eleven of its
// twelve params going nowhere. Six open issues are exactly that, found one at a time.
//
// THE CHECKS, and which of them actually bite:
//
//   1. TOTALITY AGAINST THE ZOD SCHEMA, BOTH DIRECTIONS. The subject is derived from the
//      registered node's `paramSchema`, never hand-listed, so a param added to a schema fails
//      until classified and an entry outliving its param fails too. This is the check that
//      makes the table unable to rot, and it is the reason the gate reads the schema at run
//      time rather than trusting a constant.
//
//   2. A "NOBODY READS IT" ANSWER MUST NAME AN ISSUE, and an `unverified` answer must name
//      one too. A gap with no issue is a gap nobody will close.
//
//   3. A NAMED READER MUST EXIST AND MENTION THE PARAM. Weak on purpose and documented as
//      such — `zoom` is mentioned by the very file that drops it. It catches the careless
//      case (a reader that does not mention the param at all) and nothing subtler. It is
//      stated here so nobody reads a green gate as proof the reader really reads.
//
//   4. THE SEAM MEASUREMENT IS REPORTED, NOT DECLARED. The gate evaluates a real pair of each
//      kind and works out where each param actually gets to. Nothing in the table restates
//      it, so nothing about it can go stale. It is asserted only where it is unambiguous: a
//      param declared to have NO reader must not reach the renderer, because if it does the
//      declaration is simply wrong.
//
// WHY THE SEAM IS MEASURED AT TWO PLACES. A param can die in two different ways and they need
// telling apart. `zoom` is emitted by `CameraData.evaluate` and dropped by
// `recomposeCameraObject` — it reaches the data value and stops. `widthSegments` never
// appears in the data value at all, because it is folded into a `GeometryRef`. The first is a
// defect; the second is normal. One seam cannot distinguish them, so the gate looks at both.
//
// REF: src/test-utils/paramReach.ts (the table); src/test-utils/splitKinds.ts (the kinds);
//      issues #492, #478.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { applyOp } from '../core/dag/ops';
import { emptyDagState } from '../core/dag/state';
import { evaluate } from '../core/dag/evaluator';
import { snapshotRegistry } from '../core/dag/registry';
import type { EvalCtx, Op } from '../core/dag/types';
import { registerAllNodes } from '../nodes/registerAll';
import {
  renderedValueForBand,
  rowDataParams,
  splitOps,
  SPLIT_KINDS,
  SPLIT_KIND_NAMES,
  type SplitKindName,
} from './splitKinds';
import { hasReader, isUnverified, PARAM_READERS } from './paramReach';

const CTX: EvalCtx = { time: { frame: 0, seconds: 0, normalized: 0 } };
const REPO_ROOT = join(__dirname, '..', '..');

/** The param names a kind's registered node actually declares. The subject, derived. */
function schemaParams(kind: SplitKindName): string[] {
  const def = snapshotRegistry()[SPLIT_KINDS[kind].dataType] as unknown as {
    paramSchema?: { shape?: Record<string, unknown> };
  };
  return Object.keys(def?.paramSchema?.shape ?? {});
}

type Seam = 'render' | 'value' | 'consumed';

/** Where each of a kind's params actually gets to. Measured, never declared. */
function measureSeams(kind: SplitKindName): Record<string, Seam> {
  const objectId = `n_${kind}`;
  let state = emptyDagState();
  for (const op of splitOps(kind, { objectId }, { data: rowDataParams(kind) })) {
    state = applyOp(state, op as Op).next;
  }
  const dataValue = evaluate(state, `${objectId}_data`, { ctx: CTX }).value as Record<
    string,
    unknown
  >;
  const rendered = renderedValueForBand(
    SPLIT_KINDS[kind].band,
    evaluate(state, objectId, { ctx: CTX }).value,
  );
  // The children band hands the renderer the whole Object, whose substance sits under
  // `.data`; the flattening bands hand it the recomposed value directly. Ask the band's own
  // shape rather than guessing.
  const renderedBag = (
    SPLIT_KINDS[kind].band === 'children'
      ? ((rendered as Record<string, unknown> | undefined)?.data ?? {})
      : (rendered ?? {})
  ) as Record<string, unknown>;

  const out: Record<string, Seam> = {};
  for (const p of schemaParams(kind)) {
    if (p in renderedBag) out[p] = 'render';
    else if (p in (dataValue ?? {})) out[p] = 'value';
    else out[p] = 'consumed';
  }
  return out;
}

describe('param-reach gate (#492)', () => {
  beforeEach(() => {
    registerAllNodes();
  });

  it('every schema param is classified, and every classification names a real param', () => {
    const problems: string[] = [];
    for (const kind of SPLIT_KIND_NAMES) {
      const declared = new Set(Object.keys(PARAM_READERS[kind] ?? {}));
      const actual = new Set(schemaParams(kind));
      for (const p of actual) {
        if (!declared.has(p)) {
          problems.push(
            `${kind}.${p}: on the schema but not classified — it can be edited and saved, ` +
              `and nobody has said whether anything reads it`,
          );
        }
      }
      for (const p of declared) {
        if (!actual.has(p)) {
          problems.push(
            `${kind}.${p}: classified but not on the schema — the param was renamed or ` +
              `removed and this entry is describing something that no longer exists`,
          );
        }
      }
    }
    expect(problems, problems.join('\n')).toEqual([]);
  });

  it('every "nobody reads it" and every unverified answer names an issue', () => {
    const problems: string[] = [];
    for (const kind of SPLIT_KIND_NAMES) {
      for (const [param, reader] of Object.entries(PARAM_READERS[kind])) {
        if (hasReader(reader)) continue;
        const issue = reader.issue;
        if (!/^#\d+$/.test(issue)) {
          problems.push(`${kind}.${param}: no reader and no issue number ("${issue}")`);
        }
        if (isUnverified(reader) && !reader.note.trim()) {
          problems.push(`${kind}.${param}: unverified with no note — the next person starts blind`);
        }
        if (!isUnverified(reader) && !reader.why.trim()) {
          problems.push(`${kind}.${param}: declared unread with no reason`);
        }
      }
    }
    expect(problems, problems.join('\n')).toEqual([]);
  });

  it('every named reader exists and mentions the param (necessary, not sufficient)', () => {
    const problems: string[] = [];
    for (const kind of SPLIT_KIND_NAMES) {
      for (const [param, reader] of Object.entries(PARAM_READERS[kind])) {
        if (!hasReader(reader)) continue;
        let src: string;
        try {
          src = readFileSync(join(REPO_ROOT, reader.by), 'utf8');
        } catch {
          problems.push(`${kind}.${param}: named reader ${reader.by} does not exist`);
          continue;
        }
        if (!new RegExp(`\\b${param}\\b`).test(src)) {
          problems.push(
            `${kind}.${param}: ${reader.by} is named as reading it but never mentions it`,
          );
        }
      }
    }
    expect(problems, problems.join('\n')).toEqual([]);
  });

  it('a param declared unread does not reach the renderer', () => {
    // The one place the measurement can contradict the declaration outright. If a param
    // said to be read by nothing turns up in the value the renderer consumes, the entry is
    // wrong and its issue is probably chasing a bug that does not exist.
    const problems: string[] = [];
    for (const kind of SPLIT_KIND_NAMES) {
      const seams = measureSeams(kind);
      for (const [param, reader] of Object.entries(PARAM_READERS[kind])) {
        if (hasReader(reader) || isUnverified(reader)) continue;
        if (seams[param] === 'render') {
          problems.push(
            `${kind}.${param}: declared unread (${reader.issue}) but it DOES reach the ` +
              `renderer — the declaration is wrong`,
          );
        }
      }
    }
    expect(problems, problems.join('\n')).toEqual([]);
  });

  it('the measured seams are self-consistent (guard the guard)', () => {
    // Without this, a `schemaParams` that returned [] — a registry not reseeded, a node type
    // renamed — would make every check above pass by having nothing to check.
    for (const kind of SPLIT_KIND_NAMES) {
      const params = schemaParams(kind);
      expect(
        params.length,
        `${kind}: no schema params found — the subject is empty`,
      ).toBeGreaterThan(0);
      const seams = measureSeams(kind);
      expect(Object.keys(seams).sort()).toEqual([...params].sort());
    }
    // And the kind's own observable — the one param the matrix already proves end to end —
    // must be classified as reaching the renderer. If this ever fails, the seam measurement
    // disagrees with a road that is independently green, and one of them is broken.
    for (const kind of SPLIT_KIND_NAMES) {
      const observableRoot = SPLIT_KINDS[kind].observableDataParam.split('.')[0];
      expect(
        measureSeams(kind)[observableRoot],
        `${kind}: the observable "${observableRoot}" does not reach the renderer, but R3/R4 ` +
          `pass for it — the measurement and the roads disagree`,
      ).toBe('render');
    }
  });

  it('reports how much of the table is still unverified, as a ceiling that can only fall', () => {
    let unverified = 0;
    let total = 0;
    for (const kind of SPLIT_KIND_NAMES) {
      for (const reader of Object.values(PARAM_READERS[kind])) {
        total++;
        if (isUnverified(reader)) unverified++;
      }
    }
    expect(total).toBe(35);
    // A ceiling, not an equality: tracing a param down must not require editing this number,
    // but adding a new unverified one must. Lower it as #492 is worked through.
    expect(
      unverified,
      'more params are unverified than when this gate was written — new params are being ' +
        'added without tracing their readers',
    ).toBeLessThanOrEqual(3);
  });
});
