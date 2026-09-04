// #724 — A READER NAMES THE DOMAIN IT WANTS, AND GETS ONLY THAT ONE.
//
// An attribute is addressed by NAME, and a name can live at more than one domain — the same
// `bevel_weight` at point and at edge, the same `Cd` at point and at corner. Nothing in this
// codebase decided which one a reader got; the answer was "whichever entry was written last",
// which is a rule nobody chose.
//
// ── WHY NOT HOUDINI'S PRECEDENCE, WHICH THE ISSUE PROPOSED ────────────────────────────────
//
// Houdini answers with finest-wins (Vertex > Point > Primitive > Detail, i.e. corner > point >
// face for our nouns). That is a real answer and it is the WRONG one here, and the reason is
// measurable rather than aesthetic: `targetedMaterialAttributes` merges a minted FACE
// `material_index` over whatever the source carried, so under finest-wins a carried CORNER
// entry of that name would outrank the operator's own output and silently reverse it.
//
// So the rule is stricter: a reader states the domain it can use, and an entry at any other
// domain is NOT FOUND. `attributeAt` is the only seam that resolves a name against a set.
//
// ── THIS WAS NOT LATENT, WHICH IS WHY ROW 2 EXISTS ───────────────────────────────────────
//
// The issue is filed as "latent today". It was not. Two production readers took
// `material_index` at ANY domain: `geometryRegistry` laid it over the faces, and
// `rebuiltMeshAttributes` documented the check — "or nothing face-domain in it" — without
// performing it. Row 2 is the exact input that separates the two readings, and it was found
// only because the first probe FAILED to red: uniform data short-circuits before the branch
// that propagates, so the discriminating case needs non-uniform data whose count matches the
// rebuilt face count.
//
// REF: src/nodes/attributes.ts (`attributeAt`); src/nodes/meshAttributes.ts
//      (`rebuiltMeshAttributes`); src/app/geometryRegistry.ts; issue #724, ref/houdini/SOP.md:12.

import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { stripComments } from '../test-utils/sourceScan';
import { MATERIAL_INDEX, attributeAt, type AttributeData } from './attributes';
import { mintAttributes } from './attributeKey';
import { insert } from '../app/attributeStore';
import { rebuiltMeshAttributes } from './meshAttributes';
import type { GeometryDescriptor } from './types';

const ROOT = path.resolve(__dirname, '../..');

function productFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      productFiles(full, out);
      continue;
    }
    if (!/\.tsx?$/.test(entry)) continue;
    if (/\.test\.|\.gate\./.test(entry)) continue;
    out.push(path.relative(ROOT, full).split(path.sep).join('/'));
  }
  return out;
}

const pointIndex = (data: number[]): AttributeData => ({
  domain: 'point',
  type: 'int',
  count: data.length,
  data: new Int32Array(data),
});

describe('#724 a name resolves against a set only WITH a domain', () => {
  it('attributeAt finds the entry at the domain asked for, and nothing at any other', () => {
    const minted = mintAttributes({ [MATERIAL_INDEX]: pointIndex([0, 1, 0, 1, 0, 1]) })!;

    expect(attributeAt(minted.set, MATERIAL_INDEX, 'point')?.count).toBe(6);
    // The same name, the same set — every other domain answers "not found" rather than
    // handing back an entry the caller cannot use.
    expect(attributeAt(minted.set, MATERIAL_INDEX, 'face')).toBeUndefined();
    expect(attributeAt(minted.set, MATERIAL_INDEX, 'edge')).toBeUndefined();
    expect(attributeAt(minted.set, MATERIAL_INDEX, 'corner')).toBeUndefined();
    // Total on the way in: no set at all asks the same question as a set.
    expect(attributeAt(null, MATERIAL_INDEX, 'face')).toBeUndefined();
    expect(attributeAt(undefined, MATERIAL_INDEX, 'face')).toBeUndefined();
  });

  it('🔴 a point-domain material_index is NOT propagated as a rebuilt face assignment', () => {
    // The discriminating input, measured: NON-uniform (uniform short-circuits earlier) and
    // count === the rebuilt face count of a box, which is the branch that returns the carried
    // key verbatim. Under the pre-#724 reading this returned `minted.key` itself.
    const minted = mintAttributes({ [MATERIAL_INDEX]: pointIndex([0, 1, 0, 1, 0, 1]) })!;
    insert(minted.key, minted.set, 'overlay');

    const box = { kind: 'box', size: [1, 1, 1] } as unknown as GeometryDescriptor;
    const out = rebuiltMeshAttributes(minted.key, box);

    expect(out.key).not.toBe(minted.key);
    expect(out.key).not.toBeNull();
  });

  it('no production reader subscripts a set by a bare attribute name', () => {
    // ABSENCE, not presence: a presence check ("someone calls attributeAt") is monotone in the
    // size of the file and so could never red on a NEW bare read being added, which is the
    // whole failure mode. `attributes.ts` declares the seam and `attributeKey.ts` is the
    // generic mint/projection loop over `Object.keys`, so neither resolves a NAME.
    const exempt = new Set(['src/nodes/attributes.ts', 'src/nodes/attributeKey.ts']);
    const files = productFiles(path.join(ROOT, 'src')).filter((f) => !exempt.has(f));

    // A computed KEY (`{ [MATERIAL_INDEX]: … }`) is a write and is fine; a READ is the same
    // subscript NOT followed by a colon.
    const read = /\[(?:MATERIAL_INDEX|UV_MAP)\]\s*(?!:)/;
    const offenders = files
      .filter((f) => read.test(stripComments(readFileSync(path.join(ROOT, f), 'utf8'))))
      .sort();

    // DENOMINATOR: the scan actually examined the modules that carry these reads.
    expect(files).toContain('src/nodes/meshAttributes.ts');
    expect(files).toContain('src/app/geometryRegistry.ts');
    expect(files.length).toBeGreaterThan(100);
    expect(offenders).toEqual([]);
  });
});
