// v0.6 #2 (#178) W3 — the NPanel lobe-grouped material editor (replaces the
// `(complex — Pro mode)` placeholder, NPanel:636). A scalar edit AND a colour
// edit, driven through the REAL inspector controls, LAND on the REAL three.js
// material (side-A via __basher_mesh_material). Falsifiable: if the editor stops
// dispatching setParam (or the renderer stops reading the IR) the assertions go
// RED.

import { expect, test } from './_fixtures';

interface MeshMaterial {
  color: string | null;
  roughness: number | null;
}
interface BasherWindow {
  __basher_selection?: { getState: () => { select: (id: string) => void } };
  __basher_mesh_material?: (nodeId: string) => MeshMaterial | null;
  __basher_dag?: {
    getState: () => {
      undoStack: unknown[];
      undo: () => void;
      state: { nodes: Record<string, { params?: Record<string, unknown> }> };
    };
  };
}

test.describe('v0.6 #2 W3 — NPanel material editor lands on the real material', () => {
  test('scalar (roughness) + colour (base.color) edits reach the real three.js material', async ({
    page,
  }) => {
    await page.goto('/');
    await page.waitForFunction(() => {
      const w = window as unknown as BasherWindow;
      return Boolean(w.__basher_selection) && typeof w.__basher_mesh_material === 'function';
    });
    // Select the default box → the Inspector shows its material section.
    await page.evaluate(() => {
      (window as unknown as BasherWindow).__basher_selection!.getState().select('n_box');
    });
    await expect(page.getByTestId('inspector')).toBeVisible();

    // Expand the material section if collapsed (clicking an open one would close it).
    const editor = page.getByTestId('inspector-material-editor-n_box');
    if (!(await editor.isVisible())) {
      await page.getByTestId('inspector-section-toggle-material').click();
    }
    await expect(editor).toBeVisible(); // the placeholder (complex) is GONE

    // --- scalar: specular.roughness → 0.8 ---
    const roughness = page.getByTestId('inspector-input-n_box-material.specular.roughness');
    await expect(roughness).toBeVisible();
    await roughness.fill('0.8');
    await roughness.press('Tab');
    await page.waitForFunction(() => {
      const w = window as unknown as BasherWindow;
      const m = w.__basher_mesh_material!('n_box');
      return m != null && Math.abs((m.roughness ?? -1) - 0.8) < 1e-3;
    });

    // --- colour: base.color → #ff8800 (via the hex input, commit on blur) ---
    const hex = page.getByTestId('inspector-colorhex-n_box-material.base.color');
    await expect(hex).toBeVisible();
    await hex.fill('#ff8800');
    await hex.press('Enter');
    await page.waitForFunction(() => {
      const w = window as unknown as BasherWindow;
      const m = w.__basher_mesh_material!('n_box');
      return m != null && (m.color ?? '').toLowerCase() === '#ff8800';
    });

    const finalMat = await page.evaluate(() => {
      const w = window as unknown as BasherWindow;
      return w.__basher_mesh_material!('n_box');
    });
    console.log(`[p06-2 editor] ${JSON.stringify(finalMat)}`);
    // Side-A = the REAL three.js material (not the resolver). H40 boundary-pair.
    expect(finalMat!.roughness).toBeCloseTo(0.8, 3);
    expect(finalMat!.color?.toLowerCase()).toBe('#ff8800');
  });

  test('#239 — a colour-picker drag is ONE undo entry; one undo restores (H131/V84)', async ({
    page,
  }) => {
    // A native <input type=color> fires onChange (DOM `input`) on EVERY tick while
    // the user drags inside the OS picker. Without a picker-session bracket each
    // tick is its own undo entry (the H131 leak); the begin-on-first-onChange /
    // flush-on-blur bracket collapses the gesture into ONE AtomicGroup.
    await page.goto('/');
    await page.waitForFunction(() => {
      const w = window as unknown as BasherWindow;
      return Boolean(w.__basher_selection) && Boolean(w.__basher_dag);
    });
    await page.evaluate(() =>
      (window as unknown as BasherWindow).__basher_selection!.getState().select('n_box'),
    );
    await expect(page.getByTestId('inspector')).toBeVisible();
    const editor = page.getByTestId('inspector-material-editor-n_box');
    if (!(await editor.isVisible())) {
      await page.getByTestId('inspector-section-toggle-material').click();
    }
    const swatch = page.getByTestId('inspector-color-n_box-material.base.color');
    await expect(swatch).toBeVisible();

    const matBefore = await page.evaluate(
      () =>
        (window as unknown as BasherWindow).__basher_dag!.getState().state.nodes['n_box']?.params
          ?.material,
    );
    const undoBefore = await page.evaluate(
      () => (window as unknown as BasherWindow).__basher_dag!.getState().undoStack.length,
    );

    // Simulate a picker drag: 6 `input` ticks with changing hex, then `focusout`
    // (React's onBlur fires on the bubbling focusout — the picker has closed).
    const handle = await swatch.elementHandle();
    await page.evaluate((el) => {
      const input = el as HTMLInputElement;
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
      for (const hex of ['#ff0000', '#ee1100', '#dd2200', '#cc3300', '#bb4400', '#aa5500']) {
        setter.call(input, hex);
        input.dispatchEvent(new Event('input', { bubbles: true }));
      }
      input.dispatchEvent(new Event('focusout', { bubbles: true }));
    }, handle);

    // ONE undo entry for the whole 6-tick gesture (not 6).
    const undoAfter = await page.evaluate(
      () => (window as unknown as BasherWindow).__basher_dag!.getState().undoStack.length,
    );
    expect(undoAfter - undoBefore).toBe(1);

    // A single undo restores the pre-drag material exactly.
    await page.evaluate(() => (window as unknown as BasherWindow).__basher_dag!.getState().undo());
    const matUndone = await page.evaluate(
      () =>
        (window as unknown as BasherWindow).__basher_dag!.getState().state.nodes['n_box']?.params
          ?.material,
    );
    expect(JSON.stringify(matUndone)).toBe(JSON.stringify(matBefore));
  });
});
