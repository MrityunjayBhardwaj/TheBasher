// ControlsPanel — the Compositor's Controls panel (Inc 3 Slice D, §7.1). The After
// Effects "Effect Controls" panel, GENERALIZED one step: it exposes the COMPLETE
// input surface of the selected layer's PRODUCER PIPELINE — the `source` (polymorphic
// on the Image socket: MediaClip / ComfyUIWorkflow / scene-render / nested comp) ⊕ the
// `effect` chain ([[V58]] Image→Image operators). Because a Basher `source` can itself
// be a parameterized generative process (ComfyUI), the source's inputs belong in the
// SAME panel as the effects' inputs — unlike AE's dumb footage.
//
// Why a dedicated VIDEO-space rail and NOT the NPanel inspector: in Video mode the
// NPanel inspector is COVERED by the compositor (z-index 45, Layout.tsx) and the
// compositor's layer selection is LOCAL (videoSelectionStore), not the global
// selectionStore NPanel reads. The rail sidesteps both and gives "expose all params"
// real vertical room a 220px twirl-down can't (the design's diminishing-returns home).
//
// Shape (mirrors AE → a pre-validated boundary):
//   - Header: the selected layer name.
//   - One COLLAPSIBLE section per producer, in pipeline order: SOURCE first, then each
//     EFFECT. The section BODY is rendered by a RENDERER REGISTRY keyed on producer
//     kind (node type) → the panel is generic and producer-agnostic. Adding a producer
//     kind = "register one section renderer," not "add a panel."
//
// Two surfaces, one source of truth (the AE contract): this panel = the FULL input
// surface; the timeline twirl-down = the ANIMATED subset (rows with keyframes for
// timing). Both read the SAME [[V57]] channels, so they cannot drift.
//
// REF: docs/COMPOSITOR-DESIGN.md §7.1; docs/COMFYUI-KEYFRAME-COMPILER-DESIGN.md §6.3;
//      src/app/operatorStack.ts (resolveEffectBase + enumerateEffectStack); vyapti
//      V57/V58/V81; hetvabhasa H104/H95. issue #237.

import { useState, type ReactNode } from 'react';
import { useDagStore } from '../../core/dag/store';
import type { DagState } from '../../core/dag/state';
import type { NodeId } from '../../core/dag/types';
import { enumerateEffectStack, resolveEffectBase } from '../operatorStack';
import { useVideoSelectionStore } from './videoSelectionStore';
import { ComfySourceSection } from './ComfyControlsSection';

/** The first source-edge producer id of a layer (single or list binding). */
function firstSourceId(state: DagState, layerId: NodeId): NodeId | undefined {
  const binding = state.nodes[layerId]?.inputs?.source;
  if (Array.isArray(binding)) return (binding[0] as { node: NodeId } | undefined)?.node;
  if (binding && typeof binding === 'object' && 'node' in binding)
    return (binding as { node: NodeId }).node;
  return undefined;
}

/** A producer in the layer's pipeline: the base source, or one effect in the stack. */
interface ProducerSection {
  readonly nodeId: NodeId;
  readonly nodeType: string;
  /** SOURCE (the base producer) or EFFECT (a member of the V58 stack). */
  readonly role: 'source' | 'effect';
  /** A human label for the section header. */
  readonly label: string;
}

/** Walk the selected layer's producer pipeline → ordered sections (SOURCE first,
 *  then each EFFECT base→top — the apply order). Pure read over the DAG. */
function collectProducerSections(state: DagState, layerId: NodeId): ProducerSection[] {
  const srcId = firstSourceId(state, layerId);
  if (!srcId) return [];
  const baseId = resolveEffectBase(state, srcId);
  const base = state.nodes[baseId];
  const sections: ProducerSection[] = [];
  if (base) {
    sections.push({
      nodeId: baseId,
      nodeType: base.type,
      role: 'source',
      label: producerLabel(base.type),
    });
  }
  for (const entry of enumerateEffectStack(state, baseId)) {
    sections.push({
      nodeId: entry.nodeId,
      nodeType: entry.type,
      role: 'effect',
      label: entry.type,
    });
  }
  return sections;
}

