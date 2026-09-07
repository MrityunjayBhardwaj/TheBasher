// The human ingestion surface for generated motion — A1's third leg.
//
// Shaped after importBvhFbx.test.ts, because this road is shaped after
// importBvhFromOpfs: same store seeding, same assertions about the SURFACE
// (dispatch, banner, refresh bump) rather than about the generator internals.
//
// 🔑 THESE ROWS MOVED HERE FROM THE ONE-SHOT ROAD (#948). They were written
// against `generateMotionIntoScene` and kept passing after a director stopped
// taking it, which made them a description of nothing. Retargeting them found
// two things the node road did differently and one thing it did WRONG — #949,
// where placement asked the clip for its rig instead of asking the bind, so a
// cooked walk never started where the path was drawn.
//
// The test that carries the phase's claim is the last one: the ops a director
// gets and the ops the agent gets are the same ops. If those two ever diverge,
// "UI == agent == render" is a slogan rather than a property.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useDagStore } from '../../core/dag/store';
import { applyOp } from '../../core/dag';
import type { DagState } from '../../core/dag/state';
import { registerAllNodes } from '../../nodes/registerAll';
import { useAssetErrorStore } from '../stores/assetErrorStore';
import { useImportRefreshStore } from '../stores/importRefreshStore';
import { useGeneratedMotionStore } from '../stores/generatedMotionStore';
import { useSettingsStore } from '../stores/settingsStore';
import {
  DEFAULT_MOTIONGEN_MODEL,
  StubMotionGenerationCapability,
  type MotionGenerationCapability,
} from '../../core/motiongen';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { registerAllMutators, __resetMutatorRegistryForTests } from '../../agent/mutators';
import { gltfChildDagId, gltfSkeletonDagId } from '../../core/import/gltfImportChain';
import { getBoneNameMapPreset } from '../../core/import/boneNameMaps';
import { retargetedClipId } from './bindMotionToCharacter';
import type { GltfSkinMetadata } from '../../nodes/types';
import { aBlockedRecord } from '../../core/licensing/blockedModelForTests';
import { makeSplitCurve } from '../../test-utils/splitCurve';
import { useSelectionStore } from '../stores/selectionStore';
import { bakedChannelSamplersForAsset, sampleBakedChannel } from '../bakedGltfChannels';
import { assertValidMotionRequest } from '../../core/motiongen/MotionGenerationCapability';

const stub = new StubMotionGenerationCapability();
// Mutable so one case can hand back a SOMA clip instead — the stub's three-joint
// rig shares no naming with any character, so it can never exercise the bind.
let capability: MotionGenerationCapability = stub;
vi.mock('../boot', () => ({
  getMotionCapability: async () => capability,
}));

// Imported AFTER vi.mock so the module picks up the mocked boot.
import { generateMotionAsNode } from './generateMotionAsNode';
import { motionGenerateTool } from '../../agent/tools/motionGenerate';

function seedTime(): void {
  useDagStore.getState().hydrate({
    nodes: {
      n_scene: { id: 'n_scene', type: 'Scene', version: 1, params: {}, inputs: {} },
      n_time: { id: 'n_time', type: 'TimeSource', version: 1, params: {}, inputs: {} },
    },
    outputs: { scene: { node: 'n_scene', socket: 'out' } },
  });
}

beforeEach(() => {
  registerAllNodes();
  __resetMutatorRegistryForTests();
  registerAllMutators();
  capability = stub;
  useAssetErrorStore.getState().clearAll();
  useImportRefreshStore.setState({ tick: 0 });
  useGeneratedMotionStore.getState().clear();
  useSettingsStore.setState({ motionGenModel: DEFAULT_MOTIONGEN_MODEL });
  // The selection is an INPUT to generation now (#730 — it chooses the path), so
  // it has to be reset like any other input. A leaked selection would make these
  // cases order-dependent in the one direction that is hard to see: a curve
  // silently steering a generation that never asked for one.
  useSelectionStore.setState({ selectedNodeId: null });
  seedTime();
});

