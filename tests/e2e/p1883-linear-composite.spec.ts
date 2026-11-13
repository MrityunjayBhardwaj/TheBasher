// #1883 — the composite works in linear light, in half float, on the GPU. Falsifiable against
// the shipped `drawComposite` in a real browser:
//   - a 50% white layer over black reads linear mid-grey (188), not 128 (display-colour mixing);
//   - a float source above 1.0 keeps its value through the pass (float readback);
//   - an opaque normal layer drawn 1:1 is byte-identical to its source (old comps unchanged);
//   - a step between layers adjusts the layer under it but not the comp background;
//   - the viewer's frame equals the export's (`captureCompositeFrame`), on the GPU path AND on
//     the 2D fallback, and the fallback says so.
// Drop the sRGB decode or encode, the float buffer, or the background ordering, and a number
// below moves.

import { expect, test } from './_fixtures';

test('the pass blends in linear light, keeps float, and leaves 1:1 opaque layers unchanged', async ({
  page,
}) => {
  await page.goto('/');
  await expect(page.getByTestId('menu-file-button')).toBeVisible();
  const r = await page.evaluate(async () => {
    const C = await import('/src/app/video/composite.ts');
    const G = await import('/src/app/video/gpuComposite.ts');
    const solid = async (w: number, h: number, css: string, alpha = 1) => {
      const c = document.createElement('canvas');
      c.width = w;
      c.height = h;
      const x = c.getContext('2d')!;
      x.globalAlpha = alpha;
      x.fillStyle = css;
      x.fillRect(0, 0, w, h);
      return createImageBitmap(c);
    };
    const src = (path: string, w: number, h: number) => ({
      kind: 'media' as const,
      path,
      mediaKind: 'image' as const,
      width: w,
      height: h,
      srcFps: 1,
      srcFrames: 1,
    });
    const layerDraw = (path: string, w: number, h: number, over: Record<string, unknown> = {}) => ({
      layerId: path,
      source: src(path, w, h),
      sourceFrameIndex: 0,
      opacity: 1,
      rotation: 0,
      position: [0, 0] as [number, number],
      scale: [1, 1] as [number, number],
      blendMode: 'normal' as const,
      effects: [],
      ...over,
    });
    const out = document.createElement('canvas');
    const ctx = out.getContext('2d')!;
    const px = (x: number, y: number) => Array.from(ctx.getImageData(x, y, 1, 1).data);
    const res: Record<string, unknown> = {};

    // 1. 50% white over black.
    out.width = 64;
    out.height = 64;
    const bm = new Map<string, ImageBitmap>([
      ['white#0', await solid(64, 64, '#ffffff')],
      ['black#0', await solid(64, 64, '#000000')],
    ]);
    res.path = C.drawComposite(
      ctx,
      { width: 64, height: 64, background: '' },
      [layerDraw('black', 64, 64), layerDraw('white', 64, 64, { opacity: 0.5 })] as never,
      bm,
    );
    res.halfWhiteOverBlack = px(32, 32);

    // 2. A float source above 1.0 keeps it, read back as float.
    const data = new Float32Array(16 * 16 * 4);
    for (let i = 0; i < data.length; i += 4) data.set([4, 2.5, 0.25, 1], i);
    const lin = { kind: 'linear' as const, width: 16, height: 16, data };
    out.width = 16;
    out.height = 16;
    C.drawComposite(
      ctx,
      { width: 16, height: 16, background: '#000000' },
      [layerDraw('hdr', 16, 16)] as never,
      new Map([['hdr#0', lin]]) as never,
    );
    res.floatReadback = G.gpuCompositor()!.readLinear(8, 8);
    res.floatDisplay = px(8, 8);

    // 3. An opaque normal layer at 1:1 matches the 2D canvas byte for byte (gradient image).
    const gw = 256;
    const g = document.createElement('canvas');
    g.width = gw;
    g.height = 4;
    const gx = g.getContext('2d')!;
    for (let i = 0; i < gw; i++) {
      gx.fillStyle = `rgb(${i},${255 - i},${(i * 7) % 256})`;
      gx.fillRect(i, 0, 1, 4);
    }
    const gb = await createImageBitmap(g);
    out.width = gw;
    out.height = 4;
    C.drawComposite(
      ctx,
      { width: gw, height: 4, background: '#202020' },
      [layerDraw('grad', gw, 4)] as never,
      new Map([['grad#0', gb]]),
    );
    const gpuRow = Array.from(ctx.getImageData(0, 2, gw, 1).data);
    const refRow = Array.from(gx.getImageData(0, 2, gw, 1).data);
    let maxDiff = 0;
    for (let i = 0; i < gpuRow.length; i++)
      maxDiff = Math.max(maxDiff, Math.abs(gpuRow[i] - refRow[i]));
    res.oneToOneMaxDiff = maxDiff;

    // 4. Background is not adjusted; a step adjusts the layer below it.
    out.width = 64;
    out.height = 64;
    const half = await solid(64, 64, '#ffffff');
    C.drawComposite(
      ctx,
      { width: 64, height: 64, background: '#000000' },
      [
        layerDraw('w', 64, 64, { scale: [0.5, 0.5] }),
        {
          kind: 'adjust',
          nodeId: 'cc',
          effects: [{ type: 'ColorCorrect', brightness: 0, contrast: 0, saturation: 1 }],
        },
      ] as never,
      new Map([['w#0', half]]),
    );
    res.adjustedLayer = px(32, 32); // contrast 0 → everything to 18% grey (linear) = 118 sRGB
    res.background = px(2, 2); // not adjusted: still black
    return res;
  });
  expect(r.path).toBe('gpu');
  expect(r.halfWhiteOverBlack).toEqual([188, 188, 188, 255]);
  expect(r.floatReadback).toEqual([4, 2.5, 0.25, 1]);
  expect(r.floatDisplay).toEqual([255, 255, 137, 255]);
  expect(r.oneToOneMaxDiff).toBe(0);
  expect(r.adjustedLayer).toEqual([118, 118, 118, 255]);
  expect(r.background).toEqual([0, 0, 0, 255]);
});

