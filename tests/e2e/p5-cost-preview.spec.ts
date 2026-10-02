// P5 Wave C5 — CostPreview e2e under StubComfyUICapability.
//
// Drives the goal-backward target for the offline path through the UI:
// build a ComfyUIWorkflow node with the standard upstream graph, select
// it so the Inspector embeds <CostPreview />, click Estimate (probe
// frame writes one PNG to OPFS at the D-04 path), confirm frames count
// + sample frame appear, click Submit (runWorkflow seam dispatches per-
// frame setParam Ops), watch the progress bar advance to N/N.
//
// Stub capability is installed via the dev-only window helper so the
// spec does not depend on a running ComfyUI server. The same flow lights
// up against the real server in Wave D4 — only the capability swaps.

import { test, expect } from './_fixtures';
import { objectPosing } from './_seedNodes';

interface StubComfyWindow {
  __basher_useStubComfy?: () => void;
  __basher_writeOpfsBytes?: (path: string, bytes: Uint8Array) => Promise<void>;
  __basher_dag?: {
    getState: () => {
      state: { nodes: Record<string, { type: string; params?: Record<string, unknown> }> };
      dispatch: (op: unknown, source?: string, label?: string) => void;
      dispatchAtomic: (ops: unknown[], source?: string, label?: string) => void;
    };
  };
  __basher_selection?: {
    getState: () => { select: (id: string | null) => void };
  };
}

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await page.evaluate(async () => {
    if (typeof navigator?.storage?.getDirectory === 'function') {
      const root = await navigator.storage.getDirectory();
      try {
        await root.removeEntry('basher', { recursive: true });
      } catch {
        /* not present */
      }
    }
  });
  await page.reload();
  await expect(page.getByTestId('layout')).toBeVisible({ timeout: 10_000 });
  await page.waitForFunction(() => {
    const w = window as unknown as StubComfyWindow;
    return Boolean(w.__basher_dag && w.__basher_selection && w.__basher_useStubComfy);
  });
  // Swap in the deterministic stub capability — no ComfyUI server needed.
  await page.evaluate(() => {
    const w = window as unknown as StubComfyWindow;
    w.__basher_useStubComfy!();
  });
});

async function seedWorkflowGraph(page: import('@playwright/test').Page, frameEnd = 2) {
  // #387 C4 — the camera is no longer a node of type `PerspectiveCamera`; it is an
  // `Object` posing a `CameraData`. Found by possession here, and resolved outside the
  // page callback because that is where the shared helper lives. The old type lookup
  // returned undefined and the seed threw before any of this spec's real subject —
  // the ComfyUI cost preview — was reached.
  const seedCamId = await objectPosing(page, 'CameraData');
  await page.evaluate(
    async ({ end, seedCamId: camIdIn }) => {
      const w = window as unknown as StubComfyWindow;
      const dag = w.__basher_dag!.getState();
      const nodes = dag.state.nodes;
      const findOf = (t: string) => Object.entries(nodes).find(([, n]) => n.type === t)?.[0];
      const timeId = findOf('TimeSource');
      const camId = camIdIn;
      const sceneId = findOf('Scene');
      if (!timeId || !camId || !sceneId) {
        throw new Error(
          `seed scene missing time/cam/scene: time=${timeId} cam=${camId} scene=${sceneId}`,
        );
      }
      // Wire all three required upstream passes — stylizedRealism preset
      // mandates beauty + depth + normal. Match the addAIPass Mutator's
      // canonical wiring shape so the cost preview's compile() finds them.
      dag.dispatchAtomic(
        [
          {
            type: 'addNode',
            nodeId: 'p_test',
            nodeType: 'Prompt',
            params: { text: 'a stylized cube', negative: '', tags: [] },
          },
          {
            type: 'addNode',
            nodeId: 'beauty_test',
            nodeType: 'BeautyPass',
            params: {},
          },
          {
            type: 'addNode',
            nodeId: 'depth_test',
            nodeType: 'DepthPass',
            params: {},
          },
          {
            type: 'addNode',
            nodeId: 'normal_test',
            nodeType: 'NormalPass',
            params: {},
          },
          {
            type: 'addNode',
            nodeId: 'cw_test',
            nodeType: 'ComfyUIWorkflow',
            params: {
              presetId: 'stylizedRealism',
              frameStart: 0,
              frameEnd: end,
              lastGoodFrame: -1,
              outputPath: 'renders/cw_test/stylized_stylizedRealism',
            },
          },
          ...['beauty_test', 'depth_test', 'normal_test'].flatMap((passId) => [
            {
              type: 'connect',
              from: { node: sceneId, socket: 'out' },
              to: { node: passId, socket: 'scene' },
            },
            {
              type: 'connect',
              from: { node: camId, socket: 'out' },
              to: { node: passId, socket: 'camera' },
            },
            {
              type: 'connect',
              from: { node: timeId, socket: 'out' },
              to: { node: passId, socket: 'time' },
            },
            {
              type: 'connect',
              from: { node: passId, socket: 'out' },
              to: { node: 'cw_test', socket: 'pass-input' },
            },
          ]),
          {
            type: 'connect',
            from: { node: 'p_test', socket: 'out' },
            to: { node: 'cw_test', socket: 'prompt' },
          },
          {
            type: 'connect',
            from: { node: timeId, socket: 'out' },
            to: { node: 'cw_test', socket: 'time' },
          },
        ],
        'user',
        'p5-c5-e2e seed',
      );

      // Pre-populate raw pass bytes at the D-04 paths the preset's compile()
      // reads. Production produces these via runRenderJob; for the cost-
      // preview spec we only need bytes that exist (content is not asserted
      // by the stub capability beyond hashing).
      //
      // Path formula matches stylizedRealism.rawPassPath:
      //   `renders/cw_test/${passKind}_NNNN.png`
      // dryRun probes frame 0 of frameStart..frameEnd, so frame 0000 must
      // exist for all three required passes.
      const fakeBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
      // Submit (C5.3) iterates frames 0..frameEnd; each frame's compile()
      // reads raw passes at THAT frame's path. Seed all frames in range.
      for (let f = 0; f <= end; f++) {
        const padded = f.toString().padStart(4, '0');
        for (const kind of ['beauty', 'depth', 'normal']) {
          await w.__basher_writeOpfsBytes!(`renders/cw_test/${kind}_${padded}.png`, fakeBytes);
        }
      }

      w.__basher_selection!.getState().select('cw_test');
    },
    { end: frameEnd, seedCamId },
  );
}

