// SpareParamControls — the inspector authoring surface for a node's spare params
// (#294, Epic 1 Inc 3). Spare params (node.spare, V89) are the controller datum:
// arbitrary user-named scalar/vec/bool/string params that live OUTSIDE the node's
// fixed per-type paramSchema (F2 — every node is extensible, no privileged Controller
// type). This surface adds / edits / removes them and toggles the `promoted` flag
// that surfaces one in the scene-wide Controllers dock (decision D-3).
//
// It renders for EVERY node kind (spare params are universal), so it is a footer
// control appended after the declared inspector sections — NOT a per-node-type
// section. Every edit routes through the setSpareParam / removeSpareParam ops
// (Inc 0), so it is a pure V34 view over node.spare with undo-safe inverses.
//
// Q1 disjointness (settled Inc 2, readBaseParam.ts): a spare param may NOT shadow a
// real fixed-schema param of the same name (a real param always wins the read). This
// surface enforces it at authoring time — the add is rejected with an inline reason
// when the name collides with a fixed param or an existing spare (V38 — no silent
// no-op).
//
// REF: src/core/dag/types.ts (SpareParamSchema + promoted); src/core/dag/ops.ts
//      (applySetSpareParam / applyRemoveSpareParam); src/app/readBaseParam.ts (Q1);
//      decisions D-3 / F2; vyapti V89; issue #294.

import { useMemo, useState } from 'react';
import { useStoreWithEqualityFn } from 'zustand/traditional';
import { useDagStore } from '../core/dag/store';
import { useNotificationStore } from './stores/notificationStore';
import type { SpareParam } from '../core/dag/types';

const SPARE_TYPES = ['float', 'int', 'bool', 'string', 'vec2', 'vec3'] as const;
type SpareType = (typeof SPARE_TYPES)[number];

/** The zero value for a freshly-added spare param of `type`. */
export function defaultSpareValue(type: SpareType): unknown {
  switch (type) {
    case 'float':
    case 'int':
      return 0;
    case 'bool':
      return false;
    case 'string':
      return '';
    case 'vec2':
      return [0, 0];
    case 'vec3':
      return [0, 0, 0];
  }
}

/** A spare name is addable iff it is non-empty, not already a spare on this node,
 *  and does NOT collide with a fixed param key (Q1 — a real param wins the read, so
 *  a colliding spare would be silently unreachable). Returns the rejection reason,
 *  or null when the name is free. */
export function spareNameRejection(
  name: string,
  fixedParamKeys: readonly string[],
  existingSpareKeys: readonly string[],
): string | null {
  const trimmed = name.trim();
  if (!trimmed) return 'name required';
  if (existingSpareKeys.includes(trimmed)) return `"${trimmed}" already exists`;
  if (fixedParamKeys.includes(trimmed)) return `"${trimmed}" collides with a built-in param`;
  return null;
}

export function SpareParamControls({ nodeId }: { nodeId: string }) {
  const dispatchAtomic = useDagStore((s) => s.dispatchAtomic);
  // The node's spare bag — a stable ref across unrelated edits (immutable ops), so
  // default identity equality re-renders only when this node's spare changes.
  const spare = useStoreWithEqualityFn(
    useDagStore,
    (s) => s.state.nodes[nodeId]?.spare ?? null,
    Object.is,
  );
  const fixedParamKeys = useStoreWithEqualityFn(
    useDagStore,
    (s) => {
      const params = s.state.nodes[nodeId]?.params;
      return params && typeof params === 'object'
        ? Object.keys(params as object)
            .sort()
            .join(',')
        : '';
    },
    Object.is,
  );
  const fixedKeys = useMemo(
    () => (fixedParamKeys ? fixedParamKeys.split(',') : []),
    [fixedParamKeys],
  );

  const entries = useMemo(() => Object.entries(spare ?? {}), [spare]);

  const setSpare = (key: string, param: SpareParam) => {
    dispatchAtomic([{ type: 'setSpareParam', nodeId, key, param }], 'user', `edit spare ${key}`);
  };
  const removeSpare = (key: string) => {
    dispatchAtomic([{ type: 'removeSpareParam', nodeId, key }], 'user', `remove spare ${key}`);
  };

  return (
    <section
      data-testid="inspector-spare-controls"
      className="flex flex-col border-t border-border"
    >
      <div className="flex items-center gap-2 px-3 py-1.5 font-mono text-[10px] uppercase tracking-wide text-fg/60">
        <span>Controls</span>
        <span className="text-fg/30">spare params</span>
      </div>
      {entries.length > 0 ? (
        <div className="flex flex-col">
          {entries.map(([key, param]) => (
            <SpareParamRow
              key={key}
              name={key}
              param={param}
              onChange={(next) => setSpare(key, next)}
              onRemove={() => removeSpare(key)}
            />
          ))}
        </div>
      ) : (
        <div className="px-3 pb-1 text-[10px] text-fg/30">
          No spare params. Add a controller knob below.
        </div>
      )}
      <AddSpareRow
        fixedParamKeys={fixedKeys}
        existingSpareKeys={entries.map(([k]) => k)}
        onAdd={setSpare}
      />
    </section>
  );
}

