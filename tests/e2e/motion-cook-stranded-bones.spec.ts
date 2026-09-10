// #1001 — the observation. A director edits a bone, the clip is re-cooked under
// it, and the cook card in the REAL inspector names the bone left behind.
//
// The unit tier proves the read and proves the offer carries it. Neither can
// prove the card DRAWS it: this project has no React Testing Library (W2
// acceptance gate #15 forbids new external deps), so every decision that lives
// in JSX has e2e as its only witness — the same reason `generate-panel.spec.ts`
// exists one file over.
//
// 🔑 WHAT MAKES IT AN OBSERVATION AND NOT A SECOND UNIT ROW: the bone is edited
// through the product's own authoring road (`mutator.timeline.keyframe`, which
// is what mints the channel), the clip is moved by an ordinary op, and the
// assertion is on rendered text in the panel a director is looking at. Nothing
// here calls the staleness read.
//
// It needs no server beyond the app — no Kimodo, no OPFS, no paid call — so it
// can run in CI, unlike the headed motion road.
//
// REF: src/app/asset/MotionGenerateCookConnector.tsx (the card);
//      src/app/animate/clipSeedProvenance.ts (the read behind it); issue #1001.

import { test, expect } from './_fixtures';

const ASSET = 'e2e/stranded.glb';
const BONE = 'mixamorig_LeftArm';
const OTHER = 'mixamorig_Hips';
const PRODUCER = 'n_gen_stranded';
const CLIP = 'n_clip_stranded';

interface Op {
  type: string;
  [k: string]: unknown;
}
interface BasherWindow {
  __basher_dag: {
    getState: () => {
      state: { nodes: Record<string, { type: string; params?: Record<string, unknown> }> };
      dispatchAtomic: (ops: Op[], source?: string, label?: string) => void;
    };
  };
  __basher_selection?: { getState: () => { select: (id: string) => void } };
  __basher_dispatchMutator?: (
    name: string,
    spec: unknown,
    intent: string,
  ) => { ok: boolean; reason?: string };
}

/** A clip keyframe as an AnimationClip stores it — rotation in RADIANS. */
function key(bone: number, time: number, y: number) {
  return { bone, time, position: [0, y, 0], rotation: [0, 0, 0] };
}

/**
 * The scene a director is looking at when the damage is done: a character with a
 * generated clip, one bone edited through the product's own authoring road, the
 * producer selected so the inspector draws its cook card.
 *
 * ONE builder for both tests, because #1002's act is only meaningful on the
 * exact state #1001's signal reports — two spellings of this scene would let the
 * act be observed on a state the signal never describes.
 */
