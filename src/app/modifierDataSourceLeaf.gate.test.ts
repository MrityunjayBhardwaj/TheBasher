// ns-2 (#660) — the ONE `ObjectData` classifier lives in a LEAF, and there is one door to it.
//
// ── WHY THIS GATE EXISTS ──────────────────────────────────────────────────────────────
//
// ns-2 step 9b resolves a component selection inside the DAG evaluator, so the evaluator
// reaches the resolver and the resolver asks `modifierDataSource` which `ObjectData`
// members carry components at all. While that function lived in `modifierGeometry.ts` the
// road closed on itself — `modifierGeometry.ts` imports `evaluate` — and an import cycle is
// exactly the kind of property that costs nothing today and is discovered by a later
// refactor. The move is only worth something while the leaf STAYS a leaf.
//
// The second property is the one this project has paid for three times: a second spelling
// that agrees today. The alternative to the move was the resolver minting its own switch
// over `ObjectData.kind` with a cross-check. `modifierDataSource`'s own doc records that
// its SceneObject-side twin was DELETED once it had no callers — *"There is no second
// answer to keep in step."* So the gate asserts there is ONE door, by census.
//
// REF: src/app/modifierDataSource.ts (the leaf); src/app/modifierGeometry.ts (what it left
//      behind, and the evaluator import that made the cycle real);
//      tools/gates/moduleShape.ts (the import parse and its stated limits);
//      src/app/faceCountLeaf.gate.test.ts (the sibling leaf, same gate, same reason).

import { describe, expect, it } from 'vitest';
import { importsOf } from '../../tools/gates/moduleShape';
import { sourceFiles } from '../../tools/gates/sourceFiles';
import { stripComments } from '../test-utils/sourceScan';

describe('#660 the ObjectData classifier is a leaf', () => {
  it('imports exactly one module — the types it takes and returns', () => {
    // If this grows, say why in the same commit: whatever the new import drags in becomes
    // reachable from the evaluator, which is the edge the move exists to prevent.
    expect(importsOf('src/app/modifierDataSource.ts')).toEqual(['../nodes/types']);
  });

  it('and the module it LEFT still imports the evaluator — which is why it had to leave', () => {
    // The reason, checked rather than stated. This is the edge that made
    // `evaluator -> componentSelection -> modifierGeometry -> evaluator` a cycle. If this
    // ever stops being true the leaf is still fine, but the paragraph above is not, and a
    // reason nobody re-reads is how a split becomes cargo cult.
    expect(importsOf('src/app/modifierGeometry.ts')).toContain('../core/dag/evaluator');
  });

  it('is not re-exported by the module it left, so there is one spelling', () => {
    // A re-export would keep every old import path working and make the census below read
    // the same before and after — a door that is invisible to a path-based count.
    const left = stripComments(
      sourceFiles().find(([p]) => p === 'src/app/modifierGeometry.ts')![1],
    );
    expect(left).not.toMatch(/export\s*\{[^}]*modifierDataSource/);
    expect(left).not.toMatch(/export\s+\*\s+from\s+'\.\/modifierDataSource'/);
  });

  it('has exactly ONE import door, and every importer uses it', () => {
    // Census by SYMBOL, not by path: a module reaching the classifier through any other
    // specifier is the second door this gate exists to refuse. `examined` is reported
    // beside `found`, because a zero with no denominator cannot be told from a walk that
    // never ran.
    const files = sourceFiles();
    const importers: string[] = [];
    const wrongDoor: string[] = [];
    for (const [path, src] of files) {
      if (path === 'src/app/modifierDataSource.ts') continue; // where it is defined
      const code = stripComments(src);
      const re = /import\s*\{[^}]*\bmodifierDataSource\b[^}]*\}\s*from\s*'([^']+)'/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(code)) !== null) {
        importers.push(path);
        if (!m[1].endsWith('/modifierDataSource')) wrongDoor.push(`${path} -> ${m[1]}`);
      }
    }

    expect({ examined: files.length, wrongDoor }).toEqual({
      examined: files.length,
      wrongDoor: [],
    });
    // A floor, not an exact count: the population GROWS (ns-2 adds the resolver). An exact
    // count here would red on the next honest consumer and teach the next reader to edit
    // the number rather than read the claim.
    // Seven production importers today: the six that consumed the classifier before the
    // move, plus `modifierGeometry.ts`, which kept `canModifyGeometry` and now asks the
    // leaf for the same answer. Tests are outside `sourceFiles()` and are not counted.
    expect(importers.length).toBeGreaterThanOrEqual(7);
    expect(files.length).toBeGreaterThan(500);
  });
});
