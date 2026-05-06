// DiffBar — accept/reject UI for pending agent diffs.
//
// Sits above the viewport when a diff is pending. Shows the description,
// per-op toggles, Apply All / Reject, and "X selected of Y" status.
//
// Dispatch lives in src/app/ (V8 file-rooted — dispatch from src/app/ is
// allowed; dispatch from src/viewport/ is not).
//
// REF: THESIS.md §19 (Diff-first), krama K3.

import { useState } from 'react';
import { useDiffStore, acceptSelectedOps } from '../agent/diff';
import { useDagStore } from '../core/dag/store';

export function DiffBar() {
  const status = useDiffStore((s) => s.status);
  const pendingDiff = useDiffStore((s) => s.pendingDiff);
  const toggleOp = useDiffStore((s) => s.toggleOp);
  const selectAll = useDiffStore((s) => s.selectAll);
  const reject = useDiffStore((s) => s.reject);
  const [accepting, setAccepting] = useState(false);

  if (status !== 'pending' || !pendingDiff) return null;

  const total = pendingDiff.ops.length;
  const selectedCount = pendingDiff.selected.filter(Boolean).length;

  const handleApply = () => {
    setAccepting(true);
    try {
      const dag = useDagStore.getState();
      acceptSelectedOps(dag.dispatchAtomic.bind(dag));
    } finally {
      setAccepting(false);
    }
  };

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: '6px 12px',
        background: '#1a1a2e',
        borderBottom: '1px solid #333',
        fontSize: 13,
        color: '#ccc',
      }}
    >
      <span style={{ fontWeight: 600, color: '#88aaff', marginRight: 8 }}>
        Agent Diff
      </span>
      <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {pendingDiff.description}
      </span>
      <span style={{ color: '#888', fontSize: 12 }}>
        {selectedCount}/{total} selected
      </span>

      {selectedCount !== total && (
        <button
          onClick={() => selectAll(true)}
          style={btnStyle}
        >
          Select all
        </button>
      )}

      <button
        onClick={handleApply}
        disabled={accepting || selectedCount === 0}
        style={{
          ...btnStyle,
          background: selectedCount > 0 ? '#2d6a4f' : '#333',
          color: selectedCount > 0 ? '#fff' : '#666',
        }}
      >
        {accepting ? 'Applying...' : `Apply${selectedCount < total ? ` (${selectedCount})` : ''}`}
      </button>

      <button
        onClick={() => reject()}
        style={{
          ...btnStyle,
          background: '#5a1a1a',
          color: '#ff8888',
        }}
      >
        Reject
      </button>
    </div>
  );
}

const btnStyle: React.CSSProperties = {
  border: '1px solid #444',
  borderRadius: 4,
  padding: '3px 10px',
  cursor: 'pointer',
  fontSize: 12,
  background: '#222',
  color: '#aaa',
};
