// #461 — addressing a split node's Object half by WHAT IT POSES, not by ordinal.
//
// Specs used to name the seed cube as "the first node of type `Object`", which was
// unambiguous only while the cube was the sole split kind in the default project.
// It no longer is: `src/core/project/default.ts` mints the light's `Object` (n_light)
// BEFORE the cube's (n_box), so the ordinal picker silently retargets — and it will
// retarget again for every kind the object↔data rollout splits (the camera's n_camera
// is minted first of all, so it will take the front of the list next).
//
// Neither of the usual detectors sees this: there is no retired-kind vocabulary for a
// grep to match, and nothing changes type for the compiler to flag. The only symptom is
// a spec quietly asserting about a node it did not mean to pick. So the ordinal form is
// replaced everywhere rather than patched where it happened to break.
//
// The shape below is the one the curve specs already settled on
// (tests/e2e/p321-curve-object.spec.ts:65).

import type { Page } from '@playwright/test';

interface SeedWin {
  __basher_dag: {
    getState: () => {
      state: {
        nodes: Record<string, { type: string; inputs?: { data?: { node?: string } } }>;
      };
    };
  };
}

/**
 * The id of the `Object` half posing a data node of `dataType`
 * (e.g. 'BoxData' → the seed cube's Object).
 *
 * Throws rather than returning null: a spec that cannot find its subject should fail
 * where the subject is looked up, not several assertions later on an `undefined`.
 */
export async function objectPosing(page: Page, dataType: string): Promise<string> {
  const id = await page.evaluate((wanted) => {
    const s = (window as unknown as SeedWin).__basher_dag.getState().state;
    return (
      Object.keys(s.nodes).find((k) => {
        const n = s.nodes[k];
        const d = n.inputs?.data?.node;
        return n.type === 'Object' && !!d && s.nodes[d]?.type === wanted;
      }) ?? null
    );
  }, dataType);
  if (!id) throw new Error(`no Object posing a ${dataType}`);
  return id;
}

/** The default project's seed cube — its `Object` (pose) half. */
export function seedCubeObjectId(page: Page): Promise<string> {
  return objectPosing(page, 'BoxData');
}