async function buildStrandedScene(page: import('@playwright/test').Page) {
  await page.goto('/');
  await expect(page.getByTestId('layout')).toBeVisible({ timeout: 10_000 });
  await page.waitForFunction(() => Boolean((window as unknown as BasherWindow).__basher_dag));

  // 1 — a character with a generated clip on it. Built through the op road so
  //     every node lands zod-parsed, which is also what proves the two
  //     provenance params are DECLARED: undeclared, they are stripped here and
  //     the card would stay silent for a reason no assertion could see.
  const built = await page.evaluate(
    async ({ asset, bone, other, producer, clip, firstKeys }) => {
      const ids = await import('/src/core/import/gltfImportChain.ts');
      const fx = await import('/src/test-utils/importedChildFixture.ts');
      const mg = await import('/src/nodes/MotionGenerate.ts');
      const w = window as unknown as BasherWindow;
      const producerParams = {
        name: '',
        prompt: 'a slow walk',
        seed: 7,
        model: 'kimodo-base',
      };
      const ops: Op[] = [
        {
          type: 'addNode',
          nodeId: 'n_asset_stranded',
          nodeType: 'GltfAsset',
          // The FULL skin shape, because this lands through the real schema:
          // `jointKeys` alone is what a hand-built unit table gets away with and
          // the product refuses. Identity bind matrices — nothing here renders.
          params: {
            assetRef: asset,
            skins: [
              {
                jointKeys: [other, bone],
                bindTRS: [other, bone].map(() => ({
                  position: [0, 0, 0],
                  rotation: [0, 0, 0],
                  scale: [1, 1, 1],
                })),
                parentJointIndex: [-1, 0],
                inverseBindMatrices: [other, bone].map(() => [
                  1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1,
                ]),
              },
            ],
          },
        },
        {
          type: 'addNode',
          nodeId: 'n_rig_stranded',
          nodeType: 'GltfSkeleton',
          params: { skinIndex: 0 },
        },
        {
          type: 'connect',
          from: { node: 'n_asset_stranded', socket: 'out' },
          to: { node: 'n_rig_stranded', socket: 'asset' },
        },
        { type: 'addNode', nodeId: producer, nodeType: 'MotionGenerate', params: producerParams },
        {
          type: 'addNode',
          nodeId: clip,
          nodeType: 'AnimationClip',
          params: {
            duration: 1,
            loop: 'hold',
            keyframes: firstKeys,
            // The producer's own current request hash, so the clip reads as
            // cooked AND up to date — the state in which the card lies.
            sourceHash: mg.motionRequestHash(
              mg.MotionGenerateParams.parse(producerParams),
              undefined,
            ),
          },
        },
        {
          type: 'connect',
          from: { node: 'n_rig_stranded', socket: 'out' },
          to: { node: clip, socket: 'skeleton' },
        },
        {
          type: 'connect',
          from: { node: producer, socket: 'out' },
          to: { node: clip, socket: 'source' },
        },
        ...fx.importedChildOps(ids.gltfChildDagId(asset, bone), {
          assetRef: asset,
          childName: bone,
          position: [1, 2, 3],
          rotation: [10, 20, 30],
          scale: [1, 1, 1],
        }),
      ];
      w.__basher_dag.getState().dispatchAtomic(ops, 'user', 'e2e #1001 scene');
      return Object.keys(w.__basher_dag.getState().state.nodes).length;
    },
    {
      asset: ASSET,
      bone: BONE,
      other: OTHER,
      producer: PRODUCER,
      clip: CLIP,
      firstKeys: [key(1, 0, 1), key(1, 1, 2)],
    },
  );
  expect(built).toBeGreaterThan(4);

  // 2 — the director edits the bone, by the product's own authoring road. This
  //     is what mints the channel and records where its keys came from.
  const edit = await page.evaluate(
    ({ asset, bone }) =>
      (window as unknown as BasherWindow).__basher_dispatchMutator!(
        'mutator.timeline.keyframe',
        {
          bone: { assetRef: asset, childName: bone, component: 'position' },
          time: 0.5,
          value: [0, 42, 0],
        },
        'e2e #1001 edit the bone',
      ),
    { asset: ASSET, bone: BONE },
  );
  // Reported rather than assumed: an "Unknown mutator" here would leave the card
  // silent for the right reason and the wrong cause.
  expect(edit, JSON.stringify(edit)).toMatchObject({ ok: true });

  // 3 — select the producer so the inspector draws its cook card. BEFORE the
  //     re-cook, so the card is observed saying nothing first: an assertion that
  //     only ever sees the warn line cannot tell it from a line that is always on.
  await page.evaluate(
    (producer) =>
      (window as unknown as BasherWindow).__basher_selection!.getState().select(producer),
    PRODUCER,
  );
  await expect(page.getByTestId('motion-cook')).toBeVisible();
  await expect(page.getByTestId('motion-cook-run')).toHaveText('Up to date');
  await expect(page.getByTestId('motion-cook-stranded')).toHaveCount(0);

  // 4 — the re-cook: the same clip node, new keys. The bone the director edited
  //     keeps the old motion; every other bone follows the new clip.
  await page.evaluate(
    ({ clip, nextKeys }) =>
      (window as unknown as BasherWindow).__basher_dag
        .getState()
        .dispatchAtomic(
          [{ type: 'setParam', nodeId: clip, paramPath: 'keyframes', value: nextKeys }],
          'user',
          'e2e #1001 re-cook',
        ),
    { clip: CLIP, nextKeys: [key(1, 0, 1), key(1, 1, 99)] },
  );
}

