// The positive controls for `tools/gates/sourceFiles.ts` — the enumeration three structural
// censuses walk (#536 S3).
//
// Without these, three gates rest on a walk that nothing checks. A sweep returning nothing
// may simply not have been ABLE to look, so the question is never "did it find nothing" but
// "COULD it have found it". These live in one place and run once; the walk itself is a
// plain module in `tools/` so that importing it does not register tests into the importing
// suite (the header there carries that measurement).
//
// REF: tools/gates/sourceFiles.ts (the walk + why it lives where it does);
//      src/app/overlayIdentity.gate.test.ts, src/app/material/materialComposition.gate.test.ts,
//      src/app/registryDoors.gate.test.ts (the three consumers); issues #394, #536.

import { describe, expect, it } from 'vitest';
import { sourceFiles } from '../../tools/gates/sourceFiles';

describe('#536 S3 — the shared gate enumeration can see what it claims to sweep', () => {
  const files = sourceFiles();
  const paths = files.map(([p]) => p);

  it('descends past the top level and reaches every gated directory', () => {
    // One known file per directory the three gates actually assert over. A walk that
    // stopped descending would still return a plausible-looking list without these.
    expect(paths).toContain('src/app/geometryRegistry.ts');
    expect(paths).toContain('src/app/materialRegistry.ts');
    expect(paths).toContain('src/app/material/primitiveMaterialInputs.ts');
    expect(paths).toContain('src/viewport/SceneFromDAG.tsx');
    expect(paths).toContain('src/nodes/overlayChannels.ts');
  });

  it('includes .tsx, not only .ts', () => {
    // The renderer — the most gated module in the repo — is a .tsx. An extension filter
    // that dropped it would empty the interesting half of every census.
    expect(paths.some((p) => p.endsWith('.tsx'))).toBe(true);
  });

  it('excludes test files, which are not consumers', () => {
    expect(paths.some((p) => /\.test\.tsx?$/.test(p))).toBe(false);
    expect(paths).not.toContain('src/test-utils/sourceFiles.test.ts');
  });

  it('returns contents, not just paths', () => {
    // The gates match import clauses against these strings; empty contents would make every
    // importer set read as empty and every census pass vacuously.
    const [, contents] = files.find(([p]) => p === 'src/app/geometryRegistry.ts')!;
    expect(contents).toContain('export function');
  });

  it('sweeps a subject large enough to be a census at all', () => {
    // A floor, not an equality — an equality would red on every file added. This guards
    // against the walk quietly collapsing to a handful of files.
    expect(files.length).toBeGreaterThan(200);
  });
});
