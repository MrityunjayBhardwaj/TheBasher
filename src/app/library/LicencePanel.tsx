// #1722 — what a Library asset's licence lets a director do: a compact badge on every tile, and in
// the details the licence, whether commercial use is allowed, the exact credit it needs, and where
// that fact comes from. Your imports also take the director's own answer (`licence.json` beside
// the asset), because the person who imported a file is the one who knows where it came from.
//
// Unknown is never drawn as allowed: an unknown licence has its own amber badge and says to check.

import { useEffect, useState, type ReactNode } from 'react';
import { LICENCE_BADGE, type CommercialUse, type Licence } from '../../core/licensing/licence';
import {
  readUserLicence,
  USER_LICENCE_CHOICES,
  writeUserLicence,
  type UserLicenceChoice,
} from '../licence/assetLicences';
import { formatAssetError, useAssetErrorStore } from '../stores/assetErrorStore';
import { useImportRefreshStore } from '../stores/importRefreshStore';
import type { LibraryEntry } from './libraryEntries';

const TONE: Record<CommercialUse, string> = {
  yes: 'border-accent/40 text-accent',
  no: 'border-red-400/50 text-red-300',
  unknown: 'border-warn/50 text-warn',
};

const COMMERCIAL_LABEL: Record<CommercialUse, string> = {
  yes: 'Allowed',
  no: 'Not allowed',
  unknown: 'Unknown — check the terms',
};

/** The tile's licence chip. */
export function LicenceBadge({ licence, testId }: { licence: Licence; testId: string }): ReactNode {
  return (
    <span
      data-testid={testId}
      data-commercial={licence.commercial}
      title={`${licence.name} — ${licence.why}`}
      className={`absolute left-1 top-1 rounded border bg-bg-1 px-1 text-[9px] leading-[14px] ${TONE[licence.commercial]}`}
    >
      {LICENCE_BADGE[licence.kind]}
    </span>
  );
}

/** The details panel's licence section. */
export function LicenceDetails({ entry }: { entry: LibraryEntry }): ReactNode {
  const { licence } = entry;
  const credit =
    licence.credit ??
    (licence.kind === 'unknown'
      ? 'Unknown'
      : licence.kind === 'credit-required'
        ? 'Not recorded — add the credit the creator asks for'
        : 'None needed in a render');
  const rows: [string, string, string][] = [
    ['Licence', licence.name, 'name'],
    ['Commercial', COMMERCIAL_LABEL[licence.commercial], 'commercial'],
    ['Credit', credit, 'credit'],
  ];
  return (
    <section
      data-testid="library-details-licence"
      data-commercial={licence.commercial}
      aria-label="Licence"
      className="flex flex-col gap-1.5 rounded border border-border bg-bg-1/40 p-2"
    >
      <header className="text-[10px] uppercase tracking-wide text-fg-dim">Licence</header>
      <dl className="grid grid-cols-[72px_1fr] gap-x-2 gap-y-1 text-[11px]">
        {rows.map(([k, v, id]) => (
          <div key={k} className="contents">
            <dt className="text-fg-dim">{k}</dt>
            {/* The credit wraps rather than truncates: it is text to copy, not a label. */}
            <dd
              data-testid={`library-details-licence-${id}`}
              className={id === 'credit' ? 'text-fg/90' : 'truncate text-fg/90'}
              title={v}
            >
              {v}
            </dd>
          </div>
        ))}
      </dl>
      <p data-testid="library-details-licence-why" className="text-[11px] text-fg-dim">
        {licence.why}
      </p>
      {entry.source === 'import' && <UserLicenceSetter path={entry.path} />}
    </section>
  );
}

/** The director's own answer for one of their imports, kept beside the asset. */
function UserLicenceSetter({ path }: { path: string }): ReactNode {
  const bump = useImportRefreshStore((s) => s.bump);
  const [choice, setChoice] = useState<UserLicenceChoice>('unknown');
  const [credit, setCredit] = useState('');
  // Read when the tile changes, NOT on every import refresh: this setter's own save bumps the
  // refresh, and re-reading then would overwrite a credit the director is still typing.
  useEffect(() => {
    let cancelled = false;
    void readUserLicence(path).then((r) => {
      if (cancelled) return;
      setChoice(r?.choice ?? 'unknown');
      setCredit(r?.credit ?? '');
    });
    return () => {
      cancelled = true;
    };
  }, [path]);

  function save(next: UserLicenceChoice, nextCredit: string): void {
    void writeUserLicence(path, {
      choice: next,
      ...(next === 'cc-by' && nextCredit.trim() ? { credit: nextCredit.trim() } : {}),
    })
      .then(bump)
      .catch((e: unknown) =>
        useAssetErrorStore.getState().report(path, `licence not saved: ${formatAssetError(e)}`),
      );
  }

  return (
    <div className="flex flex-col gap-1 text-[11px]">
      <label className="flex items-center gap-2">
        <span className="w-[72px] shrink-0 text-fg-dim">Set licence</span>
        <select
          data-testid="library-details-licence-set"
          value={choice}
          onChange={(e) => {
            const next = e.target.value as UserLicenceChoice;
            setChoice(next);
            save(next, credit);
          }}
          className="min-w-0 flex-1 rounded border border-border bg-bg-1 px-1 py-0.5 text-fg focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
        >
          {USER_LICENCE_CHOICES.map((c) => (
            <option key={c.id} value={c.id}>
              {c.label}
            </option>
          ))}
        </select>
      </label>
      {choice === 'cc-by' && (
        <label className="flex items-center gap-2">
          <span className="w-[72px] shrink-0 text-fg-dim">Credit text</span>
          <input
            type="text"
            data-testid="library-details-licence-credit-input"
            value={credit}
            placeholder="e.g. “Robot” by Jane Doe, CC BY 4.0"
            onChange={(e) => setCredit(e.target.value)}
            onBlur={() => save(choice, credit)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') save(choice, credit);
            }}
            className="min-w-0 flex-1 rounded border border-border bg-bg-1 px-1 py-0.5 text-fg focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
          />
        </label>
      )}
    </div>
  );
}
