// Per-asset React error boundary (#83 gap 2).
//
// Wraps a single asset's render subtree (today: GltfAssetR). When the
// asset throws during load/parse — bad bytes, unsupported extension, a
// missing multi-file sibling (#82), a Draco decode failure (#80) — the
// boundary:
//   1. catches the throw (so it does NOT bubble to the Canvas-root
//      <Suspense> and blank the WHOLE viewport),
//   2. reports `{ assetRef, reason }` to the assetErrorStore so the 2D
//      AssetErrorBanner can tell the user which asset failed and why,
//   3. renders nothing in place of the broken asset — the rest of the
//      scene (grid, lights, other meshes) keeps rendering.
//
// Why per-asset, not one boundary around <SceneFromDAG />: a single
// bad asset must not nuke the entire viewport. Each GltfAssetR gets its
// own boundary, keyed by assetRef at the call site so a swapped /
// re-imported asset remounts fresh and re-attempts the load.
//
// Class component because error boundaries require the
// getDerivedStateFromError / componentDidCatch lifecycle, which hooks
// cannot express. This is the project's only class component; isolated
// here on purpose.
//
// REF: #83 gap 2, #82 + #80 (the failure modes it surfaces),
// `src/app/stores/assetErrorStore.ts`.

import { Component, type ErrorInfo, type ReactNode } from 'react';
import { formatAssetError, useAssetErrorStore } from '../app/stores/assetErrorStore';

interface Props {
  assetRef: string;
  children: ReactNode;
}

interface State {
  hasError: boolean;
}

export class AssetErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false };

  static getDerivedStateFromError(): State {
    return { hasError: true };
  }

  componentDidCatch(error: Error, _info: ErrorInfo): void {
    // Report to the store so the 2D banner surfaces it. getState() (not
    // a hook) because this is a class lifecycle method outside React's
    // hook scope.
    useAssetErrorStore.getState().report(this.props.assetRef, formatAssetError(error));
  }

  componentWillUnmount(): void {
    // A boundary keyed by assetRef unmounts when the asset is removed or
    // swapped — clear its error so a stale failure doesn't linger in the
    // banner after the offending asset is gone.
    useAssetErrorStore.getState().clear(this.props.assetRef);
  }

  render(): ReactNode {
    if (this.state.hasError) {
      // Render nothing in the broken asset's place. The scene survives;
      // the banner carries the user-facing reason.
      return null;
    }
    return this.props.children;
  }
}
