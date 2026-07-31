// #394 S4 — the two structural gates the composable material model rests on.
//
// Both answer objections that were raised against this design rather than discovered
// afterwards, and both are written as REFUSALS rather than conventions, because a
// convention is a comment and this file is the thing that makes it a build failure.
//
// ── GATE 1: ONE DECISION FUNCTION, N VOCABULARY TRANSLATIONS ────────────────────────
//
// The objection: "the material stack means two registries of material rules, and they
// will drift." The answer is structural. There is exactly ONE function that decides
// which fields an override writes — `resolveMaterialOverrideFields` — and every place
// that merges a material delegates to it and only translates vocabulary around it:
//
//   composeMaterial.ts          IR → IR              (the data lane, the operator stack)
//   resolveMaterialFieldOwner   IR → ownership       (which layer OWNS each field)
//   SceneFromDAG.tsx            live THREE.Material  (the glTF road, merging onto a clone)
//
// The third is the one that looks like a violation and is not: it merges onto a cloned
// `THREE.Material`, where there is no IR to compose, so it CANNOT route through
// `composeMaterial` — but it does not re-answer "may this scalar be written" either. It
// asks the same function and translates the answer into three.js property writes. That
// is the shape this gate protects: N translations of ONE decision, never N decisions.
//
// So "exactly one composition function" is pinned in the only form that is both true and
// falsifiable: the importer set is closed, AND no module re-implements the decision.
//
// ── GATE 2: THE IR AND THE OUTBOUND ADAPTER DO NOT KNOW ABOUT three.js ──────────────
//
// Today this is a comment (V32: "the material model is a renderer-agnostic IR; the
// renderer is a compile target"). It is the single property that makes a second renderer
// backend — the v0.7 WebGPU/TSL road — a sibling adapter rather than a rewrite, and a
// comment does not survive one convenient import. One test converts it into a structural
// refusal, at a cost of nothing.
//
// REF: src/app/material/materialOverrideMerge.ts (the decision);
//      src/app/material/composeMaterial.ts (the IR translation);
//      src/app/material/openpbrToThree.ts (the outbound adapter);
//      PLAN.md S4 / PLAN-2-COMPOSABLE.md S4; docs/PERFORMANCE.md; issue #394.

import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const SRC = join(__dirname, '../..');

/** Every non-test source file under `src/`, as [repo-relative path, contents]. */
function sourceFiles(): [string, string][] {
  const out: [string, string][] = [];
  const walk = (dir: string, rel: string) => {
    for (const entry of readdirSync(dir)) {
      const abs = join(dir, entry);
      if (statSync(abs).isDirectory()) {
        walk(abs, `${rel}${entry}/`);
        continue;
      }
      if (!/\.tsx?$/.test(entry)) continue;
      if (/\.test\.tsx?$/.test(entry)) continue;
      out.push([`${rel}${entry}`, readFileSync(abs, 'utf8')]);
    }
  };
  walk(SRC, 'src/');
  return out;
}

