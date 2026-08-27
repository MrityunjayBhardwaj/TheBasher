// SettingsModal — the app's settings dialog (first surface; ComfyUI epic Inc 2).
//
// Store-driven, mounted once in App, renders nothing when closed (mirrors
// GltfEntryChooser / RenderAnimationProgress). Opened from File ▸ Settings…
//
// Section 1 — ComfyUI Server: the server URL + optional auth header that boot's
// pickComfyUI() targets. "Test Connection" probes the LIVE server (probeComfyUI
// → /system_stats) and shows the verdict + version (observation, not inference)
// — including the CORS 403 a ComfyUI started without `--enable-cors-header`
// returns to the browser. Save persists the draft and resets the cached
// capability so the next request re-probes the new server.

import { useEffect, useState } from 'react';
import { useSettingsStore } from './stores/settingsStore';
import { probeComfyUI, type ComfyProbeResult } from '../core/comfy';
import { resetComfyCapability, resetMotionCapability, resetModelCapability } from './boot';
import { conditionsFor, modelRecordFor } from '../core/licensing/allowedModels';

type TestState = { status: 'idle' | 'testing' } | ({ status: 'done' } & ComfyProbeResult);

export function SettingsModal() {
  const isOpen = useSettingsStore((s) => s.isOpen);
  const close = useSettingsStore((s) => s.close);
  const storedUrl = useSettingsStore((s) => s.comfyUrl);
  const storedAuth = useSettingsStore((s) => s.comfyAuthHeader);
  const storedLive = useSettingsStore((s) => s.comfyLiveGenerate);
  const setComfyUrl = useSettingsStore((s) => s.setComfyUrl);
  const setComfyAuthHeader = useSettingsStore((s) => s.setComfyAuthHeader);
  const setComfyLiveGenerate = useSettingsStore((s) => s.setComfyLiveGenerate);
  const storedMotionUrl = useSettingsStore((s) => s.motionGenUrl);
  const storedMotionModel = useSettingsStore((s) => s.motionGenModel);
  const setMotionGenUrl = useSettingsStore((s) => s.setMotionGenUrl);
  const setMotionGenModel = useSettingsStore((s) => s.setMotionGenModel);
  const storedTripoKey = useSettingsStore((s) => s.tripoApiKey);
  const storedModelVersion = useSettingsStore((s) => s.modelGenVersion);
  const setTripoApiKey = useSettingsStore((s) => s.setTripoApiKey);
  const setModelGenVersion = useSettingsStore((s) => s.setModelGenVersion);

  // Draft state — edits commit only on Save, so Cancel/Esc discards them.
  const [url, setUrl] = useState(storedUrl);
  const [auth, setAuth] = useState(storedAuth);
  const [live, setLive] = useState(storedLive);
  const [motionUrl, setMotionUrl] = useState(storedMotionUrl);
  const [motionModel, setMotionModel] = useState(storedMotionModel);
  const [tripoKey, setTripoKey] = useState(storedTripoKey);
  const [modelVersion, setModelVersion] = useState(storedModelVersion);
  const [test, setTest] = useState<TestState>({ status: 'idle' });

  // Re-seed the draft from the store each time the modal opens.
  useEffect(() => {
    if (isOpen) {
      setUrl(storedUrl);
      setAuth(storedAuth);
      setLive(storedLive);
      setMotionUrl(storedMotionUrl);
      setMotionModel(storedMotionModel);
      setTripoKey(storedTripoKey);
      setModelVersion(storedModelVersion);
      setTest({ status: 'idle' });
    }
  }, [isOpen, storedUrl, storedAuth, storedLive, storedMotionUrl, storedMotionModel]);

  // Esc dismisses (discards the draft). Bound only while open.
  useEffect(() => {
    if (!isOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isOpen, close]);

  // Read live off the draft, so the verdict tracks what is being typed rather
  // than what was last saved.
  const motionVerdict = modelRecordFor(motionModel.trim())?.verdict;
  // Listed, not merely announced. "Allowed, with conditions" tells a director a
  // category; the conditions tell them what they have just agreed to.
  const motionConditions = motionVerdict === 'BLOCKED' ? [] : conditionsFor(motionModel.trim());

  if (!isOpen) return null;

  const onTest = async () => {
    setTest({ status: 'testing' });
    const result = await probeComfyUI(url, { authHeader: auth || undefined });
    setTest({ status: 'done', ...result });
  };

  const onSave = () => {
    setComfyUrl(url);
    setComfyAuthHeader(auth);
    setComfyLiveGenerate(live);
    setMotionGenUrl(motionUrl);
    setMotionGenModel(motionModel);
    setTripoApiKey(tripoKey);
    setModelGenVersion(modelVersion);
    resetComfyCapability(); // next getComfyCapability() re-probes the new server
    resetMotionCapability(); // same session-cache hazard on the motion side
    resetModelCapability(); // and again for the mesh-generation capability
    close();
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Settings"
      data-testid="settings-modal"
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50 backdrop-blur-sm"
      onClick={(e) => {
        if (e.target === e.currentTarget) close();
      }}
    >
      <div className="flex max-h-[90vh] w-[30rem] max-w-[92vw] flex-col gap-4 rounded-lg border border-border bg-bg-2 p-5 shadow-xl">
        <div className="flex items-center justify-between">
          <span className="text-sm font-medium text-fg">Settings</span>
          <button
            type="button"
            data-testid="settings-close"
            onClick={close}
            className="rounded px-1.5 text-fg/50 hover:text-fg focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
            aria-label="Close settings"
          >
            ✕
          </button>
        </div>

        {/* The scrolling BODY. The header and the action row below stay pinned
            outside it, so Save and Cancel are reachable no matter how many
            settings groups exist — three have been added in as many sessions,
            and a panel with no cap overflows a short viewport in BOTH
            directions at once, with a `fixed inset-0` backdrop that cannot
            scroll them back (#768).

            Both `max-h-[90vh]` on the panel and `overflow-y-auto` here are
            load-bearing, each verified by deleting it alone and watching the
            guard red. `min-h-0` is NOT: deleting it changes nothing this
            configuration can observe. It stays as the conventional defence
            against a flex child refusing to shrink below its content, and is
            recorded as unproven rather than claimed — the guard, not this
            comment, is the authority on which of the three matter. */}
        <div
          data-testid="settings-body"
          className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto"
        >
          <section className="flex flex-col gap-2.5">
            <span className="text-xs font-medium uppercase tracking-wide text-fg/60">
              ComfyUI Server
            </span>

            <label className="flex flex-col gap-1">
              <span className="text-[11px] text-fg/60">Server URL</span>
              <input
                type="text"
                data-testid="settings-comfy-url"
                value={url}
                spellCheck={false}
                onChange={(e) => setUrl(e.target.value)}
                placeholder="http://127.0.0.1:8188"
                className="rounded border border-border bg-muted px-2 py-1 font-mono text-xs text-fg focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
              />
            </label>

            <label className="flex flex-col gap-1">
              <span className="text-[11px] text-fg/60">
                Authorization header <span className="text-fg/40">(optional)</span>
              </span>
              <input
                type="text"
                data-testid="settings-comfy-auth"
                value={auth}
                spellCheck={false}
                onChange={(e) => setAuth(e.target.value)}
                placeholder="Bearer …"
                className="rounded border border-border bg-muted px-2 py-1 font-mono text-xs text-fg focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
              />
            </label>

            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                data-testid="settings-comfy-live"
                checked={live}
                onChange={(e) => setLive(e.target.checked)}
                className="accent-accent focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
              />
              <span className="text-[11px] text-fg/60">
                Live generate{' '}
                <span className="text-fg/40">(submit to the server, not the stub)</span>
              </span>
            </label>

            <div className="flex items-center gap-3">
              <button
                type="button"
                data-testid="settings-comfy-test"
                disabled={test.status === 'testing'}
                onClick={() => void onTest()}
                className="rounded bg-accent/10 px-2 py-1 text-[11px] text-accent transition-colors hover:bg-accent/15 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {test.status === 'testing' ? 'Testing…' : 'Test Connection'}
              </button>
              <span data-testid="settings-comfy-status" className="text-[11px]">
                {test.status === 'done' && test.reachable ? (
                  <span className="text-accent">
                    ● Connected{test.version ? ` · ComfyUI ${test.version}` : ''}
                    {test.device ? ` · ${test.device}` : ''}
                  </span>
                ) : test.status === 'done' ? (
                  <span className="text-fg/70">
                    ○ Unreachable{test.error ? ` — ${test.error}` : ''}
                  </span>
                ) : null}
              </span>
            </div>
          </section>

          <section className="flex flex-col gap-2.5">
            <span className="text-xs font-medium uppercase tracking-wide text-fg/60">
              Text to Motion
            </span>

            <label className="flex flex-col gap-1">
              <span className="text-[11px] text-fg/60">
                Service URL{' '}
                <span className="text-fg/40">(unreachable falls back to the offline stub)</span>
              </span>
              <input
                type="text"
                data-testid="settings-motion-url"
                value={motionUrl}
                spellCheck={false}
                onChange={(e) => setMotionUrl(e.target.value)}
                placeholder="http://127.0.0.1:8600"
                className="rounded border border-border bg-muted px-2 py-1 font-mono text-xs text-fg focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
              />
            </label>

            <label className="flex flex-col gap-1">
              <span className="text-[11px] text-fg/60">Checkpoint</span>
              <input
                type="text"
                data-testid="settings-motion-model"
                value={motionModel}
                spellCheck={false}
                onChange={(e) => setMotionModel(e.target.value)}
                placeholder="nvidia/Kimodo-SOMA-RP-v1.1"
                className="rounded border border-border bg-muted px-2 py-1 font-mono text-xs text-fg focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
              />
              {/* The verdict is shown WHILE TYPING, not on save. A licence refusal
                discovered at generation time has already cost the director a
                round trip, and a blocked id is refused on save anyway — telling
                them here is the difference between a rule and an ambush. */}
              <span data-testid="settings-motion-licence" className="text-[11px]">
                {motionVerdict === 'BLOCKED' ? (
                  <span className="text-fg/70">
                    ● Blocked — this checkpoint&rsquo;s terms forbid this use, and it will not be
                    saved
                  </span>
                ) : motionVerdict === 'ALLOWED_WITH_CONDITIONS' ? (
                  <span className="text-accent">● Allowed, with conditions to honour</span>
                ) : motionVerdict === 'ALLOWED' ? (
                  <span className="text-accent">● Allowed</span>
                ) : (
                  <span className="text-fg/50">
                    ○ No recorded licence verdict — generation will refuse it
                  </span>
                )}
              </span>
              {motionConditions.length > 0 && (
                <ul
                  data-testid="settings-motion-conditions"
                  className="ml-3 list-disc space-y-0.5 text-[11px] text-fg/50"
                >
                  {motionConditions.map((c) => (
                    <li key={c}>{c}</li>
                  ))}
                </ul>
              )}
            </label>
          </section>

          <section className="flex flex-col gap-2 border-t border-border pt-3">
            <h3 className="text-xs font-medium text-fg/80">Text to 3D</h3>

            <label className="flex flex-col gap-1">
              <span className="flex items-center gap-1.5 text-[11px] text-fg/60">
                Tripo API key{' '}
                <span className="text-fg/40">(empty generates with the offline stub)</span>
              </span>
              <input
                type="password"
                data-testid="settings-tripo-key"
                value={tripoKey}
                spellCheck={false}
                onChange={(e) => setTripoKey(e.target.value)}
                placeholder="tsk_…"
                className="rounded border border-border bg-muted px-2 py-1 font-mono text-xs text-fg focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
              />
              {/* Shape is checked WHILE TYPING for the same reason the checkpoint's
                verdict is: a key from the wrong field otherwise fails as an
                opaque 401 seconds later, which sends the reader to the wrong
                problem. */}
              <span data-testid="settings-tripo-key-shape" className="text-[11px]">
                {tripoKey.trim() === '' ? (
                  <span className="text-fg/50">○ Not set — the offline stub will generate</span>
                ) : tripoKey.startsWith('tsk_') ? (
                  <span className="text-accent">● Key shape looks right</span>
                ) : (
                  <span className="text-fg/70">
                    ● A Tripo key begins with &ldquo;tsk_&rdquo; — copy it from
                    platform.tripo3d.ai/api-keys
                  </span>
                )}
              </span>
              {/* Said plainly rather than buried: the key is stored in the clear,
                exactly as the ComfyUI auth header above it is. */}
              <span className="text-[11px] text-fg/40">
                Stored unencrypted in this browser. Scope and rotate it at the provider.
              </span>
            </label>

            <label className="flex flex-col gap-1">
              <span className="text-[11px] text-fg/60">Model version</span>
              <input
                type="text"
                data-testid="settings-model-version"
                value={modelVersion}
                spellCheck={false}
                onChange={(e) => setModelVersion(e.target.value)}
                placeholder="v2.5-20250123"
                className="rounded border border-border bg-muted px-2 py-1 font-mono text-xs text-fg focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
              />
              {/* No per-version licence verdict, and the absence is the point: a
                hosted service ships no weights, so what governs use is ONE
                agreement about the service and a version is a menu choice inside
                it. The verdict is consulted once, on the service. */}
              <span data-testid="settings-model-service-licence" className="text-[11px] text-fg/50">
                ○ Tripo&rsquo;s terms are not yet recorded — generation refuses until they are
              </span>
            </label>
          </section>
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-border pt-3">
          <button
            type="button"
            data-testid="settings-cancel"
            onClick={close}
            className="rounded border border-border bg-muted px-3 py-1 text-xs text-fg/80 hover:text-fg focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
          >
            Cancel
          </button>
          <button
            type="button"
            data-testid="settings-save"
            onClick={onSave}
            className="rounded bg-accent/15 px-3 py-1 text-xs text-accent hover:bg-accent/15 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
          >
            Save
          </button>
        </div>
      </div>
    </div>
  );
}
