// ToastViewport — renders the notification (toast) stack from
// notificationStore. Bottom-right corner overlay, above all chrome.
//
// Mounted at the App root (not inside the view3d slot like AssetErrorBanner),
// because toasts must show in ANY mode/space — a render fired from the toolbar
// or a boot-time storage warning is not viewport-scoped.
//
// Severity is conveyed by a COLORED ICON GLYPH (not colour alone — each
// severity has a distinct glyph, and the message text states the condition),
// which keeps the W8 contrast surface minimal: the icon tokens (warn/error/
// accent) are audited as 'ui' graphical objects against bg-2 in
// contrastMatrix.test.ts; the message stays on the high-contrast `fg` token.
// Severity is never carried by a coloured edge, so every classified-as-
// decorative border stays clear of the SC 1.4.11 non-text contrast gate.
//
// Auto-dismiss lives HERE (per-toast setTimeout), keeping notificationStore a
// pure data container. `durationMs: 0` = sticky (no timer; user dismisses).
//
// REF: #170, #148; notificationStore.ts; AssetErrorBanner (sibling surface).

import { useEffect } from 'react';
import { type Toast, type ToastSeverity, useNotificationStore } from './stores/notificationStore';

interface SeverityMeta {
  icon: string;
  /** text-* colour token (audited in contrastMatrix.test.ts). */
  cls: string;
  role: 'status' | 'alert';
  live: 'polite' | 'assertive';
}

const SEVERITY: Record<ToastSeverity, SeverityMeta> = {
  info: { icon: 'ℹ', cls: 'text-accent', role: 'status', live: 'polite' },
  success: { icon: '✓', cls: 'text-accent', role: 'status', live: 'polite' },
  warn: { icon: '⚠', cls: 'text-warn', role: 'alert', live: 'assertive' },
  error: { icon: '⊘', cls: 'text-error', role: 'alert', live: 'assertive' },
};

function ToastItem({ toast }: { toast: Toast }) {
  // dismiss has a stable identity across renders (zustand action), so the
  // timer effect only re-runs when the toast's id or duration changes.
  const dismiss = useNotificationStore((s) => s.dismiss);
  const meta = SEVERITY[toast.severity];

  useEffect(() => {
    if (toast.durationMs <= 0) return; // sticky — user must dismiss
    const h = setTimeout(() => dismiss(toast.id), toast.durationMs);
    return () => clearTimeout(h);
  }, [toast.id, toast.durationMs, dismiss]);

  return (
    <div
      role={meta.role}
      aria-live={meta.live}
      data-testid={`toast-${toast.severity}`}
      className="pointer-events-auto flex w-72 items-start gap-2 rounded border border-border-strong bg-bg-2 px-3 py-2 shadow-lg"
    >
      <span aria-hidden className={`mt-px text-[12px] leading-none ${meta.cls}`}>
        {meta.icon}
      </span>
      <p className="flex-1 text-[11px] leading-snug text-fg">{toast.message}</p>
      <button
        type="button"
        onClick={() => dismiss(toast.id)}
        data-testid="toast-dismiss"
        aria-label="Dismiss notification"
        className="text-[11px] leading-none text-fg-dim hover:text-fg focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
      >
        ✕
      </button>
    </div>
  );
}

export function ToastViewport() {
  const toasts = useNotificationStore((s) => s.toasts);
  if (toasts.length === 0) return null;
  return (
    <div
      data-testid="toast-viewport"
      role="region"
      aria-label="Notifications"
      className="pointer-events-none fixed bottom-4 right-4 z-[100] flex flex-col gap-2"
    >
      {toasts.map((t) => (
        <ToastItem key={t.id} toast={t} />
      ))}
    </div>
  );
}
