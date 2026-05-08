// Dopesheet — read-only projection of every AnimationLayer + its channels
// in the project. Rows: one per channel; diamonds: one per keyframe.
// Layer rows carry mute / solo toggles + the layer name.
//
// THESIS §13: top of the timeline drawer. Bottom is the curve editor.
//
// V8 file-rooted: this component reads useDagStore + useSelectionStore +
// useTimelineSelection but never dispatches. Mute / solo toggles dispatch
// from the layer-row component imported from src/app/.

import { useDagStore } from '../core/dag/store';
import type { Node } from '../core/dag/types';
import { useTimeStore } from '../app/stores/timeStore';
import { useSelectionStore } from '../app/stores/selectionStore';
import { useTimelineSelection } from './timelineSelection';
import { LayerRowControls } from '../app/timeline/LayerRowControls';

const CHANNEL_TYPES = new Set([
  'KeyframeChannelNumber',
  'KeyframeChannelVec3',
  'KeyframeChannelQuat',
  'KeyframeChannelColor',
]);

interface ChannelRow {
  channelId: string;
  channelType: string;
  name: string;
  paramPath: string;
  target: string;
  keyframes: ReadonlyArray<{ time: number }>;
}

interface LayerGroup {
  layerId: string;
  layerName: string;
  mute: boolean;
  solo: boolean;
  channels: ChannelRow[];
}

