// The human ingestion surface for generated motion — A1's third leg.
//
// Shaped after importBvhFbx.test.ts because generateMotion is shaped after
// importBvhFromOpfs: same store seeding, same assertions about the SURFACE
// (dispatch, banner, refresh bump) rather than about the generator internals.
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
import { useSettingsStore } from '../stores/settingsStore';
import { DEFAULT_MOTIONGEN_MODEL, StubMotionGenerationCapability } from '../../core/motiongen';
import { aBlockedRecord } from '../../core/licensing/blockedModelForTests';

const capability = new StubMotionGenerationCapability();
vi.mock('../boot', () => ({
  getMotionCapability: async () => capability,
}));

// Imported AFTER vi.mock so the module picks up the mocked boot.
import { generateMotionIntoScene } from './generateMotion';
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
  useAssetErrorStore.getState().clearAll();
  useImportRefreshStore.setState({ tick: 0 });
  useSettingsStore.setState({ motionGenModel: DEFAULT_MOTIONGEN_MODEL });
  seedTime();
});

describe('a director generating motion gets an ordinary clip in the scene', () => {
  it('dispatches the clip and bumps the refresh signal', async () => {
    const result = await generateMotionIntoScene('a figure walks forward');
    expect(result.ok).toBe(true);

    const types = Object.values(useDagStore.getState().state.nodes).map((n) => n.type);
    expect(types).toContain('Skeleton');
    expect(types).toContain('AnimationClip');
    expect(useImportRefreshStore.getState().tick).toBe(1);
    expect(Object.keys(useAssetErrorStore.getState().errors)).toHaveLength(0);
  });

  it('lands as ONE undo entry, the way an import does (K6)', async () => {
    // A generation that undid in four steps would be a worse object than an
    // import, which is exactly the difference the phase says does not exist.
    const before = useDagStore.getState().undoStack.length;
    await generateMotionIntoScene('a figure waves');
    const after = useDagStore.getState().undoStack;
    expect(after.length).toBe(before + 1);
    // …and it really is the ATOMIC kind, not one entry that happens to be last.
    expect((after.at(-1) as { __atomic?: true }).__atomic).toBe(true);
  });

  it('adds no node type an import does not also add', async () => {
    await generateMotionIntoScene('a figure walks');
    const types = new Set(Object.values(useDagStore.getState().state.nodes).map((n) => n.type));
    // Seeded plus exactly what a .bvh import produces. A new type here would be
    // the provenance branch A1 exists to avoid.
    expect([...types].sort()).toEqual(['AnimationClip', 'Scene', 'Skeleton', 'TimeSource']);
  });
});

describe('a failure surfaces in the banner, never only in the console', () => {
  it('reports a licence refusal and dispatches nothing', async () => {
    useSettingsStore.setState({ motionGenModel: aBlockedRecord().id });
    const before = Object.keys(useDagStore.getState().state.nodes).length;

    const result = await generateMotionIntoScene('a figure walks');

    expect(result.ok).toBe(false);
    const errors = useAssetErrorStore.getState().errors;
    expect(Object.keys(errors)).toHaveLength(1);
    expect(Object.values(errors)[0]!).toMatch(/BLOCKED/);
    // Nothing landed, and the refresh signal did NOT move — a bump on failure
    // would re-enumerate the list for work that never happened.
    expect(Object.keys(useDagStore.getState().state.nodes)).toHaveLength(before);
    expect(useImportRefreshStore.getState().tick).toBe(0);
  });

  it('reports a malformed request rather than generating nonsense', async () => {
    const result = await generateMotionIntoScene('a figure walks', { fps: 0 });
    expect(result.ok).toBe(false);
    expect(Object.values(useAssetErrorStore.getState().errors)[0]!).toMatch(/fps/);
  });

  it('never throws — the caller can always return to idle', async () => {
    useSettingsStore.setState({ motionGenModel: aBlockedRecord().id });
    await expect(generateMotionIntoScene('x')).resolves.toMatchObject({ ok: false });
  });
});

/** Nodes sorted by type then id, so two graphs built in the same shape but with
 *  different fresh ids compare by structure. */
function nodesOf(state: DagState): unknown[] {
  return Object.values(state.nodes)
    .slice()
    .sort((a, b) => a.type.localeCompare(b.type) || a.id.localeCompare(b.id));
}

describe('UI == agent — the two routes produce the same graph', () => {
  it('a director and the agent end up with structurally identical graphs', async () => {
    // The phase's claim, checked across the two surfaces rather than asserted.
    // Node ids are minted fresh per call by design, so they are normalised; what
    // must match is everything else.
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

    // Compared at the OUTPUT — the resulting graph — rather than at the call.
    // Equal op arrays would be the weaker claim anyway: what has to match is
    // what a director and an agent each END UP WITH.
    const stateBefore = useDagStore.getState().state;
    const viaAgent = await motionGenerateTool.handler(
      { prompt: 'a figure walks forward' },
      {
        dagState: stateBefore,
        motionCapability: capability,
        motionModel: DEFAULT_MOTIONGEN_MODEL,
      },
    );
    let agentState = stateBefore;
    for (const op of viaAgent.ops) agentState = applyOp(agentState, op).next;

    await generateMotionIntoScene('a figure walks forward');
    const uiState = useDagStore.getState().state;

    expect(normalise(nodesOf(agentState))).toEqual(normalise(nodesOf(uiState)));
  });
});