describe('#394 S4 — one composition decision, translated N ways', () => {
  it('has exactly one set of modules importing the decision, and each is a known translation', () => {
    // A new importer is not forbidden — it is a RED that forces whoever adds it to say
    // which vocabulary it translates the decision into, here, in this list. That is the
    // point: the gate makes the second registry impossible to add silently, not
    // impossible to add.
    const importers = sourceFiles()
      .filter(([, src]) => /import\s*\{[^}]*resolveMaterialOverrideFields/.test(src))
      .map(([path]) => path)
      .sort();

    expect(importers).toEqual([
      // IR → IR. The data lane's operator stack folds through this one.
      'src/app/material/composeMaterial.ts',
      // IR → ownership. Answers "which layer owns this field", not "what is its value".
      'src/app/resolveMaterialFieldOwner.ts',
      // live THREE.Material. No IR exists to compose on the glTF road; it merges onto a
      // clone, and asks the SAME decision rather than re-deriving it.
      'src/viewport/SceneFromDAG.tsx',
    ]);
  });

  it('nothing re-implements the per-field write decision', () => {
    // A second spelling of the rule would have to combine the two things the decision
    // combines: whether the director AUTHORED a field, and whether a MAP defends it.
    // Either alone is innocent — `overrideDescriptor.ts` and `overrideSet.ts` both call
    // `isOverridden` generically for any node type with an authored set, and
    // `resolveMaterialFieldOwner.ts` handles map presence without deciding anything. It
    // is the conjunction that means "this module has its own opinion about material
    // composition".
    //
    // Deliberately NOT keyed to the branch's exact expression. The first version of this
    // gate matched `|| !maps.`, and #529's fix moved that branch into a switch — a tell
    // tied to a shape stops matching the moment the shape is refactored, and then reports
    // a clean sweep forever. The conjunction survives refactors of either half.
    const decides = (src: string) =>
      /isOverridden\(/.test(src) && /mapDefends|MaterialMapPresence|maps\.roughnessMap/.test(src);

    const offenders = sourceFiles()
      .filter(([path]) => path !== 'src/app/material/materialOverrideMerge.ts')
      .filter(([, src]) => decides(src))
      .map(([path]) => path);

    expect(offenders).toEqual([]);

    // Guard the guard: the pattern must actually match where the decision DOES live,
    // or this sweep is an empty assertion that would pass over a deleted rule.
    expect(decides(readFileSync(join(SRC, 'app/material/materialOverrideMerge.ts'), 'utf8'))).toBe(
      true,
    );
  });

  it('every caller STATES which layer sits below it — no regime is inherited', () => {
    // #529 was a regime chosen by default rather than stated. The authority argument is
    // required, but `tsconfig.app.json` excludes `*.test.ts`, so the compiler does not
    // enforce it where it is most likely to be dropped. This sweep does: every call to
    // the decision or to either composer must name its road on the same line or the next.
    const CALL = /(?:resolveMaterialOverrideFields|composeMaterial|composeBakedMaterial)\(/;
    const silent: string[] = [];
    for (const [path, src] of sourceFiles()) {
      if (path === 'src/app/material/composeMaterial.ts') continue; // it forwards a param
      if (path === 'src/app/material/materialOverrideMerge.ts') continue; // it defines it
      const lines = src.split('\n');
      lines.forEach((line, i) => {
        if (!CALL.test(line) || line.trimStart().startsWith('//')) return;
        // The argument may sit on the call line or within the next few, for a wrapped call.
        // Generous, because a well-commented call site puts its argument a dozen lines
        // below the opening paren — two of the four real ones do exactly that.
        const window = lines.slice(i, i + 20).join('\n');
        if (!/'(?:map-aware|authored-only)'/.test(window)) silent.push(`${path}:${i + 1}`);
      });
    }
    expect(silent).toEqual([]);
  });
});

describe('#394 S4 — the IR and the outbound adapter are renderer-agnostic (V32)', () => {
  // Closed on purpose, and the closure is the interesting half. `src/app/material/` also
  // holds `gltfMaterialToOpenpbr.ts`, `gltfMapOverlay.ts` and `attachMapFromFile.ts`,
  // which DO import three — correctly, because they translate INBOUND (a loaded
  // THREE.Material or texture becoming IR). That direction must stay allowed; it is the
  // IR itself and the OUTBOUND compile that must not know what they compile to. Sweeping
  // the whole directory would therefore assert something false.
  const RENDERER_AGNOSTIC = [
    'nodes/materialSchema.ts', // the IR + its hydrate seam
    'nodes/materialSocket.ts', // socket-supersedes-param, the resolution rule
    'app/material/composeMaterial.ts', // the fold
    'app/material/materialOverrideMerge.ts', // the decision
    'app/material/openpbrToThree.ts', // the outbound adapter — names three's fields, imports nothing
  ];

  it.each(RENDERER_AGNOSTIC)('%s imports nothing from three', (rel) => {
    // Reading the file also asserts it EXISTS: a rename or a move reds this list rather
    // than silently shrinking the set being guarded.
    const src = readFileSync(join(SRC, rel), 'utf8');
    expect(src).not.toMatch(/from ['"]three['"]/);
    expect(src).not.toMatch(/require\(['"]three['"]\)/);
  });

  it('guards the guard — the sweep really can see a three import', () => {
    // A positive control on a file that legitimately DOES import three. Without it, a
    // regex that matched nothing anywhere would pass all five cases above.
    const inbound = readFileSync(join(SRC, 'app/material/gltfMaterialToOpenpbr.ts'), 'utf8');
    expect(inbound).toMatch(/from ['"]three['"]/);
  });
});
