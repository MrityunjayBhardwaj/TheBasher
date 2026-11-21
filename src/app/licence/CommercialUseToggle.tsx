// The "For commercial use" switch shown in every film export menu (#1722) — File ▸ Render
// Animation and the compositor's Export. One component so both menus say the same thing and
// flip the same switch. Toggling keeps the menu open, so the director sees the switch change.

import { type ReactNode } from 'react';
import { useExportLicenceStore } from './exportLicenceStore';

export function CommercialUseToggle({ testId }: { testId: string }): ReactNode {
  const on = useExportLicenceStore((s) => s.commercialUse);
  const setOn = useExportLicenceStore((s) => s.setCommercialUse);
  return (
    <button
      type="button"
      role="menuitemcheckbox"
      aria-checked={on}
      data-testid={testId}
      title="Before exporting, list every part whose licence does not allow commercial use"
      onClick={(e) => {
        e.stopPropagation();
        setOn(!on);
      }}
      className="flex w-full items-center gap-2 border-t border-border px-3 py-1.5 text-left text-[11px] text-fg/80 hover:bg-muted focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
    >
      <span
        aria-hidden
        className={`flex h-3 w-3 items-center justify-center rounded-sm border text-[9px] ${
          on ? 'border-accent bg-accent text-bg' : 'border-border'
        }`}
      >
        {on ? '✓' : ''}
      </span>
      <span>For commercial use</span>
    </button>
  );
}