test('a re-cook names the bone the director edited, on the card that would otherwise say "Up to date" (#1001)', async ({
  page,
}) => {
  await buildStrandedScene(page);

  // THE OBSERVATION. The card still says "Up to date", because the clip is;
  // and the warn line names the bone, because the character is not.
  await expect(page.getByTestId('motion-cook-run')).toHaveText('Up to date');
  const stranded = page.getByTestId('motion-cook-stranded');
  await expect(stranded).toBeVisible();
  await expect(stranded).toContainText(BONE);
  await expect(stranded).toContainText('still on the previous motion');
});

// #1002 — the act. The signal is attributable and quiet, and until this it was
// also INERT: a director reading the bone's name had to go and find that bone in
// the outliner, select it, and use a button labelled for imported clips. The row
// below is the whole of the claim — the thing to press is where the sentence is.
test('the director presses Discard edit beside the name and the bone goes back on the clip (#1002)', async ({
  page,
}) => {
  await buildStrandedScene(page);

  const stranded = page.getByTestId('motion-cook-stranded');
  await expect(stranded).toBeVisible();
  await expect(stranded).toContainText(BONE);
  // THE LOSS IS ON THE CARD, not on hover: a title attribute puts the only
  // honest half of the sentence where a touch device never shows it.
  await expect(stranded).toContainText('drops the keys you authored');
  await page.screenshot({ path: 'test-results/1002-before-press.png' });

  // PRECONDITION, ASSERTED BEFORE THE ACT. The channel exists and carries the
  // director's key — otherwise the "it is gone" below is true of a graph where
  // it was never there, which photographs identically.
  const before = await page.evaluate(
    async ({ asset, bone }) => {
      const ids = await import('/src/core/import/gltfImportChain.ts');
      const w = window as unknown as BasherWindow;
      const id = ids.gltfChannelDagId(asset, bone, 'position');
      const node = w.__basher_dag.getState().state.nodes[id];
      return { present: Boolean(node), keys: (node?.params?.keyframes as unknown[])?.length ?? 0 };
    },
    { asset: ASSET, bone: BONE },
  );
  expect(before).toMatchObject({ present: true });
  expect(before.keys).toBeGreaterThan(0);

  // THE PRESS.
  await page.getByTestId(`motion-cook-follow-${BONE}`).click();

  // 1 — the sentence the director acted on is gone from the card.
  await expect(page.getByTestId('motion-cook-stranded')).toHaveCount(0);
  // and the card still reads the truth about the clip.
  await expect(page.getByTestId('motion-cook-run')).toHaveText('Up to date');
  await page.screenshot({ path: 'test-results/1002-after-press.png' });

  // 2 — STRUCTURAL, not an emptying (#909). The node is GONE, so the resolver's
  //     presence pick falls through to the clip. An emptied channel would still
  //     claim the component at [0,0,0] and drop the bone to the origin.
  const after = await page.evaluate(
    async ({ asset, bone }) => {
      const ids = await import('/src/core/import/gltfImportChain.ts');
      const w = window as unknown as BasherWindow;
      return {
        present: Boolean(
          w.__basher_dag.getState().state.nodes[ids.gltfChannelDagId(asset, bone, 'position')],
        ),
        undoDepth: (w.__basher_dag.getState() as unknown as { undoStack: unknown[] }).undoStack
          .length,
      };
    },
    { asset: ASSET, bone: BONE },
  );
  expect(after.present).toBe(false);
});
