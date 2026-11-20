// #1706 — the lines a pending proposal shows in chat, and the marks each op leaves in the editors.
//
// The gate at the bottom derives the op kinds from `OpSchema` itself: a new kind that has no line
// renderer, or no editor mark, fails here instead of showing nothing when the agent proposes it.

import fs from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { __resetRegistryForTests, applyOp } from '../../core/dag';
import { registerAllNodes } from '../../nodes/registerAll';
import { OpSchema, type Op } from '../../core/dag/types';
import { buildDefaultDagState } from '../../core/project/default';
import { createFork } from './forkedDag';
import {
  LINE_RENDERERS,
  MARK_EDITORS,
  MARKS_BY_KIND,
  proposalLines,
  proposedNodeIds,
  proposalTabCounts,
  proposedChange,
} from './proposalLines';

beforeEach(() => {
  __resetRegistryForTests();
  registerAllNodes();
});

function diffOf(ops: Op[], pre: Op[] = []) {
  let originalState = buildDefaultDagState();
  for (const op of pre) originalState = applyOp(originalState, op).next;
  const { fork } = createFork(originalState, ops);
  return { originalState, forkState: fork, ops };
}

/** The kinds the schema declares — the source of truth, not a list kept beside it. */
const SCHEMA_KINDS = OpSchema.options.map((o) => o.shape.type.value);

/** One op of every kind, valid against the default scene (each applies on its own). */
const SAMPLE: { [K in Op['type']]: Extract<Op, { type: K }> } = {
  addNode: { type: 'addNode', nodeId: 'p1706_null', nodeType: 'Null', params: {} },
  removeNode: { type: 'removeNode', nodeId: 'p1706_gone' },
  connect: {
    type: 'connect',
    from: { node: 'n_box', socket: 'out' },
    to: { node: 'n_scene', socket: 'children' },
  },
  disconnect: {
    type: 'disconnect',
    from: { node: 'n_box', socket: 'out' },
    to: { node: 'n_scene', socket: 'children' },
  },
  setParam: { type: 'setParam', nodeId: 'n_box', paramPath: 'position', value: [2, 0, 0] },
  setMeta: { type: 'setMeta', nodeId: 'n_box', name: 'Crate' },
  setSpareParam: {
    type: 'setSpareParam',
    nodeId: 'n_box',
    key: 'weight',
    param: { type: 'float', value: 3 },
  },
  removeSpareParam: { type: 'removeSpareParam', nodeId: 'n_box', key: 'weight' },
  setOutput: { type: 'setOutput', name: 'scene', ref: { node: 'n_scene', socket: 'out' } },
};

/** What a sample needs in the scene before it can apply (a node to remove, an edge to re-make). */
const PRE: Partial<Record<Op['type'], Op[]>> = {
  removeNode: [{ type: 'addNode', nodeId: 'p1706_gone', nodeType: 'Null', params: {} }],
  connect: [SAMPLE.disconnect],
  removeSpareParam: [SAMPLE.setSpareParam],
};

describe('proposalLines', () => {
  it('a setParam reads as "Name › param", with the value it had and the value it would get', () => {
    const lines = proposalLines(
      diffOf([{ type: 'setParam', nodeId: 'n_box', paramPath: 'position', value: [2, 0, 0] }]),
    );
    expect(lines).toHaveLength(1);
    expect(lines[0].label).toMatch(/› position$/);
    expect(lines[0].before).toBe('0, 0, 0');
    expect(lines[0].after).toBe('2, 0, 0');
    expect(lines[0].target).toEqual({ editor: 'inspector', nodeId: 'n_box', param: 'position' });
  });

  it('an addNode is one line, named in the words describeChange uses, and lands in Nodes', () => {
    const lines = proposalLines(diffOf([SAMPLE.addNode]));
    expect(lines[0].label).toBe('Added an empty');
    expect(lines[0].before).toBeUndefined();
    expect(lines[0].target.editor).toBe('nodes');
    expect(lines[0].marks).toContain('nodes');
  });

  it('one line per op, indexed into the diff', () => {
    const lines = proposalLines(
      diffOf([
        { type: 'setParam', nodeId: 'n_box', paramPath: 'position', value: [2, 0, 0] },
        SAMPLE.addNode,
      ]),
    );
    expect(lines.map((l) => l.opIndex)).toEqual([0, 1]);
  });

  it("a write to a cube's data half outlines the cube in the viewport", () => {
    const d = diffOf([
      { type: 'setParam', nodeId: 'n_box_data', paramPath: 'size', value: [2, 2, 2] },
    ]);
    expect(proposedNodeIds(d, 'viewport').has('n_box')).toBe(true);
    expect(proposedChange(d, 'n_box_data', 'size')).toEqual({
      before: [1, 1, 1],
      after: [2, 2, 2],
    });
    expect(proposedChange(d, 'n_box_data', 'position')).toBeNull();
  });

  it('counts per drawer tab follow the marks', () => {
    const d = diffOf([SAMPLE.addNode, SAMPLE.setOutput]);
    expect(proposalTabCounts(d).nodes).toBe(2);
    expect(proposalTabCounts(d).curve).toBeUndefined();
  });
});

