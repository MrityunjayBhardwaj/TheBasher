// Asset-error banner (#83 gap 2) — the 2D surface for load failures the
// AssetErrorBoundary catches inside the R3F canvas tree.
//
// Renders nothing when no asset has failed. When one or more have, shows
// a dismissible strip listing each "<assetRef> — <reason>". Dismissing
// clears that asset's entry; a successful re-import (boundary remounts
// on assetRef change → componentWillUnmount clears) also removes it.
//
// Sits in the view3d slot above the viewport (same region as DiffBar).
// V8 file-rooted: src/app/, reads the assetErrorStore projection only.
//
// REF: #83 gap 2, src/viewport/AssetErrorBoundary.tsx, src/app/stores/assetErrorStore.ts.

import { useAssetErrorStore } from './stores/assetErrorStore';

export function AssetErrorBanner() {
  const errors = useAssetErrorStore((s) => s.errors);
  const clear = useAssetErrorStore((s) => s.clear);
  const entries = Object.entries(errors);
  if (entries.length === 0) return null;

  return (
    <div
      data-testid="asset-error-banner"
      role="alert"
      style={{
        position: 'absolute',
        top: 0,
        left: 0,
        right: 0,
        zIndex: 20,
        display: 'flex',
        flexDirection: 'column',
        gap: 2,
        background: '#3a1a1a',
        borderBottom: '1px solid #5a2a2a',
        padding: '4px 12px',
        fontSize: 12,
        color: '#ffb4b4',
      }}
    >
      {entries.map(([assetRef, message]) => (
        <div
          key={assetRef}
          data-testid={`asset-error-row-${assetRef}`}
          style={{ display: 'flex', alignItems: 'center', gap: 8 }}
        >
          <span aria-hidden>⚠</span>
          <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis' }}>
            <span style={{ color: '#ff8888' }}>asset failed:</span>{' '}
            <span style={{ color: '#ffd0d0' }}>{assetRef}</span>
            <span style={{ color: '#cc9999' }}> — {message}</span>
          </span>
          <button
            type="button"
            onClick={() => clear(assetRef)}
            aria-label={`Dismiss error for ${assetRef}`}
            style={{
              border: '1px solid #6a3a3a',
              borderRadius: 4,
              background: '#2a1414',
              color: '#ffb4b4',
              cursor: 'pointer',
              padding: '1px 8px',
              fontSize: 11,
            }}
          >
            Dismiss
          </button>
        </div>
      ))}
    </div>
  );
}
