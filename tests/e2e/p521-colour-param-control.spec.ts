// #521 — a bare hex colour param is AUTHORABLE, driven through the real Inspector and
// observed on the live three.js material.
//
// Before this, `ParamRow` chose a control from the param's RUNTIME VALUE, and a colour is a
// plain string — so `MaterialOverride.color` fell to the read-only span and a director could
// not set it at all. The swatch and hex inputs asserted below did not exist.
//
// 🔴 THE RENDERED COLOUR IS THE CLAIM, NOT THE INPUT'S VALUE, and the difference is the whole
// risk. Since #529 the data lane folds only what the director AUTHORED, so a control that
// dispatched a plain `setParam` would move the param, redraw its own swatch, and be discarded
// before it reached the material — passing every check that reads the input back. So the edit
// is verified on the mesh, and the authored bit is verified on the decorator.
//
// THE PROOF (on the default project's box):
//   (0) wire a MaterialOverride under the box, select it → the Inspector shows a colour
//       swatch + hex field, and the override dot is hollow.
//   (1) type a hex → the LIVE material's colour becomes it, and the dot fills.

import { test, expect } from './_fixtures';

interface Op {
  type: string;
  [k: string]: unknown;
}
interface BasherWindow {
  __basher_dag: {
    getState: () => {
      state: { nodes: Record<string, { type: string }> };
      dispatchAtomic: (ops: Op[], source?: string, label?: string) => void;
    };
  };
  __basher_selection?: { getState: () => { select: (id: string) => void } };
  __basher_three: {
    getState: () => {
      scene: { traverse: (f: (o: unknown) => void) => void } | null;
    };
  };
}

/** Every mesh colour in the live scene, read off the renderer rather than the store. */
async function meshColours(page: import('@playwright/test').Page): Promise<string[]> {
  return page.evaluate(() => {
    const w = window as unknown as BasherWindow;
    const out: string[] = [];
    w.__basher_three.getState().scene?.traverse((o) => {
      const m = o as {
        isMesh?: boolean;
        material?: { color?: { getHexString(): string } };
      };
      if (!m.isMesh || !m.material?.color) return;
      out.push(`#${m.material.color.getHexString()}`);
    });
    return out;
  });
}

test('#521 — a MaterialOverride colour is editable in the Inspector and reaches the material', async ({
  page,
}) => {
  // (0) Wire the override under the default box and select it.
  await page.goto('/');
  // The store is what the wiring below talks to, so wait for IT rather than for a paint —
  // an `evaluate` that runs a frame early reads `__basher_dag` as undefined.
  await page.waitForFunction(
    () => (window as unknown as { __basher_dag?: unknown }).__basher_dag !== undefined,
  );
  await page.evaluate(() => {
    const w = window as unknown as BasherWindow;
    const dag = w.__basher_dag.getState();
    dag.dispatchAtomic(
      [
        {
          type: 'disconnect',
          from: { node: 'n_box', socket: 'out' },
          to: { node: 'n_scene', socket: 'children' },
        },
        { type: 'addNode', nodeId: 'mo521', nodeType: 'MaterialOverride', params: {} },
        {
          type: 'connect',
          from: { node: 'n_box', socket: 'out' },
          to: { node: 'mo521', socket: 'target' },
        },
        {
          type: 'connect',
          from: { node: 'mo521', socket: 'out' },
          to: { node: 'n_scene', socket: 'children' },
        },
      ],
      'user',
      '#521 wire override',
    );
    w.__basher_selection!.getState().select('mo521');
  });

  await expect(page.getByTestId('inspector')).toBeVisible();

  // The material section, opened the way the sibling override specs open it.
  const sectionBody = page.getByTestId('inspector-section-body-material');
  if (!(await sectionBody.isVisible().catch(() => false))) {
    await page.getByTestId('inspector-section-toggle-material').click();
  }
  await expect(sectionBody).toBeVisible();

  // 🔑 THE CONTROLS EXIST. This is the half that was missing: before #521 the row rendered
  // `color  #ffffff` as text with no input in it at all.
  const swatch = page.getByTestId('inspector-color-mo521-color');
  const hex = page.getByTestId('inspector-colorhex-mo521-color');
  await expect(swatch).toBeVisible();
  await expect(hex).toBeVisible();
  // The emissive channel is the second one the issue names, and it is the same road.
  await expect(page.getByTestId('inspector-color-mo521-emissive')).toBeVisible();

  // 🔴 AND THERE IS DELIBERATELY NO OVERRIDE DOT HERE. `MaterialOverride`'s descriptor covers
  // only `roughness`/`metalness` — the fields whose authored bit changes behaviour by forcing a
  // scalar over a source map. Its colour is an ALWAYS-APPLIED tint with a map-identity default,
  // so a dot would imply an inherit-vs-override choice that does not exist. The write here is
  // therefore a plain `setParam`, and `dispatchOverrideValueEdit` correctly declines it.
  //
  // The bit DOES matter on the data-lane sibling `MaterialOverrideOp`, whose descriptor covers
  // all six; that pairing is pinned in `paramWidgetDeclaration.gate.test.ts` rather than here,
  // because it is a fact about the descriptor and the schema and needs no browser.
  await expect(page.getByTestId('inspector-override-dot-mo521-color')).toHaveCount(0);

  // (1) Type a hex through the REAL field.
  await hex.fill('#3366cc');
  await hex.blur();

  // …and observe it on the live material. Polled because the render walk is a frame behind
  // the store, and asserted as a SET so a second mesh appearing cannot be read as a pass.
  await expect
    .poll(async () => (await meshColours(page)).includes('#3366cc'), {
      message: 'the authored colour reaches the live material',
    })
    .toBe(true);
});