describe('a director generating motion gets an ordinary clip in the scene', () => {
  it('dispatches the clip and bumps the refresh signal', async () => {
    const result = await generateMotionAsNode('a figure walks forward');
    expect(result.ok).toBe(true);

    const types = Object.values(useDagStore.getState().state.nodes).map((n) => n.type);
    expect(types).toContain('Skeleton');
    expect(types).toContain('AnimationClip');
    expect(useImportRefreshStore.getState().tick).toBe(1);
    expect(Object.keys(useAssetErrorStore.getState().errors)).toHaveLength(0);
  });

  it('lands every ACT atomically — no act in halves (K6)', async () => {
    const before = useDagStore.getState().undoStack.length;
    await generateMotionAsNode('a figure waves');
    const pushed = useDagStore.getState().undoStack.slice(before);

    // MORE THAN ONE ENTRY, and that is the design rather than a regression. K6
    // protects "no single act lands in halves", not "a generation is one act" —
    // the mint, the cook, the bind and the placement are separate acts, and a
    // director who follows a curve and then wants the character elsewhere should
    // be able to undo the placement without also undoing the clip. The one-shot
    // road could claim a single entry only because it did the whole thing in one
    // call and kept nothing a director could return to.
    expect(pushed.length).toBeGreaterThan(1);
    // Each one is the ATOMIC kind, which is the half of K6 that still binds:
    // no entry here leaves a generator without its clip, or a clip without keys.
    for (const entry of pushed) {
      expect((entry as { __atomic?: true }).__atomic).toBe(true);
    }
  });

  it('adds the import pair PLUS the producer, and nothing else', async () => {
    await generateMotionAsNode('a figure walks');
    const types = new Set(Object.values(useDagStore.getState().state.nodes).map((n) => n.type));
    // Seeded, plus exactly what a .bvh import produces, plus the generator that
    // can re-cook it. `MotionGenerate` is the ONE addition, and it is the point:
    // it holds the prompt, the seed and the path so the request survives the
    // clip. The clip itself is still an ordinary `AnimationClip` carrying no
    // provenance flag, which is what "indistinguishable downstream" now means.
    expect([...types].sort()).toEqual([
      'AnimationClip',
      'MotionGenerate',
      'Scene',
      'Skeleton',
      'TimeSource',
    ]);
  });
});

describe('a failure surfaces in the banner, never only in the console', () => {
  it('reports a licence refusal and KEEPS the generator to re-cook', async () => {
    useSettingsStore.setState({ motionGenModel: aBlockedRecord().id });
    const before = Object.keys(useDagStore.getState().state.nodes).length;

    const result = await generateMotionAsNode('a figure walks');

    expect(result.ok).toBe(false);
    const errors = useAssetErrorStore.getState().errors;
    expect(Object.keys(errors)).toHaveLength(1);
    expect(Object.values(errors)[0]!).toMatch(/BLOCKED/);

    // The generator, its skeleton and its empty clip DID land, and that is
    // deliberate: this road mints before it cooks, so a blocked checkpoint
    // leaves a director a node carrying the prompt and the seed, re-cookable the
    // moment Settings changes. Rolling it back would make a refusal cost them
    // the request — which is what the one-shot road did, having nothing to keep.
    expect(Object.keys(useDagStore.getState().state.nodes)).toHaveLength(before + 3);
    // The refresh signal did NOT move: a bump on failure would re-enumerate the
    // list for work that never happened.
    expect(useImportRefreshStore.getState().tick).toBe(0);
  });

  it('reports a malformed request rather than generating nonsense', async () => {
    // `seconds`, because `fps` is no longer an option a director can pass (#790)
    // — the generator decides the rate. What is under test is unchanged: a
    // degenerate number reaches the banner instead of becoming a clip full of
    // nonsense that nothing complains about.
    const result = await generateMotionAsNode('a figure walks', { seconds: 0 });
    expect(result.ok).toBe(false);
    expect(Object.values(useAssetErrorStore.getState().errors)[0]!).toMatch(/seconds/);
  });

  it('never throws — the caller can always return to idle', async () => {
    useSettingsStore.setState({ motionGenModel: aBlockedRecord().id });
    await expect(generateMotionAsNode('x')).resolves.toMatchObject({ ok: false });
  });
});

