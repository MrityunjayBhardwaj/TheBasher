// Pure helpers for ProjectTabs (P6 W3). Extracted so vitest can exercise
// them without React or jsdom — see projectTabsHelpers.test.ts.
//
// `formatTooltip` computes the D-UX-12 hover tooltip text statically from
// (now, lastSavedAt, dirty). D-02 locked: no setInterval — the value is
// computed at hover time, so a hover that lands 3 minutes after the save
// shows "saved 3m ago" without any background timer.
//
// REF: docs/UI-SPEC.md §5.1 (D-UX-12); D-02 locked decision (W3).

/**
 * Build the hover tooltip text for a project tab.
 *
 * @param now           Current wall-clock ms (Date.now() at hover time).
 * @param lastSavedAt   Wall-clock ms of the most recent save, or null
 *                      when the project has never been saved this session.
 * @param dirty         True iff there are unsaved edits.
 */
export function formatTooltip(now: number, lastSavedAt: number | null, dirty: boolean): string {
  const ago = formatSavedAgo(now, lastSavedAt);
  return dirty ? `unsaved changes · ${ago}` : ago;
}

/**
 * Relative-time formatter. Granularity: just-now / Ns / Nm / Nh / Nd.
 *   - lastSavedAt === null  → "never saved"
 *   - diff < 10s            → "saved just now"
 *   - diff < 60s            → "saved Ns ago"
 *   - diff < 3600s          → "saved Nm ago"
 *   - diff < 86400s         → "saved Nh ago"
 *   - else                  → "saved Nd ago"
 */
export function formatSavedAgo(now: number, lastSavedAt: number | null): string {
  if (lastSavedAt === null) return 'never saved';
  const diffMs = Math.max(0, now - lastSavedAt);
  const s = Math.floor(diffMs / 1000);
  if (s < 10) return 'saved just now';
  if (s < 60) return `saved ${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `saved ${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `saved ${h}h ago`;
  const d = Math.floor(h / 24);
  return `saved ${d}d ago`;
}