async function setup(page: import('@playwright/test').Page) {
  await page.goto('/');
  await expect(page.getByTestId('menu-file-button')).toBeVisible();
  await page.getByTestId('space-switch-video').click();
  await page.getByTestId('video-mode-new-comp').click();
  for (const n of [1, 2]) {
    await page.getByTestId('video-mode-add-layer').click();
    const [chooser] = await Promise.all([
      page.waitForEvent('filechooser'),
      page.getByTestId('video-mode-add-media').click(),
    ]);
    await chooser.setFiles('public/fixtures/multifile/flat/texture.png');
    await expect(page.getByTestId('video-mode-layer-count')).toHaveText(
      `${n} layer${n > 1 ? 's' : ''}`,
      { timeout: 8000 },
    );
  }
  // Front layer: half opacity, screen, shifted, rotated — exercise blend + transform.
  await page.evaluate(async () => {
    const vl = await import('/src/app/video/videoLayers.ts');
    type S = {
      nodes: Record<string, { type: string; id: string; params: Record<string, unknown> }>;
    };
    const store = (
      window as unknown as {
        __basher_dag: { getState(): { state: S; dispatchAtomic(o: unknown[]): void } };
      }
    ).__basher_dag;
    const s = store.getState().state;
    const comp = Object.values(s.nodes).find((n) => n.type === 'Composition')!.id;
    const front = vl.compositionLayerIds(s as never, comp)[1];
    store.getState().dispatchAtomic([
      { type: 'setParam', nodeId: front, paramPath: 'opacity', value: 0.5 },
      { type: 'setParam', nodeId: front, paramPath: 'blendMode', value: 'screen' },
      {
        type: 'setParam',
        nodeId: front,
        paramPath: 'transform',
        value: { position: [200, 30], rotation: 20, scale: [0.6, 0.6] },
      },
    ]);
  });
  await page.waitForTimeout(1500);
}

async function compare(page: import('@playwright/test').Page) {
  return page.evaluate(async () => {
    const D = await import('/src/app/video/compositeDecode.ts');
    type S = {
      nodes: Record<string, { type: string; id: string; params: Record<string, unknown> }>;
    };
    const state = (
      window as unknown as { __basher_dag: { getState(): { state: S } } }
    ).__basher_dag.getState().state;
    const comp = Object.values(state.nodes).find((n) => n.type === 'Composition')!;
    const viewer = document.querySelector('[data-testid="composite-canvas"]') as HTMLCanvasElement;
    const v = viewer.getContext('2d')!.getImageData(0, 0, viewer.width, viewer.height).data;
    const out = document.createElement('canvas');
    out.width = viewer.width;
    out.height = viewer.height;
    const ctx = out.getContext('2d')!;
    await D.captureCompositeFrame(state as never, comp.id, comp.params as never, 0, ctx);
    const e = ctx.getImageData(0, 0, out.width, out.height).data;
    let diff = 0,
      n = 0;
    for (let i = 0; i < v.length; i++)
      if (v[i] !== e[i]) {
        n++;
        diff = Math.max(diff, Math.abs(v[i] - e[i]));
      }
    const mid = Array.from(
      v.slice((360 * viewer.width + 640) * 4, (360 * viewer.width + 640) * 4 + 4),
    );
    return {
      path: viewer.getAttribute('data-composite-path'),
      bytes: v.length,
      differing: n,
      maxDiff: diff,
      mid,
    };
  });
}

test('the viewer and the export draw the same frame on the GPU', async ({ page }) => {
  await setup(page);
  const r = await compare(page);
  expect(r.path).toBe('gpu');
  expect(r.differing).toBe(0);
});

test('without WebGL2 the composite falls back to the 2D canvas, and says so', async ({ page }) => {
  await page.addInitScript(() => {
    const orig = HTMLCanvasElement.prototype.getContext;
    // Only canvases outside the DOM (the compositor's own) lose webgl2; the 3D view keeps it.
    HTMLCanvasElement.prototype.getContext = function (
      this: HTMLCanvasElement,
      type: string,
      ...a: unknown[]
    ) {
      if (type === 'webgl2' && !this.isConnected) return null;
      return (orig as (...x: unknown[]) => unknown).call(this, type, ...a);
    } as typeof orig;
  });
  const warns: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'warning' && m.text().includes('[composite]')) warns.push(m.text());
  });
  await setup(page);
  const r = await compare(page);
  expect(r.path).toBe('2d');
  expect(r.differing).toBe(0);
  expect(warns.join('\n')).toContain('WebGL2 is not available');
});