/** Nodes sorted by type then id, so two graphs built in the same shape but with
 *  different fresh ids compare by structure. */
function nodesOf(state: DagState): unknown[] {
  return Object.values(state.nodes)
    .slice()
    .sort((a, b) => a.type.localeCompare(b.type) || a.id.localeCompare(b.id));
}

// #820 — the step the generate road used to stop short of.
//
// MEASURED IN A BROWSER FIRST, which is the only reason this test exists: a
// director typed a sentence, a real 78-joint Kimodo clip arrived with no error,
// and the character stood still — while the SAME bytes dropped as a file
// animated it (46 baked channels). The two roads differed in one call.
//
// The subject has to be a SOMA clip rather than the stub's three-joint rig:
// `chooseBoneNameMap` needs a naming the character's rig can be reached from,
// and Hips/Spine/Head reaches nothing. This is the fixture the somaToMixamo
// preset itself is pinned against, so the bridge under test is the shipped one.
const SOMA_BVH = (): string =>
  readFileSync(resolve(process.cwd(), 'public/fixtures/anim/soma-generated.bvh'), 'utf8');

const CHAR_ASSET = 'user-imports/dwarf/dwarf.glb';
const CHAR_SKEL = gltfSkeletonDagId(CHAR_ASSET, 0);

function somaCapability(): MotionGenerationCapability {
  return {
    id: 'soma-fixture',
    kind: 'stub',
    isAvailable: async () => true,
    generate: async () => ({
      jobId: 'j_soma',
      bvh: SOMA_BVH(),
      model: DEFAULT_MOTIONGEN_MODEL,
      unitScale: 0.01,
      // #826 — no world path was requested, so there is no offset to place.
      // `null` is a statement here, not a placeholder: a fixture that omitted
      // the field would be claiming silence about placement, which
      // `assertValidMotionResult` refuses on purpose.
      worldOffsetXZ: null,
    }),
    cancel: async () => {},
  };
}

/** A character in the scene, shaped exactly as an imported glTF leaves one. */
function seedCharacter(): void {
  const boneNames = Object.values(getBoneNameMapPreset('somaToMixamo')!.map);
  const skin: GltfSkinMetadata = {
    jointKeys: boneNames,
    bindTRS: boneNames.map(() => ({
      position: [0, 0, 0] as [number, number, number],
      rotation: [0, 0, 0] as [number, number, number],
      scale: [1, 1, 1] as [number, number, number],
    })),
    parentJointIndex: boneNames.map((_, i) => (i === 0 ? -1 : 0)),
    inverseBindMatrices: [],
  };
  const dag = useDagStore.getState();
  let next: DagState = dag.state;
  for (const op of [
    {
      type: 'addNode' as const,
      nodeId: 'n_char_asset',
      nodeType: 'GltfAsset',
      params: {
        assetRef: CHAR_ASSET,
        // NOT `{}`. This map is the read band's asset-membership scope
        // (`clipBandSamplersForAsset` skips any bone not in it), so an empty one
        // would make "the clip drives the character" unobservable here — the
        // assertion below would pass against a band that does nothing.
        nodeNameMap: Object.fromEntries(boneNames.map((n) => [n, gltfChildDagId(CHAR_ASSET, n)])),
        childHierarchy: {},
        skins: [skin],
      },
    },
    {
      type: 'addNode' as const,
      nodeId: CHAR_SKEL,
      nodeType: 'GltfSkeleton',
      params: { skinIndex: 0 },
    },
    {
      type: 'connect' as const,
      from: { node: 'n_char_asset', socket: 'out' },
      to: { node: CHAR_SKEL, socket: 'asset' },
    },
  ]) {
    next = applyOp(next, op).next;
  }
  useDagStore.getState().hydrate(next);
}

