// #428 — exportDagJson used to stamp `formatVersion: 1` on a snapshot of the
// live DAG, which is already in the current shape. Re-importing that file
// replayed the migration ladder from v1. These tests pin the DOM-free payload
// builder so the stamped version tracks the format constant, not a literal.

import { describe, expect, it } from 'vitest';

import { emptyDagState } from '../core/dag/state';
import { PROJECT_FORMAT_VERSION } from '../core/project/schema';
import { migrateProjectFormat } from '../core/project/migrations';
import { buildDagExportPayload } from './exportDag';

describe('buildDagExportPayload (#428)', () => {
  it('stamps the CURRENT format version, not the old hardcoded 1', () => {
    const payload = buildDagExportPayload({ id: 'p1', name: 'Proj' }, emptyDagState(), 0);
    // Tracks the constant: a v3→v4 bump moves PROJECT_FORMAT_VERSION and this
    // assertion moves with it, so a re-hardcoded literal would go red.
    expect(payload.formatVersion).toBe(PROJECT_FORMAT_VERSION);
    // The exact bug: the label must no longer be 1 while the state is current.
    expect(payload.formatVersion).not.toBe(1);
  });

  it('stamps v10 after the eager-channel drop, and the stamp needs no migration on re-import (#915)', () => {
    // Pins the v9→v10 bump landmark: an accidental revert of PROJECT_FORMAT_VERSION
    // goes red here even though the constant-tracking test above would still pass.
    // The literal moves with every format bump BY DESIGN — that is what makes it a
    // landmark rather than a restatement of the constant-tracking test above.
    expect(PROJECT_FORMAT_VERSION).toBe(10);
    const payload = buildDagExportPayload({ id: 'p1', name: 'Proj' }, emptyDagState(), 0);
    expect(payload.formatVersion).toBe(10);
    // Round-trip: re-importing a freshly exported file must NOT replay the migration
    // ladder — the stamp is already current, so migrateProjectFormat is a clean no-op
    // (this is the whole point of #428: a stale stamp would re-run every migration).
    const reimported = migrateProjectFormat(JSON.parse(JSON.stringify(payload)));
    expect((reimported as { formatVersion: number }).formatVersion).toBe(10);
  });

  it('carries the project identity, the DAG snapshot, and the timestamp through unchanged', () => {
    const dag = emptyDagState();
    const payload = buildDagExportPayload({ id: 'abc', name: 'My Scene' }, dag, 1234);
    expect(payload.id).toBe('abc');
    expect(payload.name).toBe('My Scene');
    // VALUE-unchanged, deliberately not the same object — see the #620 test below.
    // This assertion read `toBe(dag)` until #620, which is to say the aliasing was
    // pinned as intended behaviour by the test named "snapshot".
    expect(payload.state).toEqual(dag);
    expect(payload.exportedAt).toBe(1234);
  });

  it('detaches the payload from the live DAG it was built from (#620)', () => {
    const dag = emptyDagState();
    const payload = buildDagExportPayload({ id: 'abc', name: 'My Scene' }, dag, 1234);

    expect(payload.state).not.toBe(dag);
    expect(payload.state.nodes).not.toBe(dag.nodes);
    expect(payload.state.outputs).not.toBe(dag.outputs);

    // The reachability property, stated as the failure it prevents: a caller that
    // adjusts the payload before writing must not be editing the open scene.
    (payload.state.nodes as Record<string, unknown>).stripped = { id: 'x' };
    expect('stripped' in dag.nodes).toBe(false);
  });
});
