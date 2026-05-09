import { useModeStore, type Mode } from './stores/modeStore';

const OPTIONS: { value: Mode; label: string }[] = [
  { value: 'edit', label: 'Edit' },
  { value: 'run', label: 'Run' },
  { value: 'animate', label: 'Animate' },
  { value: 'director', label: 'Director' },
];

export function ModeSwitcher() {
  const mode = useModeStore((s) => s.mode);
  const setMode = useModeStore((s) => s.setMode);
  return (
    <label className="flex items-center gap-2 text-xs text-fg/70">
      mode
      <select
        data-testid="mode-switcher"
        className="rounded border border-border bg-muted px-2 py-1 text-xs text-fg focus:border-accent focus:outline-none"
        value={mode}
        onChange={(e) => setMode(e.target.value as Mode)}
      >
        {OPTIONS.map((opt) => (
          <option key={opt.value} value={opt.value}>
            {opt.label}
          </option>
        ))}
      </select>
    </label>
  );
}
