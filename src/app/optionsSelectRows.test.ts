// optionsSelectRows (#1064) — the stored value always has a row, so a native <select> can
// always show it. The DOM half of the defect (a select falling back to its first option) is
// observed in e2e; this pins the rule the DOM depends on.

import { describe, expect, it } from 'vitest';
import type { ParamOption } from '../nodes/paramWidget';
import { optionsSelectRows } from './optionsSelectRows';

const KEY: ParamOption = { value: 'Key', label: 'Key' };
const RIM: ParamOption = { value: 'Rim', label: 'Rim' };
const BLANK: ParamOption = {
  value: '',
  label: 'unnamed rig',
  disabledReason: 'name it to select it',
};

const view = (m: ReturnType<typeof optionsSelectRows>) =>
  m.rows.map((r) => `${r.value}|${r.label}|${r.disabled ? 'disabled' : 'enabled'}`);

describe('optionsSelectRows (#1064)', () => {
  it('a stored value an option carries: none first, then the options, nothing stale', () => {
    const m = optionsSelectRows('Rim', [KEY, RIM], '— no profile —');
    expect({ stale: m.stale, rows: view(m) }).toEqual({
      stale: false,
      rows: ['|— no profile —|enabled', 'Key|Key|enabled', 'Rim|Rim|enabled'],
    });
  });

  it('a stored value no option carries gets its own row, first, disabled and marked not found', () => {
    const m = optionsSelectRows('Gone', [KEY, RIM], '— no profile —');
    expect({ stale: m.stale, rows: view(m) }).toEqual({
      stale: true,
      rows: [
        'Gone|Gone — not found|disabled',
        '|— no profile —|enabled',
        'Key|Key|enabled',
        'Rim|Rim|enabled',
      ],
    });
  });

  it('empty with no option carrying it is plain none, not stale', () => {
    const m = optionsSelectRows('', [KEY], '— none —');
    expect({ stale: m.stale, rows: view(m) }).toEqual({
      stale: false,
      rows: ['|— none —|enabled', 'Key|Key|enabled'],
    });
  });

  it('when an option carries "", it replaces the none row rather than sharing its value', () => {
    // Two rows with value "" would show "none" for a value that in fact selects the option.
    const m = optionsSelectRows('', [KEY, BLANK], '— no profile —');
    expect({ stale: m.stale, rows: view(m) }).toEqual({
      stale: false,
      rows: ['Key|Key|enabled', '|unnamed rig — name it to select it|disabled'],
    });
  });

  it('the caller can word the stale row', () => {
    const m = optionsSelectRows('n_box', [KEY], '— none —', (v) => `${v} — not a valid target`);
    expect(m.rows[0]).toEqual({
      key: 'stale',
      value: 'n_box',
      label: 'n_box — not a valid target',
      disabled: true,
      stale: true,
    });
  });

  it('property: whatever is stored, some row carries it, so a native select can show it', () => {
    // The DOM rule: a select shows the first row whose value equals the stored value, and
    // falls back to row 0 when there is none. So the one thing that must never happen is a
    // stored value with no row — checked over every pairing of these lists and values.
    const lists: ParamOption[][] = [[], [KEY], [KEY, RIM], [KEY, BLANK], [BLANK]];
    const stored = ['', 'Key', 'Rim', 'Gone'];
    let examined = 0;
    const wrong: string[] = [];
    for (const options of lists) {
      for (const s of stored) {
        examined++;
        const first = optionsSelectRows(s, options, 'none').rows.find((r) => r.value === s);
        if (!first) wrong.push(`${JSON.stringify(s)} over ${options.length}: no row`);
      }
    }
    expect({ examined, wrong }).toEqual({ examined: 20, wrong: [] });
  });

  it('#1569 — a param that cannot be empty is offered no none row', () => {
    expect(view(optionsSelectRows('Key', [KEY, RIM], null))).toEqual([
      'Key|Key|enabled',
      'Rim|Rim|enabled',
    ]);
    // A stored value no option offers still has its row.
    expect(view(optionsSelectRows('Gone', [KEY], null))).toEqual([
      'Gone|Gone — not found|disabled',
      'Key|Key|enabled',
    ]);
  });
});