describe('a generated clip reaches the character, exactly as a dropped one does', () => {
  it('drives the character in the scene, and bakes NOTHING to do it', async () => {
    capability = somaCapability();
    seedCharacter();

    const before = Object.values(useDagStore.getState().state.nodes).filter(
      (n) => n.type === 'KeyframeChannelVec3',
    ).length;
    expect(before).toBe(0);

    const result = await generateMotionAsNode('a figure walks forward');
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const nodes = useDagStore.getState().state.nodes;
    // 🔴 INVERTED BY #889 slice 3. This asserted `channels.length > 0` — the
    // postcondition of an EAGER BAKE, which is the copy that should never have
    // been made. Under copy-on-write the director-facing postcondition is
    // unchanged (the character moves) and the graph-facing one is its opposite
    // (nothing was materialised to make it move).
    const channels = Object.values(nodes).filter((n) => n.type === 'KeyframeChannelVec3');
    expect(channels).toHaveLength(0);
    // And the retargeted clip is derived from the PAIR, so a second generation
    // onto the same character cannot silently overwrite the first.
    expect(nodes[retargetedClipId(result.clipId, CHAR_SKEL)]).toBeDefined();

    // 🔑 THE ZERO ABOVE IS ONLY HALF AN ASSERTION. A bind that emitted nothing
    // AT ALL — the exact failure the old `> 0` was aimed at — satisfies it too.
    // So the other half is measured on the band the renderer actually samples:
    // the bones are driven, and they MOVE.
    const samplers = bakedChannelSamplersForAsset(
      nodes,
      (nodes['n_char_asset'].params as { nodeNameMap: Record<string, string> }).nodeNameMap,
      CHAR_ASSET,
    );
    const driven = Object.keys(samplers);
    expect(driven.length).toBeGreaterThan(0);
    const moves = driven.filter((bone) => {
      const a = sampleBakedChannel(samplers[bone], 0)?.rotation;
      const b = sampleBakedChannel(samplers[bone], 0.5)?.rotation;
      return !!a && !!b && a.some((v, i) => Math.abs(v - b[i]) > 1e-6);
    });
    expect(moves.length).toBeGreaterThan(0);
    expect(Object.keys(useAssetErrorStore.getState().errors)).toHaveLength(0);
  });

  it('still succeeds when there is no character to bind to', async () => {
    // The refusal is a TOAST, not a fault: the clip did land, and a director
    // with an empty scene has not done anything wrong. A generation that
    // reported failure here would throw away a clip that exists.
    capability = somaCapability();

    const result = await generateMotionAsNode('a figure walks forward');
    expect(result.ok).toBe(true);

    const types = Object.values(useDagStore.getState().state.nodes).map((n) => n.type);
    expect(types).toContain('AnimationClip');
    expect(types).not.toContain('KeyframeChannelVec3');
    expect(Object.keys(useAssetErrorStore.getState().errors)).toHaveLength(0);
  });
});

describe('the bytes survive the call, so the clip can be kept (#819)', () => {
  it('records the BVH the generator returned, verbatim', async () => {
    // The seed is FIXED so the reference generation below is the SAME request.
    // Without it the road picks its own seed, the stub answers deterministically
    // per seed, and the two differ in every MOTION row — which reads as "the
    // bytes were mangled" when nothing was mangled at all.
    const result = await generateMotionAsNode('a figure walks forward', { seed: 7 });
    expect(result.ok).toBe(true);

    const pending = useGeneratedMotionStore.getState().pending;
    expect(pending).not.toBeNull();
    // Verbatim, because this is the ONLY copy: the ops carry parsed keyframes
    // and nothing can turn those back into the file that produced them.
    expect(pending!.bvh).toBe(
      (
        await capability.generate({
          prompt: 'a figure walks forward',
          model: DEFAULT_MOTIONGEN_MODEL,
          seed: 7,
        })
      ).bvh,
    );
    expect(pending!.name).toBe('a figure walks forward');
    expect(pending!.clipId).toBe(result.ok ? result.clipId : '');
  });

  it('records nothing when the generation fails', async () => {
    useSettingsStore.setState({ motionGenModel: aBlockedRecord().id });
    const result = await generateMotionAsNode('a figure walks forward');
    expect(result.ok).toBe(false);
    // An offer to save a clip that is not in the scene is a button that lies
    // about what it would keep.
    expect(useGeneratedMotionStore.getState().pending).toBeNull();
  });
});

