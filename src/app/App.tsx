import { useEffect, useState } from 'react';
import { AddMenu } from './AddMenu';
import { boot } from './boot';
import { Clock } from './Clock';
import { Home } from './Home';
import { KeyboardShortcuts } from './KeyboardShortcuts';
import { Layout } from './Layout';
import { useRouteStore } from './stores/routeStore';
import { ToastViewport } from './ToastViewport';

type BootState = 'pending' | 'ready' | 'failed';

export function App() {
  const [bootState, setBootState] = useState<BootState>('pending');
  const [bootError, setBootError] = useState<string | null>(null);
  const view = useRouteStore((s) => s.view);

  useEffect(() => {
    let cancelled = false;
    boot()
      .then(() => {
        if (!cancelled) setBootState('ready');
      })
      .catch((err: Error) => {
        if (cancelled) return;
        setBootError(err.message);
        setBootState('failed');
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (bootState === 'pending') {
    return (
      <div className="flex h-full w-full items-center justify-center bg-bg text-fg">
        <span className="font-mono text-sm text-accent" data-testid="boot-status">
          basher · booting…
        </span>
      </div>
    );
  }

  if (bootState === 'failed') {
    return (
      <div className="flex h-full w-full items-center justify-center bg-bg text-fg">
        <pre className="font-mono text-sm text-red-400" data-testid="boot-error">
          boot failed: {bootError}
        </pre>
      </div>
    );
  }

  // v0.6 #4 W4 — route branch. boot resolved this to 'home' (first run / stale
  // resume) or 'editor' (resumed a project). The home open handlers + the
  // editor's back-to-home affordance flip it thereafter. CRITICAL: branch HERE,
  // at the App root — the editor tree (Layout → Viewport → R3F Canvas) must NOT
  // be in the React tree while on the home, so the GL canvas mounts exactly once
  // (home XOR editor), never double-mounted.
  if (view === 'home') {
    return <Home />;
  }

  return (
    <>
      <Clock />
      <KeyboardShortcuts />
      <Layout />
      <AddMenu />
      <ToastViewport />
    </>
  );
}
