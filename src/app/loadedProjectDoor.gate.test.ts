// Every LOADED project reaches the DAG store through `hydrateLoadedProject`, which refuses one that
// holds an import saved on the old imported-file structure (#1424; before that it converted them,
// #1216). A loader that hydrates on its own would put such an import in the editor, where nothing
// draws it. This census reads boot.ts and fails on a hydrate of anything but a freshly built seed
// outside that one function, on a loader that never calls it, and on a door that hydrates before
// it refuses.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/** The name of the function each match sits in: the nearest `function NAME(` above it. */
function enclosingFunctions(source: string, pattern: RegExp): string[] {
  const out: string[] = [];
  for (const match of source.matchAll(pattern)) {
    const before = source.slice(0, match.index);
    const names = [...before.matchAll(/function\s+(\w+)\s*\(/g)];
    out.push(names.length > 0 ? names[names.length - 1][1] : '<top>');
  }
  return out;
}

/** Functions that hydrate something other than a freshly built seed, outside the one door. */
function strayHydrates(source: string): string[] {
  const out: string[] = [];
  for (const match of source.matchAll(/\.hydrate\(([^)]*)/g)) {
    const [fn] = enclosingFunctions(source.slice(0, match.index! + 1), /\.$/g);
    const arg = match[1].trim();
    if (fn === 'hydrateLoadedProject') continue;
    if (arg.startsWith('buildDefaultDagState(')) continue;
    // A seed built in the same function: `seed.state` / a project the function composed itself.
    const body = source.slice(source.lastIndexOf(`function ${fn}(`), match.index);
    if (
      /buildDefaultProject\(\)/.test(body) &&
      !/loadProject\(|bundleToProject\(|ioDuplicateProject\(/.test(body)
    )
      continue;
    out.push(fn);
  }
  return out;
}

/** Functions that load or unbundle a project and never hand it to the one door. */
function loadersSkippingTheDoor(source: string): string[] {
  const loaders = new Set(
    enclosingFunctions(source, /\b(loadProject|bundleToProject|ioDuplicateProject)\(/g),
  );
  return [...loaders].filter((fn) => {
    const start = source.lastIndexOf(`function ${fn}(`);
    const next = source.indexOf('\nexport ', start + 1);
    const body = source.slice(start, next === -1 ? undefined : next);
    return !/hydrateLoadedProject\(/.test(body);
  });
}

const BOOT = readFileSync('src/app/boot.ts', 'utf8');

describe('a loaded project reaches the store only through hydrateLoadedProject', () => {
  it('boot.ts: no stray hydrate, and every loader calls the door', () => {
    expect(strayHydrates(BOOT)).toEqual([]);
    expect(loadersSkippingTheDoor(BOOT)).toEqual([]);
    // The loaders the census found — so a rename that hides one from it shows here.
    expect(
      new Set(enclosingFunctions(BOOT, /\b(loadProject|bundleToProject|ioDuplicateProject)\(/g)),
    ).toEqual(new Set(['boot', 'switchProject', 'duplicateCurrentProject', 'importSceneBundle']));
  });

  it('the door refuses before it hydrates, and nothing is remembered before the door', () => {
    const start = BOOT.indexOf('function hydrateLoadedProject(');
    const door = BOOT.slice(start, BOOT.indexOf('\n}\n', start));
    expect(door.indexOf('refuseOldImports(')).toBeGreaterThan(-1);
    expect(door.indexOf('refuseOldImports(')).toBeLessThan(door.indexOf('.hydrate('));
    expect(door.indexOf('refuseOldImports(')).toBeLessThan(door.indexOf('setCurrent('));
    // A refused project must not become the one the next boot resumes: every function that both
    // goes through the door and remembers the project does so in that order.
    const remembersFirst = [...BOOT.matchAll(/\n(?:export )?(?:async )?function (\w+)\(/g)]
      .map((m) => {
        const from = m.index!;
        const next = BOOT.indexOf('\nexport ', from + 1);
        const body = BOOT.slice(from, next === -1 ? undefined : next);
        const doorAt = body.indexOf('hydrateLoadedProject(');
        const rememberAt = body.indexOf('persistLastProjectId(project.id)');
        return doorAt > -1 && rememberAt > -1 && rememberAt < doorAt ? m[1] : null;
      })
      .filter(Boolean);
    expect(remembersFirst).toEqual([]);
  });

  it('control: a loader hydrating on its own is caught', () => {
    const bad = `export async function switchProject(id) {
  const project = await loadProject(storage, id);
  useDagStore.getState().hydrate({ nodes: project.state.nodes });
}`;
    expect(strayHydrates(bad)).toEqual(['switchProject']);
    expect(loadersSkippingTheDoor(bad)).toEqual(['switchProject']);
  });
});
