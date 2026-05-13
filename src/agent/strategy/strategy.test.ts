// Strategy catalog + tool tests.
//
// REF: P2.5.2 PLAN §5 Wave D step 8; vyapti V15.

import { beforeEach, describe, expect, it } from 'vitest';
import {
  __resetStrategyRegistryForTests,
  getStrategy,
  listStrategies,
  listStrategyMetadata,
  registerAllStrategies,
  registerStrategy,
} from './catalog';
import { getStrategyTool, listStrategiesTool } from './tool';
import { emptyDagState } from '../../core/dag';

beforeEach(() => {
  __resetStrategyRegistryForTests();
});

describe('strategy catalog', () => {
  it('registerAllStrategies registers all starter resources', () => {
    registerAllStrategies();
    const all = listStrategies();
    expect(all).toHaveLength(9);
    const topics = all.map((s) => s.topic).sort();
    expect(topics).toEqual([
      'aiRender',
      'animation',
      'assetChoice',
      'cameras',
      'lighting',
      'materials',
      'rendering',
      'spawnWithProperties',
      'units',
    ]);
  });

  it('getStrategy returns a resource with a non-empty body', () => {
    registerAllStrategies();
    const r = getStrategy('units');
    expect(r).toBeDefined();
    expect(r!.body.length).toBeGreaterThan(40);
    expect(r!.description.length).toBeGreaterThan(0);
  });

  it('refuses duplicate registration', () => {
    registerAllStrategies();
    expect(() => registerStrategy({ topic: 'units', description: 'x', body: 'x' })).toThrow(
      'Strategy already registered: units',
    );
  });

  it('listStrategyMetadata drops the body', () => {
    registerAllStrategies();
    const meta = listStrategyMetadata();
    expect(meta).toHaveLength(9);
    for (const m of meta) {
      expect(m).toHaveProperty('topic');
      expect(m).toHaveProperty('description');
      expect(m).not.toHaveProperty('body');
    }
  });
});

describe('agent.listStrategies tool', () => {
  it('returns metadata for every registered resource', () => {
    registerAllStrategies();
    const r = listStrategiesTool.handler({}, { dagState: emptyDagState() });
    expect(r.ops).toEqual([]);
    const parsed = JSON.parse(r.text!) as { strategies: { topic: string }[] };
    expect(parsed.strategies).toHaveLength(9);
  });
});

describe('agent.getStrategy tool', () => {
  it('returns the resource body for a registered topic', () => {
    registerAllStrategies();
    const r = getStrategyTool.handler({ topic: 'lighting' }, { dagState: emptyDagState() });
    expect(r.ops).toEqual([]);
    expect(r.text).toMatch(/Lighting/);
  });

  it('throws zod error for an unknown topic at parse time', () => {
    registerAllStrategies();
    expect(() => getStrategyTool.paramSchema.parse({ topic: 'nonexistent' })).toThrow();
  });
});