function SpareParamRow({
  name,
  param,
  onChange,
  onRemove,
}: {
  name: string;
  param: SpareParam;
  onChange: (next: SpareParam) => void;
  onRemove: () => void;
}) {
  const promoted = param.promoted === true;
  return (
    <div
      data-testid={`spare-row-${name}`}
      className="flex items-center gap-1.5 px-3 py-1 text-[11px]"
    >
      <button
        type="button"
        onClick={() => onChange({ ...param, promoted: !promoted })}
        aria-label={
          promoted ? `Remove ${name} from Controllers dock` : `Show ${name} in Controllers dock`
        }
        aria-pressed={promoted}
        title={promoted ? 'Promoted to Controllers dock' : 'Promote to Controllers dock'}
        data-testid={`spare-promote-${name}`}
        className={`select-none leading-none focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent ${
          promoted ? 'text-accent' : 'text-fg/25 hover:text-fg/60'
        }`}
      >
        {promoted ? '★' : '☆'}
      </button>
      <span className="w-20 shrink-0 truncate font-mono text-fg/70" title={name}>
        {name}
      </span>
      <div className="flex-1">
        <SpareValueField param={param} onChange={onChange} testId={`spare-value-${name}`} />
      </div>
      <button
        type="button"
        onClick={onRemove}
        aria-label={`Remove spare param ${name}`}
        title="Remove"
        data-testid={`spare-remove-${name}`}
        className="select-none px-0.5 leading-none text-fg/30 hover:text-record focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
      >
        ✕
      </button>
    </div>
  );
}

/** The per-type value editor. Scalars (float/int/bool/string) get a single control;
 *  vec2/vec3 get a compact number tuple. Value edits preserve `type` + `promoted`. */
function SpareValueField({
  param,
  onChange,
  testId,
}: {
  param: SpareParam;
  onChange: (next: SpareParam) => void;
  testId: string;
}) {
  const set = (value: unknown) => onChange({ ...param, value });
  if (param.type === 'bool') {
    return (
      <input
        type="checkbox"
        checked={param.value === true}
        data-testid={testId}
        onChange={(e) => set(e.target.checked)}
        className="h-3 w-3 accent-accent"
      />
    );
  }
  if (param.type === 'string') {
    return (
      <input
        type="text"
        value={typeof param.value === 'string' ? param.value : ''}
        data-testid={testId}
        onChange={(e) => set(e.target.value)}
        className="w-full rounded border border-border bg-muted px-1 py-0.5 font-mono text-[11px] text-fg focus-visible:border-accent focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
      />
    );
  }
  if (param.type === 'vec2' || param.type === 'vec3') {
    const arr = Array.isArray(param.value) ? (param.value as number[]) : [];
    const n = param.type === 'vec2' ? 2 : 3;
    const comps = Array.from({ length: n }, (_, i) => (typeof arr[i] === 'number' ? arr[i] : 0));
    return (
      <div className="flex gap-1">
        {comps.map((c, i) => (
          <input
            key={i}
            type="number"
            value={c}
            data-testid={`${testId}-${i}`}
            onChange={(e) => {
              const next = comps.slice();
              next[i] = e.target.value === '' ? 0 : Number(e.target.value);
              set(next);
            }}
            className="w-full min-w-0 rounded border border-border bg-muted px-1 py-0.5 font-mono text-[11px] text-fg focus-visible:border-accent focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
          />
        ))}
      </div>
    );
  }
  // float / int
  return (
    <input
      type="number"
      step={param.type === 'int' ? 1 : 'any'}
      value={typeof param.value === 'number' ? param.value : 0}
      data-testid={testId}
      onChange={(e) => {
        if (e.target.value === '') return set(0);
        const raw = Number(e.target.value);
        set(param.type === 'int' ? Math.trunc(raw) : raw);
      }}
      className="w-full rounded border border-border bg-muted px-1 py-0.5 font-mono text-[11px] text-fg focus-visible:border-accent focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
    />
  );
}

function AddSpareRow({
  fixedParamKeys,
  existingSpareKeys,
  onAdd,
}: {
  fixedParamKeys: readonly string[];
  existingSpareKeys: readonly string[];
  onAdd: (key: string, param: SpareParam) => void;
}) {
  const [name, setName] = useState('');
  const [type, setType] = useState<SpareType>('float');
  const notify = useNotificationStore((s) => s.notify);

  const add = () => {
    const reason = spareNameRejection(name, fixedParamKeys, existingSpareKeys);
    if (reason) {
      notify({ severity: 'warn', message: `Can't add spare param: ${reason}` });
      return;
    }
    onAdd(name.trim(), { type, value: defaultSpareValue(type) });
    setName('');
  };

  return (
    <div className="flex items-center gap-1.5 px-3 py-1.5 text-[11px]">
      <input
        type="text"
        value={name}
        placeholder="name…"
        aria-label="New spare param name"
        data-testid="spare-add-name"
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            add();
          }
        }}
        className="w-24 rounded border border-border bg-muted px-1 py-0.5 font-mono text-[11px] text-fg focus-visible:border-accent focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
      />
      <select
        value={type}
        aria-label="New spare param type"
        data-testid="spare-add-type"
        onChange={(e) => setType(e.target.value as SpareType)}
        className="rounded border border-border bg-muted px-1 py-0.5 text-[11px] text-fg focus-visible:border-accent focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
      >
        {SPARE_TYPES.map((t) => (
          <option key={t} value={t}>
            {t}
          </option>
        ))}
      </select>
      <button
        type="button"
        onClick={add}
        data-testid="spare-add-button"
        className="rounded border border-border px-1.5 py-0.5 text-[10px] text-fg/70 hover:bg-muted hover:text-fg focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
      >
        + Add
      </button>
    </div>
  );
}
