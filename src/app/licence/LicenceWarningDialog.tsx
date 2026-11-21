// The warning a commercial export raises before it renders (#1722): every part whose licence does
// not clear commercial use — named by the asset, the model or provider, and the licence — and an
// explicit choice. Mounted once in App; renders nothing when no export is waiting.

import { type ReactNode } from 'react';
import { LICENCE_BADGE } from '../../core/licensing/licence';
import { useExportLicenceStore } from './exportLicenceStore';
import { PART_SOURCE_LABEL } from './licenceReport';

export function LicenceWarningDialog(): ReactNode {
  const pending = useExportLicenceStore((s) => s.pending);
  const answer = useExportLicenceStore((s) => s.answer);
  if (!pending) return null;
  return (
    <div
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="licence-warning-title"
      data-testid="licence-warning"
      className="fixed inset-0 z-[110] flex items-center justify-center bg-black/50 backdrop-blur-sm"
    >
      <div className="flex max-h-[80vh] w-[520px] flex-col gap-3 rounded-lg border border-border bg-bg-2 p-5 shadow-xl">
        <h2 id="licence-warning-title" className="text-sm font-medium text-fg">
          This film is marked for commercial use
        </h2>
        <p className="text-[12px] text-fg/70">
          {pending.parts.length === 1 ? 'One part' : `${pending.parts.length} parts`} of this
          project {pending.parts.length === 1 ? 'is' : 'are'} not cleared for commercial use. Check
          each one before you sell or publish the film.
        </p>
        <ul
          data-testid="licence-warning-parts"
          className="flex flex-col gap-1.5 overflow-y-auto rounded border border-border bg-bg-1/40 p-2"
        >
          {pending.parts.map((part, i) => (
            <li
              key={`${part.nodeId}:${part.model ?? part.path ?? i}`}
              data-testid="licence-warning-part"
              data-commercial={part.licence.commercial}
              className="flex flex-col gap-0.5 text-[11px]"
            >
              <div className="flex items-baseline gap-2">
                <span data-testid="licence-warning-asset" className="font-medium text-fg">
                  {part.asset}
                </span>
                <span className="text-fg-dim">{PART_SOURCE_LABEL[part.source]}</span>
                <span
                  className={`ml-auto rounded px-1 text-[10px] ${
                    part.licence.commercial === 'no'
                      ? 'bg-red-500/15 text-red-300'
                      : 'bg-warn/15 text-warn'
                  }`}
                >
                  {part.licence.commercial === 'no' ? 'Not for commercial use' : 'Unknown'}
                </span>
              </div>
              {part.model !== null && (
                <span data-testid="licence-warning-model" className="font-mono text-fg/80">
                  {part.model}
                </span>
              )}
              <span className="text-fg-dim">
                {part.licence.kind === 'unknown'
                  ? part.licence.why
                  : `${LICENCE_BADGE[part.licence.kind]} · ${part.licence.name}`}
              </span>
            </li>
          ))}
        </ul>
        <div className="flex justify-end gap-2">
          <button
            type="button"
            autoFocus
            data-testid="licence-warning-cancel"
            onClick={() => answer(false)}
            className="rounded border border-border bg-muted px-3 py-1 text-xs text-fg/80 hover:text-accent focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
          >
            Cancel export
          </button>
          <button
            type="button"
            data-testid="licence-warning-confirm"
            onClick={() => answer(true)}
            className="rounded border border-border bg-bg px-3 py-1 text-xs text-fg hover:border-accent hover:text-accent focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
          >
            I have checked — export anyway
          </button>
        </div>
      </div>
    </div>
  );
}