export function Dopesheet({ duration }: { duration: number }) {
  const nodes = useDagStore((s) => s.state.nodes);
  const seconds = useTimeStore((s) => s.seconds);
  const primarySelection = useSelectionStore((s) => s.primaryNodeId);
  const activeChannelId = useTimelineSelection((s) => s.activeChannelId);
  const setActiveChannel = useTimelineSelection((s) => s.setActiveChannel);

  const layers = collectLayers(nodes);
  const orphanChannels = collectOrphanChannels(nodes, layers);

  return (
    <div
      data-testid="dopesheet"
      className="flex h-full w-full flex-col overflow-auto bg-bg text-fg"
    >
      <DopesheetHeader duration={duration} seconds={seconds} />
      <div className="flex-1 overflow-auto">
        {layers.length === 0 && orphanChannels.length === 0 ? (
          <EmptyHint />
        ) : (
          <>
            {layers.map((layer) => (
              <LayerSection
                key={layer.layerId}
                layer={layer}
                duration={duration}
                seconds={seconds}
                primarySelection={primarySelection}
                activeChannelId={activeChannelId}
                setActiveChannel={setActiveChannel}
              />
            ))}
            {orphanChannels.length > 0 && (
              <div className="border-t border-line">
                <div className="px-3 py-1 text-xs uppercase text-mute">unwired channels</div>
                {orphanChannels.map((c) => (
                  <ChannelRowView
                    key={c.channelId}
                    channel={c}
                    duration={duration}
                    seconds={seconds}
                    primarySelection={primarySelection}
                    isActive={activeChannelId === c.channelId}
                    onClick={() => setActiveChannel(c.channelId)}
                  />
                ))}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function DopesheetHeader({ duration, seconds }: { duration: number; seconds: number }) {
  // Tick marks every 0.5s. Time labels every 1s.
  const ticks: number[] = [];
  for (let t = 0; t <= duration; t += 0.5) ticks.push(t);
  return (
    <div className="relative h-6 border-b border-line bg-bg-2 select-none">
      <div className="absolute left-32 right-0 top-0 h-full">
        {ticks.map((t) => {
          const left = `${(t / Math.max(duration, 0.0001)) * 100}%`;
          const isWhole = Number.isInteger(t);
          return (
            <div
              key={t}
              className="absolute top-0 h-full"
              style={{ left, borderLeft: isWhole ? '1px solid var(--line)' : '1px dotted var(--line-2)' }}
            >
              {isWhole && <span className="ml-1 text-[10px] text-mute">{t}s</span>}
            </div>
          );
        })}
        <div
          data-testid="dopesheet-playhead"
          className="absolute top-0 h-full bg-accent"
          style={{
            left: `${(seconds / Math.max(duration, 0.0001)) * 100}%`,
            width: 1,
          }}
        />
      </div>
    </div>
  );
}

function LayerSection({
  layer,
  duration,
  seconds,
  primarySelection,
  activeChannelId,
  setActiveChannel,
}: {
  layer: LayerGroup;
  duration: number;
  seconds: number;
  primarySelection: string | null;
  activeChannelId: string | null;
  setActiveChannel: (id: string) => void;
}) {
  return (
    <div data-testid={`layer-${layer.layerId}`} className="border-b border-line/40">
      <div className="flex items-center gap-2 bg-bg-2 px-2 py-1 text-xs">
        <span className="font-semibold">{layer.layerName}</span>
        <span className="text-mute">{layer.channels.length} ch</span>
        <span className="flex-1" />
        <LayerRowControls layerId={layer.layerId} mute={layer.mute} solo={layer.solo} />
      </div>
      {layer.channels.map((c) => (
        <ChannelRowView
          key={c.channelId}
          channel={c}
          duration={duration}
          seconds={seconds}
          primarySelection={primarySelection}
          isActive={activeChannelId === c.channelId}
          onClick={() => setActiveChannel(c.channelId)}
        />
      ))}
    </div>
  );
}

function ChannelRowView({
  channel,
  duration,
  primarySelection,
  isActive,
  onClick,
}: {
  channel: ChannelRow;
  duration: number;
  seconds: number;
  primarySelection: string | null;
  isActive: boolean;
  onClick: () => void;
}) {
  const drivesPrimary = primarySelection !== null && channel.target === primarySelection;
  return (
    <div
      data-testid={`channel-row-${channel.channelId}`}
      data-active={isActive}
      className={`flex h-6 items-center text-xs ${isActive ? 'bg-accent/10' : ''} ${drivesPrimary ? 'text-fg' : 'text-mute'}`}
      onClick={onClick}
    >
      <div className="flex w-32 items-center gap-2 truncate px-2" title={`${channel.target}.${channel.paramPath}`}>
        <span className="truncate">{channel.name || channel.paramPath}</span>
      </div>
      <div className="relative h-full flex-1 border-l border-line">
        {channel.keyframes.map((k, i) => (
          <div
            key={`${k.time}-${i}`}
            data-testid={`keyframe-diamond-${channel.channelId}-${i}`}
            className="absolute top-1/2 -translate-x-1/2 -translate-y-1/2 rotate-45 bg-fg"
            style={{
              left: `${(k.time / Math.max(duration, 0.0001)) * 100}%`,
              width: 8,
              height: 8,
            }}
          />
        ))}
      </div>
    </div>
  );
}

function EmptyHint() {
  return (
    <div className="flex h-full items-center justify-center p-6 text-xs text-mute">
      <span>
        No animation channels. Use the agent or a Mutator to add a layer + channel
        to a selected node.
      </span>
    </div>
  );
}

function collectLayers(nodes: Record<string, Node>): LayerGroup[] {
  const layers: LayerGroup[] = [];
  for (const node of Object.values(nodes)) {
    if (node.type !== 'AnimationLayer') continue;
    const params = (node.params ?? {}) as { name?: string; mute?: boolean; solo?: boolean };
    const layer: LayerGroup = {
      layerId: node.id,
      layerName: params.name ?? 'Layer',
      mute: params.mute ?? false,
      solo: params.solo ?? false,
      channels: [],
    };
    const animation = (node.inputs as Record<string, unknown>).animation;
    const refs = Array.isArray(animation) ? animation : animation ? [animation] : [];
    for (const ref of refs) {
      const channelId = (ref as { node: string }).node;
      const channelNode = nodes[channelId];
      if (!channelNode || !CHANNEL_TYPES.has(channelNode.type)) continue;
      layer.channels.push(makeChannelRow(channelNode));
    }
    layers.push(layer);
  }
  return layers;
}

function collectOrphanChannels(nodes: Record<string, Node>, layers: LayerGroup[]): ChannelRow[] {
  const claimed = new Set<string>();
  for (const l of layers) for (const c of l.channels) claimed.add(c.channelId);
  const orphans: ChannelRow[] = [];
  for (const node of Object.values(nodes)) {
    if (!CHANNEL_TYPES.has(node.type)) continue;
    if (claimed.has(node.id)) continue;
    orphans.push(makeChannelRow(node));
  }
  return orphans;
}

function makeChannelRow(node: Node): ChannelRow {
  const params = (node.params ?? {}) as {
    name?: string;
    target?: string;
    paramPath?: string;
    keyframes?: Array<{ time: number }>;
  };
  return {
    channelId: node.id,
    channelType: node.type,
    name: params.name ?? '',
    paramPath: params.paramPath ?? '',
    target: params.target ?? '',
    keyframes: (params.keyframes ?? []).slice().sort((a, b) => a.time - b.time),
  };
}