describe('the editor a change lands in', () => {
  it('a keyframe channel edit is marked in Curves and the Dopesheet, and opens Curves', () => {
    const pre: Op[] = [
      {
        type: 'addNode',
        nodeId: 'ch',
        nodeType: 'KeyframeChannelVec3',
        params: { target: 'n_box', paramPath: 'position', keyframes: [] },
      },
    ];
    const d = diffOf([{ type: 'setParam', nodeId: 'ch', paramPath: 'mute', value: true }], pre);
    const [line] = proposalLines(d);
    expect(line.target.editor).toBe('curve');
    expect(line.marks).toEqual(expect.arrayContaining(['curve', 'dopesheet', 'nodes']));
    expect(proposedNodeIds(d, 'dopesheet').has('ch')).toBe(true);
    expect(proposalTabCounts(d)).toMatchObject({ curve: 1, dopesheet: 1, nodes: 1 });
  });
});

describe('#1706 gate — every op kind the schema declares renders a line and leaves a mark', () => {
  it('the sample covers every kind (so the checks below see them all)', () => {
    expect(Object.keys(SAMPLE).sort()).toEqual([...SCHEMA_KINDS].sort());
  });

  it.each(SCHEMA_KINDS)('%s has a line renderer', (kind) => {
    expect(LINE_RENDERERS[kind as Op['type']]).toBeTypeOf('function');
  });

  it.each(SCHEMA_KINDS)('%s maps to at least one editor mark that an editor draws', (kind) => {
    const marks = MARKS_BY_KIND[kind as Op['type']];
    expect(marks?.length ?? 0).toBeGreaterThan(0);
    for (const m of marks) expect(MARK_EDITORS).toContain(m);
  });

  it.each(SCHEMA_KINDS)('%s renders a non-empty line against a real scene', (kind) => {
    const op = SAMPLE[kind as Op['type']];
    const lines = proposalLines(diffOf([op], PRE[kind as Op['type']]));
    expect(lines).toHaveLength(1);
    expect(lines[0].label.length).toBeGreaterThan(0);
    expect(lines[0].marks.length).toBeGreaterThan(0);
  });
});

describe('#1706 gate — every mark editor is drawn by some editor', () => {
  // A mark nobody draws is a line that promises a mark and shows none. Each editor reads its marks
  // through `useProposedNodeIds('<editor>')` / `proposedNodeIds(diff, '<editor>')`, or filters the
  // lines on `marks.includes('<editor>')`; this finds that read in the shipped source.
  const root = path.resolve(__dirname, '../..');
  const sources: string[] = [];
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (
        /\.tsx?$/.test(e.name) &&
        !/\.test\.tsx?$/.test(e.name) &&
        !e.name.startsWith('tmp-')
      )
        sources.push(fs.readFileSync(p, 'utf8'));
    }
  };
  walk(root);

  it.each(MARK_EDITORS)('%s', (editor) => {
    const read = new RegExp(
      `(useProposedNodeIds\\(|proposedNodeIds\\([^,]+,\\s*|marks\\.includes\\()'${editor}'`,
    );
    expect(sources.some((src) => read.test(src))).toBe(true);
  });
});
