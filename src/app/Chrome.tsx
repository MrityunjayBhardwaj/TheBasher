import { useState } from 'react';
import { useProjectStore } from '../core/project/store';
import { saveCurrent } from './boot';
import { ModeSwitcher } from './ModeSwitcher';
import { ProjectsMenu } from './ProjectsMenu';
// P6 W3 — ComfyStatusIndicator migrated from this Chrome cluster to
// ProjectTabs's right edge per UI-SPEC §5.10. The temporary W2 mount
// here is removed; the indicator now lives on R1 alongside the project
// tabs strip.

export function Chrome() {
  const projectName = useProjectStore((s) => s.current?.name ?? 'Untitled');
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  const onSave = async () => {
    setSaving(true);
    try {
      await saveCurrent();
      setSavedAt(Date.now());
    } finally {
      setSaving(false);
    }
  };

  return (
    <header
      data-testid="chrome"
      className="flex items-center justify-between border-b border-border bg-bg px-4 py-2 font-mono text-xs text-fg"
    >
      <div className="flex items-center gap-3">
        <span className="text-accent">basher</span>
        <span className="text-fg/30">/</span>
        <span className="text-fg/80" data-testid="project-name">
          {projectName}
        </span>
      </div>
      <div className="flex items-center gap-4">
        <button
          type="button"
          onClick={onSave}
          disabled={saving}
          data-testid="save-button"
          className="rounded border border-border bg-muted px-2 py-1 text-xs hover:border-accent disabled:opacity-50"
        >
          {saving ? 'saving…' : 'save'}
        </button>
        {savedAt && (
          <span data-testid="save-status" className="text-[10px] text-fg/40">
            saved {new Date(savedAt).toLocaleTimeString()}
          </span>
        )}
        <ProjectsMenu />
        <ModeSwitcher />
      </div>
    </header>
  );
}
