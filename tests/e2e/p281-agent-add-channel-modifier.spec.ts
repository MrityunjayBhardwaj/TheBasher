// p281 (#281) — the AGENT authoring op for the channel F-Modifier stack.
// mutator.timeline.addChannelModifier, run through the SAME validate→propose→
// accept five-gate path the LLM uses (__basher_dispatchMutator →
// dispatchMutatorFromUI), adds a Noise to a flat X=5 position channel and the
// rendered box deviates off the clean curve; the same deviation shows on the
// read side (H40). FALSIFY: a modifier authored `muted` is present-but-inert →
// render stays byte-identical to the clean base (5). Proves the agent path end
// to end: spec → gates → ops → DAG → render, no LLM round.
import { expect, test } from './_fixtures';

interface W {
  __basher_dag: {
    getState: () => {
      state: { nodes: Record<string, { params: { modifiers?: unknown[] } }> };
      dispatchAtomic: (ops: unknown[], s?: string, l?: string) => void;
    };
  };
  __basher_dispatchMutator?: (
    name: string,
    spec: unknown,
    intent: string,
  ) => { ok: true } | { ok: false; reason: string };
  __basher_selection: { getState: () => { select: (id: string) => void } };
  __basher_time: { getState: () => { setTime: (s: number) => void } };
  __basher_mesh_world_position?: (id: string) => [number, number, number] | null;
  __basher_evaluated_transform?: (
    id: string,
    ctx?: { time: { frame: number; seconds: number; normalized: number } },
  ) => { position: [number, number, number] } | null;
}
const CH = 'p281_ch';

async function boot(page: import('@playwright/test').Page) {
  await page.goto('/');
  await page.evaluate(async () => {
    if (typeof navigator?.storage?.getDirectory === 'function') {
      const root = await navigator.storage.getDirectory();
      try {
        await root.removeEntry('basher', { recursive: true });
      } catch {
        /* ignore */
      }
    }
  });
  await page.reload();
  await expect(page.getByTestId('layout')).toBeVisible({ timeout: 10_000 });
  await page.waitForFunction(() => {
    const w = window as unknown as W;
    return Boolean(
      w.__basher_dag &&
      w.__basher_time &&
      w.__basher_mesh_world_position &&
      w.__basher_dispatchMutator,
    );
  });
  await page.waitForFunction(
    () => (window as unknown as W).__basher_mesh_world_position!('n_box') !== null,
  );
  // Flat position channel on n_box: X held at 5 across [0,2]. Base at t=1 is 5.
  await page.evaluate((ch) => {
    const w = window as unknown as W;
    w.__basher_dag.getState().dispatchAtomic(
      [
        {
          type: 'addNode',
          nodeId: ch,
          nodeType: 'KeyframeChannelVec3',
          params: {
            name: 'position',
            target: 'n_box',
            paramPath: 'position',
            keyframes: [
              { time: 0, value: [5, 0, 0], easing: 'linear' },
              { time: 2, value: [5, 0, 0], easing: 'linear' },
            ],
          },
        },
      ],
      'user',
      'p281-seed',
    );
    w.__basher_selection.getState().select(ch);
  }, CH);
  await page.evaluate(() => (window as unknown as W).__basher_time.getState().setTime(1));
  await page.waitForFunction(
    () => Math.abs((window as unknown as W).__basher_mesh_world_position!('n_box')![0] - 5) < 1e-6,
  );
}

async function renderX(page: import('@playwright/test').Page): Promise<number> {
  return (await page.evaluate(
    () => (window as unknown as W).__basher_mesh_world_position!('n_box')![0],
  ))!;
}
async function readX(page: import('@playwright/test').Page): Promise<number> {
  return (await page.evaluate(() => {
    const t = (window as unknown as W).__basher_evaluated_transform!('n_box', {
      time: { frame: 60, seconds: 1, normalized: 0 },
    });
    return t ? t.position[0] : NaN;
  }))!;
}

test('agent addChannelModifier(noise) deviates render off the clean curve; render == read', async ({
  page,
}) => {
  await boot(page);

  // Run the mutator through the real five-gate agent path.
  const result = await page.evaluate((ch) => {
    return (window as unknown as W).__basher_dispatchMutator!(
      'mutator.timeline.addChannelModifier',
      { channelId: ch, modifierType: 'noise', overrides: { strength: 3, offset: 10 } },
      'agent: jitter the box',
    );
  }, CH);
  expect(result.ok, result.ok ? '' : result.reason).toBe(true);

  // The agent path wrote exactly one modifier onto the channel.
  await expect
    .poll(async () =>
      page.evaluate(
        (ch) =>
          (window as unknown as W).__basher_dag.getState().state.nodes[ch].params.modifiers?.length,
        CH,
      ),
    )
    .toBe(1);

  // Base 5 + noise(∈[7,13]) → rendered X ∈ [12,18], deterministically off 5.
  await page.waitForFunction(
    () => (window as unknown as W).__basher_mesh_world_position!('n_box')![0] > 11,
  );
  const dRender = await renderX(page);
  const dRead = await readX(page);
  expect(dRender, 'noise deviates render off 5').toBeGreaterThan(11);
  expect(dRead, 'read deviates too').toBeGreaterThan(11);
  expect(dRender, 'render == read (H40)').toBeCloseTo(dRead, 3);
});

test('FALSIFY: agent authors a muted modifier → present-but-inert, render stays clean 5', async ({
  page,
}) => {
  await boot(page);

  const result = await page.evaluate((ch) => {
    return (window as unknown as W).__basher_dispatchMutator!(
      'mutator.timeline.addChannelModifier',
      { channelId: ch, modifierType: 'noise', overrides: { strength: 3, offset: 10, muted: true } },
      'agent: add a muted noise',
    );
  }, CH);
  expect(result.ok, result.ok ? '' : result.reason).toBe(true);

  // The modifier IS present (agent wrote it) …
  await expect
    .poll(async () =>
      page.evaluate(
        (ch) =>
          (window as unknown as W).__basher_dag.getState().state.nodes[ch].params.modifiers?.length,
        CH,
      ),
    )
    .toBe(1);
  // … but muted → the sampler is byte-identical to the clean base (5).
  expect(await renderX(page), 'muted modifier → clean 5 (falsify)').toBeCloseTo(5, 6);
});
