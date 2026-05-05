import { useEffect, useState } from 'react';
import { boot } from './boot';
import { Clock } from './Clock';
import { KeyboardShortcuts } from './KeyboardShortcuts';
import { Layout } from './Layout';

type BootState = 'pending' | 'ready' | 'failed';

export function App() {
  const [bootState, setBootState] = useState<BootState>('pending');
  const [bootError, setBootError] = useState<string | null>(null);

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

  return (
    <>
      <Clock />
      <KeyboardShortcuts />
      <Layout />
    </>
  );
}
