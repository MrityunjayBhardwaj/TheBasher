// #1820 — the membership list is real (every wire exists on its node type) and rule 3 of
// docs/GRAPH.md quotes it exactly.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { getNodeType } from '../core/dag/registry';
import { registerAllNodes } from '../nodes/registerAll';
import {
  MEMBERSHIP_WIRES,
  TRANSITIONAL_MEMBERSHIP_WIRES,
  membershipSocketsOf,
  type MembershipWire,
} from './sceneMembership';
import { hierarchySocketsOf } from './sceneHierarchy';

beforeAll(() => registerAllNodes());

const ALL = [...MEMBERSHIP_WIRES, ...TRANSITIONAL_MEMBERSHIP_WIRES];
const key = (w: Pick<MembershipWire, 'nodeType' | 'socket'>) => `${w.nodeType}.${w.socket}`;

/** The `Type.socket` names rule 3 quotes, in order. */
function rule3Wires(markdown: string): string[] {
  const start = markdown.indexOf('3. **Membership is reachability.**');
  const end = markdown.indexOf('4. **Time lives inside values.**', start);
  expect(start, 'rule 3 heading').toBeGreaterThan(-1);
  expect(end, 'rule 4 heading').toBeGreaterThan(start);
  const rule = markdown.slice(start, end);
  return [...rule.matchAll(/`([A-Z]\w*)\.([a-z]\w*)`/g)].map((m) => `${m[1]}.${m[2]}`);
}

describe('#1820 — one list of the membership wires', () => {
  it('every listed wire is an input its node type declares', () => {
    const missing = ALL.filter((w) => !getNodeType(w.nodeType)?.inputs[w.socket]).map(key);
    expect(missing).toEqual([]);
  });

  it('no wire is listed twice', () => {
    const keys = ALL.map(key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('rule 3 in docs/GRAPH.md quotes the list, in order', () => {
    const md = readFileSync(resolve(__dirname, '../../docs/GRAPH.md'), 'utf8');
    expect(rule3Wires(md)).toEqual(ALL.map(key));
  });

  it('parenting is not on the list: no parenting socket is a membership wire', () => {
    // Today `Scene.children` is both (the Scene is in the hierarchy table for the outliner's
    // scan); it is the one overlap, and it is on the TRANSITIONAL list for that reason.
    const overlap = MEMBERSHIP_WIRES.filter((w) =>
      hierarchySocketsOf({ type: w.nodeType }).includes(w.socket),
    ).map(key);
    expect(overlap).toEqual([]);
    expect(hierarchySocketsOf({ type: 'Scene' })).toEqual(['children']);
  });

  it('the three disagreements #1820 measured are each answered', () => {
    // A rig's lights are in the scene.
    expect(membershipSocketsOf('Scene')).toContain('lightRig');
    expect(membershipSocketsOf('LightRig')).toEqual(['lights']);
    // Collections are listed, and say they are not drawn yet (#1823).
    const collectionWires = MEMBERSHIP_WIRES.filter(
      (w) => w.nodeType === 'Collection' || w.socket === 'collections',
    );
    expect(collectionWires.map(key)).toEqual([
      'Scene.collections',
      'Collection.members',
      'Collection.collections',
    ]);
    expect(collectionWires.every((w) => !w.drawnToday)).toBe(true);
    // A Transform's chain input parents; it does not put anything in the scene.
    expect(membershipSocketsOf('Transform')).toEqual([]);
    expect(membershipSocketsOf('MaterialOverride')).toEqual([]);
  });
});
