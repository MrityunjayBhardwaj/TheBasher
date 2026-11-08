// #1817 — what the stack panel shows for a row, and what its "+" offers.

import { beforeAll, describe, expect, it } from 'vitest';
import { __resetRegistryForTests } from '../core/dag';
import { getNodeType, listNodeTypes, mainInputOfType } from '../core/dag/registry';
import { TEMPLATE_DEFINITION_TYPE } from '../core/dag/templates';
import { buildDefaultDagState } from '../core/project/default';
import { registerAllNodes } from '../nodes/registerAll';
import { buildCrateMockup, type CrateMockup } from '../test-utils/crateMockup';
import { planStackEdit, type StackPlace } from './stackEdit';
import {
  emptySockets,
  freshId,
  nameOf,
  offersAt,
  openPaths,
  rowCount,
  rowView,
} from './stackPanelModel';
import { stackOf, type StackNodeRow, type StackRow } from './stackTree';

beforeAll(() => {
  __resetRegistryForTests();
  registerAllNodes();
});

const every = (rows: readonly StackRow[]): StackRow[] =>
  rows.flatMap((r) =>
    r.kind === 'same'
      ? [r]
      : [r, ...r.groups.flatMap((g) => every(g.rows)), ...every(r.template?.inside ?? [])],
  );
const rowOf = (rows: readonly StackRow[], id: string) =>
  every(rows).find((r) => r.kind === 'node' && r.nodeId === id) as StackNodeRow;

describe('a row', () => {
  let m: CrateMockup;
  let rows: StackRow[];
  beforeAll(() => {
    m = buildCrateMockup(buildDefaultDagState());
    rows = stackOf(m.state, m.crate);
  });

  it('reads by its name, or by its type when nobody named it', () => {
    expect(nameOf(m.state, 'aimA')).toBe('Track-To A');
    expect(nameOf(m.state, 'mirror')).toBe('Mirror Modifier');
    expect(rowView(m.state, rowOf(rows, 'blend')).name).toBe('Mix');
  });

  it('says what a wire overrides, what a template exposes and which kind it is', () => {
    const blend = rowView(m.state, rowOf(rows, 'blend'));
    expect(blend.overridden).toEqual([{ param: 'factor', value: '0.5' }]);
    expect(blend.tag).toBe('3 inputs');
    const lag = rowView(m.state, rowOf(rows, m.lag));
    expect(lag.tag).toBe('template · 3 instances');
    expect(lag.exposed.map((e) => e.param)).toContain('factor');
    expect(lag.exposed.map((e) => e.param)).not.toContain('in'); // wired, so overridden instead
    expect(lag.overridden).toEqual([{ param: 'in', value: '0' }]); // `factor` is unwired: not overridden
    expect(rowView(m.state, rowOf(rows, 'aimA')).tag).toBe('constraint');
    expect(rowView(m.state, rowOf(rows, m.crate.node)).tag).toBeNull(); // lanes, not operands
  });

  it('shows a mute only where the type has one', () => {
    expect(rowView(m.state, rowOf(rows, 'mirror')).muted).toBe(false);
    expect(rowView(m.state, rowOf(rows, 'aimA')).muted).toBe(false);
    expect(rowView(m.state, rowOf(rows, 'blend')).muted).toBeNull();
  });

  it("a blended step's influence is its number", () => {
    const barrel = stackOf(m.state, m.barrel);
    expect(rowView(m.state, rowOf(barrel, 'barrelAim')).influence).toBe('0.5');
    expect(rowView(m.state, rowOf(barrel, 'barrelFollow')).influence).toBeNull();
  });

  it('counts every row under a group, and knows what has to open to show one', () => {
    const blend = rowOf(rows, 'blend');
    const a = blend.groups.find((g) => g.socket === 'aMatrix')!;
    expect(rowCount(a.rows)).toBe(6); // Track-To A, Hero, Follow Path, Rail, its curve, Own World
    expect(openPaths(rows).get('follow')).toEqual([`${m.crate.node}:constraints`, 'blend:aMatrix']);
  });

  it('offers a socket only while nothing feeds it', () => {
    expect(emptySockets(m.state, rowOf(rows, 'blend'))).toEqual([]);
    expect(emptySockets(m.state, rowOf(rows, 'noise'))).toEqual(['t']);
  });

  it('a fresh id is free', () => {
    expect(m.state.nodes[freshId(m.state, 'Clamp')]).toBeUndefined();
  });
});

describe('what "+" offers', () => {
  let m: CrateMockup;
  beforeAll(() => {
    m = buildCrateMockup(buildDefaultDagState());
  });

  // The menu skips some types before asking: they must be ones the edit refuses anyway.
  it.each([
    ['on top of a row', { above: 'remap' } as StackPlace],
    ['into an empty socket', { route: { owner: 'noise', socket: 't' } } as StackPlace],
    ['on a constraint chain', { above: 'barrelFollow' } as StackPlace],
  ])('%s: exactly what the edit accepts', (_, place) => {
    const output = 'above' in place && place.above === 'barrelFollow' ? m.barrel : m.crate;
    const offered = offersAt(m.state, output, place).map((o) => o.type);
    expect(offered.length).toBeGreaterThan(0);
    const accepted = listNodeTypes().filter((type) => {
      if (type === TEMPLATE_DEFINITION_TYPE || getNodeType(type)?.bodyInputLeaf) return false;
      const plan = planStackEdit(m.state, output, {
        kind: 'add',
        nodeId: 'probe_new',
        nodeType: type,
        place,
      });
      return plan.ok;
    });
    expect([...offered].sort()).toEqual([...accepted].sort());
  });

  it('a type with no main input is never accepted on top of a row, which is why it is skipped', () => {
    const skipped = listNodeTypes().filter(
      (t) => !mainInputOfType(t) && t !== TEMPLATE_DEFINITION_TYPE,
    );
    expect(skipped.length).toBeGreaterThan(10);
    for (const type of skipped) {
      const plan = planStackEdit(m.state, m.crate, {
        kind: 'add',
        nodeId: 'probe_new',
        nodeType: type,
        place: { above: 'remap' },
      });
      expect(plan.ok, type).toBe(false);
    }
  });
});