/**
 * How long a storage-bound step may take: a share of the test's own budget, not a fixed time.
 *
 * #543 — these steps are not slow by a fixed amount. Inside the app one OPFS call costs one render
 * frame (measured: 18.1 ms per call against an 18 ms frame; 0.1 ms on a bare page of the same
 * origin), and `OpfsStorage` makes several calls per operation. So Estimate takes about 60 render
 * frames and a 3-frame Submit about 120, whatever a frame costs. Headless Chromium draws with
 * software GL, and on a CI runner a frame is ~125–150 ms, which put Submit past the fixed 15 s it
 * had while `test.slow()` raised only the test's total. The fixed waits passed or failed on the
 * runner's frame rate, not on the cost preview.
 *
 * `test.info().timeout` already carries `test.slow()` and the CI multiplier, so the step's wait
 * follows the same budget the test was given.
 */
const stepBudget = (share: number) => Math.floor(test.info().timeout * share);
/** Estimate is about a third of the work of Estimate + a 3-frame Submit; Submit the other two. */
const ESTIMATE_SHARE = 1 / 4;
const SUBMIT_SHARE = 1 / 2;

test('P5#C5.1 selecting a ComfyUIWorkflow node embeds CostPreview in Inspector', async ({
  page,
}) => {
  await seedWorkflowGraph(page);
  await expect(page.getByTestId('cost-preview')).toBeVisible({ timeout: 5_000 });
  await expect(page.getByTestId('cost-preview-estimate')).toBeVisible();
  // Submit is gated on dryRun completion — disabled before Estimate runs.
  await expect(page.getByTestId('cost-preview-submit')).toBeDisabled();
});

test('P5#C5.2 Estimate populates frames + estimated time + sample frame', async ({ page }) => {
  // Legitimately slow: OPFS probe-write + dryRun estimate extrapolation.
  // Same known-slow (not flaky) class as C5.3 below — under the full e2e
  // suite (workers:1) CI contention pushes this past the 30s per-test cap.
  // test.slow() triples the budget — the Playwright-idiomatic mechanism.
  test.slow();
  await seedWorkflowGraph(page, 4);
  await page.getByTestId('cost-preview-estimate').click();
  // dryRun extrapolates frameEnd-frameStart+1 = 5.
  await expect(page.getByTestId('cost-preview-frames')).toHaveText('5', {
    timeout: stepBudget(ESTIMATE_SHARE),
  });
  await expect(page.getByTestId('cost-preview-est-seconds')).toBeVisible();
  // Sample frame OR sample-missing fallback — both acceptable; one must appear.
  const sample = page.getByTestId('cost-preview-sample');
  const missing = page.getByTestId('cost-preview-sample-missing');
  await expect(sample.or(missing)).toBeVisible();
  // Submit becomes enabled after dryRun.
  await expect(page.getByTestId('cost-preview-submit')).toBeEnabled();
});

test('P5#C5.3 Submit runs the workflow and progress bar advances to N/N', async ({ page }) => {
  // Legitimately slow, and by an amount set by the frame rate: see `stepBudget` (#543).
  // test.slow() triples the test's budget, and each step below takes its share of that.
  test.slow();
  await seedWorkflowGraph(page, 2);
  await page.getByTestId('cost-preview-estimate').click();
  await expect(page.getByTestId('cost-preview-frames')).toHaveText('3', {
    timeout: stepBudget(ESTIMATE_SHARE),
  });
  await page.getByTestId('cost-preview-submit').click();
  // The seam dispatches setParam(lastGoodFrame) per frame; the bar text
  // reflects framesDone/total. Final state: 3/3.
  await expect(page.getByTestId('cost-preview-progress-text')).toHaveText('3/3', {
    timeout: stepBudget(SUBMIT_SHARE),
  });
});