/** A friendly header label for a source producer kind. */
function producerLabel(nodeType: string): string {
  switch (nodeType) {
    case 'ComfyUIWorkflow':
      return 'ComfyUI Workflow';
    case 'MediaClip':
      return 'Media';
    default:
      return nodeType;
  }
}

/** A section-body renderer takes the producer node id and returns its param rows.
 *  The registry is keyed on node type so the panel is producer-agnostic (§7.1). */
type SectionRenderer = (props: { nodeId: NodeId }) => ReactNode;

/** The producer-kind → section-renderer registry. The ComfyUIWorkflow SOURCE
 *  renderer is the first one (Slice D); MediaClip / scene-render / effects fold in
 *  as later registrations (steps 2–3). An unregistered kind shows a neutral note
 *  rather than nothing — the section header is still discoverable. */
const SECTION_RENDERERS: Record<string, SectionRenderer> = {
  // ComfyUIWorkflow = the first source renderer (Slice D). ColorCorrect (effects)
  // registers in step 3. The shell renders a neutral note for any unregistered kind.
  ComfyUIWorkflow: ComfySourceSection,
};

function NoControlsBody({ nodeType }: { nodeType: string }) {
  return (
    <p className="px-3 py-2 text-[11px] text-mute" data-testid="controls-section-empty">
      No controls for {nodeType} yet.
    </p>
  );
}

export function ControlsPanel() {
  const selectedLayerId = useVideoSelectionStore((s) => s.selectedLayerId);
  const layerName = useDagStore((s) => {
    if (!selectedLayerId) return null;
    const n = s.state.nodes[selectedLayerId];
    if (!n || n.type !== 'Layer') return null;
    return (n.params as { name?: string }).name ?? selectedLayerId;
  });
  const sections = useDagStore((s) =>
    selectedLayerId && s.state.nodes[selectedLayerId]?.type === 'Layer'
      ? collectProducerSections(s.state, selectedLayerId)
      : [],
  );

  return (
    <div
      data-testid="controls-panel"
      className="flex h-full w-72 shrink-0 flex-col border-l border-line bg-bg text-fg"
    >
      <div
        className="flex items-center border-b border-line px-3 text-[10px] uppercase tracking-wide text-mute"
        style={{ height: 28 }}
      >
        Controls
      </div>
      {layerName === null ? (
        <div
          data-testid="controls-panel-empty"
          className="flex flex-1 items-center justify-center px-4 text-center text-[11px] text-mute"
        >
          Select a layer to edit its controls.
        </div>
      ) : (
        <div className="flex flex-1 flex-col overflow-auto">
          <div
            className="truncate border-b border-line px-3 py-1.5 text-[12px] text-fg"
            data-testid="controls-panel-layer-name"
            title={layerName}
          >
            {layerName}
          </div>
          {sections.length === 0 ? (
            <p className="px-3 py-2 text-[11px] text-mute">This layer has no source yet.</p>
          ) : (
            sections.map((section) => (
              <ProducerSectionView key={section.nodeId} section={section} />
            ))
          )}
        </div>
      )}
    </div>
  );
}

/** One collapsible producer section: a header (role badge + label) over the body
 *  the registry renders for that producer kind. */
function ProducerSectionView({ section }: { section: ProducerSection }) {
  const [open, setOpen] = useState(true);
  const Renderer = SECTION_RENDERERS[section.nodeType];
  return (
    <div
      data-testid={`controls-section-${section.nodeId}`}
      data-role={section.role}
      className="border-b border-line"
    >
      <button
        type="button"
        data-testid={`controls-section-toggle-${section.nodeId}`}
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 px-2 py-1.5 text-left text-[11px] hover:bg-muted/30 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
      >
        <span className="w-3 select-none text-center text-mute">{open ? '▾' : '▸'}</span>
        <span className="rounded bg-bg-2 px-1 text-[9px] uppercase tracking-wide text-mute">
          {section.role}
        </span>
        <span className="flex-1 truncate text-fg" title={section.label}>
          {section.label}
        </span>
      </button>
      {open ? (
        <div className="pb-1">
          {Renderer ? (
            <Renderer nodeId={section.nodeId} />
          ) : (
            <NoControlsBody nodeType={section.nodeType} />
          )}
        </div>
      ) : null}
    </div>
  );
}