// #824 — THE CLAIM NOW STATES ITS OWN SCOPE.
//
// This block used to say "the two routes produce the same graph" and assert it
// over a scene seeded with a TimeSource and nothing else. Since #820 the
// director's road also BINDS when there is a character to bind to, so the wide
// sentence was true of the scene it ran in and false in general — and nothing
// said which. A future edit that seeded a character would have redded it with
// no clue that the difference is deliberate.
//
// So: the narrow claim is what A1 actually needs (the two roads LAND the same
// clip), and the divergence after it lands is asserted rather than left to be
// discovered. A test whose sentence is wider than its assertion survives every
// run precisely because nothing can reach the part that is wrong.
describe('UI == agent — the two routes land the same clip', () => {
  // Node ids are minted fresh per call by design, so they are normalised; what
  // must match is everything else. Shared by both rows below.
  const normalise = (ops: readonly unknown[]): unknown => {
    const seen = new Map<string, string>();
    const rename = (id: string) => {
      if (!seen.has(id)) seen.set(id, `id_${seen.size}`);
      return seen.get(id)!;
    };
    const walk = (v: unknown): unknown => {
      if (Array.isArray(v)) return v.map(walk);
      if (v && typeof v === 'object') {
        return Object.fromEntries(
          Object.entries(v as Record<string, unknown>).map(([k, val]) => [
            k,
            k === 'nodeId' || k === 'node' || k === 'id' ? rename(String(val)) : walk(val),
          ]),
        );
      }
      return v;
    };
    return walk(ops);
  };

  it('a director and the agent end up with identical graphs — WITH NOTHING TO BIND TO', async () => {
    // 🔴 THE SCOPE, ASSERTED. This row is true only while the scene holds no
    // character; `beforeEach` seeds a Scene and a TimeSource and no rig. Stating
    // that as an assertion rather than a comment means someone who later seeds a
    // character here gets a failure that names the reason, instead of an equality
    // that mysteriously stops holding.
    expect(Object.values(useDagStore.getState().state.nodes).map((n) => n.type)).not.toContain(
      'GltfSkeleton',
    );

    // Compared at the OUTPUT — the resulting graph — rather than at the call.
    // Equal op arrays would be the weaker claim anyway: what has to match is
    // what a director and an agent each END UP WITH.
    // The DIRECTOR'S ROAD is `generateMotionAsNode` (#935). Comparing the agent
    // against `generateMotionIntoScene` was comparing it against a road no
    // director takes — the claim stayed green while the two surfaces genuinely
    // diverged, which is the whole of #948.
    //
    // The seed is FIXED on both arms. Each road picks one when the caller does
    // not, and it is written into the producer's params, so two unseeded calls
    // differ in exactly the field that exists to make a clip reproducible.
    const stateBefore = useDagStore.getState().state;
    const viaAgent = await motionGenerateTool.handler(
      { prompt: 'a figure walks forward', seed: 7 },
      {
        dagState: stateBefore,
        motionCapability: capability,
        motionModel: DEFAULT_MOTIONGEN_MODEL,
      },
    );
    let agentState = stateBefore;
    for (const op of viaAgent.ops) agentState = applyOp(agentState, op).next;

    await generateMotionAsNode('a figure walks forward', { seed: 7 });
    const uiState = useDagStore.getState().state;

    // The population, beside the verdict: two empty graphs normalise equal.
    expect(Object.keys(nodesOf(uiState)).length).toBeGreaterThan(
      Object.keys(nodesOf(stateBefore)).length,
    );
    expect(normalise(nodesOf(agentState))).toEqual(normalise(nodesOf(uiState)));
  });

  it('and they DIVERGE once a character is present — by design, not by accident', async () => {
    // The other half of the scope, and the row that makes the one above honest.
    // Parity says the agent must be ABLE to do what a director can, not that one
    // call must do it in one go: the agent has explicit retarget and bake
    // mutators and binds deliberately, while the UI has no such control, so the
    // automatic bind is the UI's affordance for the agent's extra step.
    //
    // Note what the divergence IS, because it has changed twice. Under #889 it
    // stopped being a pile of baked channels — copy-on-write means neither road
    // bakes any. Under #948 it stopped being the producer too: both roads mint
    // one now. What is left is exactly the retargeted clip the UI road derives
    // from the (clip, rig) pair, which is the bind and nothing else.
    capability = somaCapability();
    seedCharacter();

    // Seed fixed on both arms, so the divergence this row NAMES is the bind and
    // cannot be two different random seeds wearing its clothes.
    const stateBefore = useDagStore.getState().state;
    const viaAgent = await motionGenerateTool.handler(
      { prompt: 'a figure walks forward', seed: 7 },
      {
        dagState: stateBefore,
        motionCapability: capability,
        motionModel: DEFAULT_MOTIONGEN_MODEL,
      },
    );
    let agentState = stateBefore;
    for (const op of viaAgent.ops) agentState = applyOp(agentState, op).next;

    const result = await generateMotionAsNode('a figure walks forward', { seed: 7 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const uiState = useDagStore.getState().state;

    // The wide claim is FALSE here — which is exactly what the old sentence
    // asserted without ever running in a scene that could show it.
    expect(normalise(nodesOf(agentState))).not.toEqual(normalise(nodesOf(uiState)));

    // …and named, so "they differ" cannot quietly become "they differ for some
    // other reason". The UI road binds; the agent road leaves that to a mutator.
    expect(uiState.nodes[retargetedClipId(result.clipId, CHAR_SKEL)]).toBeDefined();
    expect(agentState.nodes[retargetedClipId(result.clipId, CHAR_SKEL)]).toBeUndefined();

    // Neither road bakes — the divergence is the bind, not a copy.
    for (const st of [agentState, uiState]) {
      expect(Object.values(st.nodes).filter((n) => n.type === 'KeyframeChannelVec3')).toHaveLength(
        0,
      );
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────
// #730 — a curve is a CONTROL INPUT to the generator, not a rail fitted after
// ─────────────────────────────────────────────────────────────────────────
// Two properties, and the order between them is the phase's whole claim. The
// waypoints must reach the GENERATOR (so dragging a control point changes the
// motion that comes back), and the offset it returns must reach the CHARACTER
// (so the motion plays where the curve was drawn rather than at the origin).
//
// A version of this that fitted the finished clip to the curve afterwards would
// pass any test about final position and fail the first one here — which is why
// the request is captured rather than only the outcome.
describe('#730 — an authored curve steers the generation', () => {
  /** Captures what the generator was ASKED for, and reports a world offset back. */
  function capturingCapability(worldOffsetXZ: readonly [number, number] | null) {
    const seen: Record<string, unknown>[] = [];
    const cap: MotionGenerationCapability = {
      id: 'capture',
      kind: 'stub',
      isAvailable: async () => true,
      cancel: async () => {},
      generate: async (request) => {
        // VALIDATE, exactly as the HTTP capability does before it hits the wire.
        // Without this the stub accepts any shape, and a request built in the
        // WIRE shape instead of the API shape sails through every unit test while
        // the real server road refuses it — which is precisely what happened here
        // and was caught only by running against the live server. A test double
        // that is more permissive than the thing it doubles measures nothing.
        assertValidMotionRequest(request);
        seen.push(request as unknown as Record<string, unknown>);
        return {
          jobId: 'j_path',
          bvh: SOMA_BVH(),
          model: DEFAULT_MOTIONGEN_MODEL,
          unitScale: 0.01,
          worldOffsetXZ,
        };
      },
    };
    return { cap, seen };
  }

  /** The character fixture PLUS the root Group a real glTF import emits — the
   *  node that owns where the character stands, and so the node a placement
   *  must move. Without it there is nothing to place and the code says so. */
  function seedCharacterWithGroup(position: [number, number, number] = [0, 0, 0]): void {
    seedCharacter();
    let next: DagState = useDagStore.getState().state;
    for (const op of [
      {
        type: 'addNode' as const,
        nodeId: 'n_char_group',
        nodeType: 'Group',
        params: { position, rotation: [0, 0, 0], scale: [1, 1, 1], pivot: [0, 0, 0] },
      },
      {
        type: 'connect' as const,
        from: { node: 'n_char_asset', socket: 'out' },
        to: { node: 'n_char_group', socket: 'children' },
      },
      {
        type: 'connect' as const,
        from: { node: 'n_char_group', socket: 'out' },
        to: { node: 'n_scene', socket: 'children' },
      },
    ]) {
      next = applyOp(next, op).next;
    }
    useDagStore.getState().hydrate(next);
  }

  /** A straight curve in the scene, running from [-2,0,0] to [2,0,0]. */
  function seedCurve(position: [number, number, number] = [0, 0, 0]): string {
    const built = makeSplitCurve(useDagStore.getState().state, {
      objectId: 'n_path',
      position,
      connectTo: { node: 'n_scene', socket: 'children' },
      points: [
        [-2, 0, 0],
        [-1, 0, 0],
        [1, 0, 0],
        [2, 0, 0],
      ],
    });
    useDagStore.getState().hydrate(built.state);
    return built.objectId;
  }

  it('sends the selected curve to the GENERATOR as waypoints', async () => {
    const { cap, seen } = capturingCapability(null);
    capability = cap;
    const curveId = seedCurve();
    useSelectionStore.setState({ selectedNodeId: curveId });

    await generateMotionAsNode('a figure walks');

    expect(seen).toHaveLength(1);
    // `constraints.waypoints` is the API shape. Asserting the top-level key here
    // would repeat whatever mistake the code made and agree with it.
    const wp = (seen[0].constraints as { waypoints?: { x: number; z: number }[] } | undefined)
      ?.waypoints;
    expect(wp).toBeDefined();
    // World XZ in metres, spanning the drawn curve end to end. If these ever
    // arrive as local points, a curve under a transform steers the wrong path.
    expect(wp![0].x).toBeCloseTo(-2, 5);
    expect(wp![wp!.length - 1].x).toBeCloseTo(2, 5);
  });

  it('sends NO waypoints when no curve is selected', async () => {
    // A curve sits in the scene and is deliberately not selected. A curve here is
    // already a camera rail; drawing one must never start steering characters.
    const { cap, seen } = capturingCapability(null);
    capability = cap;
    seedCurve();
    useSelectionStore.setState({ selectedNodeId: null });

    await generateMotionAsNode('a figure walks');

    expect(seen[0].constraints).toBeUndefined();
  });

  it('moves the character to where the path starts', async () => {
    const { cap } = capturingCapability([3, 1]);
    capability = cap;
    seedCharacterWithGroup([0, 0, 0]);
    const curveId = seedCurve();
    useSelectionStore.setState({ selectedNodeId: curveId });

    const result = await generateMotionAsNode('a figure walks');
    expect(result.ok).toBe(true);

    const group = useDagStore.getState().state.nodes.n_char_group;
    expect((group.params as { position: [number, number, number] }).position).toEqual([3, 0, 1]);
    expect(Object.keys(useAssetErrorStore.getState().errors)).toHaveLength(0);
  });

  it('leaves the character alone when no world path was requested', async () => {
    // `null` means nobody asked for a path. A character standing where the
    // director put it must not be dragged to the origin by a generation.
    const { cap } = capturingCapability(null);
    capability = cap;
    seedCharacterWithGroup([4, 0, 4]);

    await generateMotionAsNode('a figure walks');

    const group = useDagStore.getState().state.nodes.n_char_group;
    expect((group.params as { position: [number, number, number] }).position).toEqual([4, 0, 4]);
  });

  it('reports — never swallows — an offset it could not place', async () => {
    // The character has no root group, so the clip binds and plays at the origin.
    // That is the failure that looks identical to success in a screenshot, so it
    // has to reach the surface that persists.
    const { cap } = capturingCapability([3, 1]);
    capability = cap;
    seedCharacter();
    const curveId = seedCurve();
    useSelectionStore.setState({ selectedNodeId: curveId });

    await generateMotionAsNode('a figure walks');

    const reported = JSON.stringify(useAssetErrorStore.getState().errors);
    expect(reported).toMatch(/origin rather than along the path/);
  });
});
