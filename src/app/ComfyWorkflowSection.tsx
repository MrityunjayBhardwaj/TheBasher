// ComfyWorkflowSection — #1715: the inspector's view of a ComfyUI workflow node.
//
// The node runs the workflow FILE it holds, and its sockets are that file's Basher markers
// (`workflowSocketsOf`, the one derivation the Nodes view, connect and the agent also use). This
// section picks the file and shows what it declares:
//   - each input with its type; a number or text input not wired is a keyable row (its value
//     field and diamond on `controller:<nodeId>`, so I over it keys it);
//   - each input the file feeds itself ("previous frame of <output>"), which is never wired;
//   - each output with its type;
//   - wires the node keeps on sockets its file no longer has (broken: kept, not read);
//   - what in the file could not become a socket.
//
// Picking a new file is ONE undo step that replaces the file. Wires to sockets the new file does
// not have are KEPT (the #1801 rule: kept, read as unconnected, back in use if a file with that
// socket returns) and the swap says which, so nothing is lost silently.

import { useState } from 'react';
import { writeBasherControllerValues, comfyControllerPath } from '../core/comfy/basherControllers';
import type { ComfyApiJson, ComfyGraphMeta } from '../core/comfy/comfyGraph';
import { parseComfyWorkflowJson } from '../core/comfy/importWorkflowJson';
import { workflowSocketLabel, type WorkflowInput } from '../core/comfy/workflowSockets';
import { brokenInputsOf } from '../core/dag/instanceSockets';
import { getNodeType } from '../core/dag/registry';
import { useDagStore } from '../core/dag/store';
import type { NodeId, NodeRef } from '../core/dag/types';
import { workflowSocketsOf } from '../nodes/ComfyUIWorkflow';
import { ParamDiamond } from './ParamDiamond';
import { useAnimatableField } from './animate/useAnimatableField';
import { pickWorkflowJsonFile } from './asset/importPicker';
import { nodeDisplayName } from './sceneTreeWalk';
import { useNotificationStore } from './stores/notificationStore';

interface GraphParam {
  apiJson: ComfyApiJson;
  meta: ComfyGraphMeta;
}

/** Replace the node's workflow file, in one undo step, and say which wires lost their socket. */
export function setWorkflowFile(nodeId: NodeId, graph: GraphParam): void {
  const dag = useDagStore.getState();
  dag.dispatchAtomic(
    [{ type: 'setParam', nodeId, paramPath: 'graph', value: graph }],
    'user',
    `workflow file: ${graph.meta.name}`,
  );
  const node = useDagStore.getState().state.nodes[nodeId];
  const def = node ? getNodeType(node.type) : undefined;
  const broken = node && def ? brokenInputsOf(def, node) : [];
  if (broken.length > 0) {
    useNotificationStore.getState().notify({
      severity: 'warn',
      message:
        `${broken.length === 1 ? 'A wire is' : `${broken.length} wires are`} on ` +
        `${broken.map((s) => `"${s}"`).join(', ')}, which this workflow file does not have. ` +
        'Kept and not read; it works again with a file that has that input.',
    });
  }
}

function pickFile(nodeId: NodeId) {
  pickWorkflowJsonFile(async (file) => {
    const result = parseComfyWorkflowJson(await file.text(), file.name.replace(/\.json$/i, ''));
    if (!result.ok) {
      useNotificationStore.getState().notify({ severity: 'error', message: result.reason });
      return;
    }
    setWorkflowFile(nodeId, {
      apiJson: result.graph.apiJson,
      meta: result.graph.meta,
    });
  });
}

/** An un-keyed edit of a number / text input writes the marker's default into the file. */
function setInputDefault(nodeId: NodeId, markerNodeId: string, value: number | string) {
  const node = useDagStore.getState().state.nodes[nodeId];
  const graph = (node?.params as { graph?: GraphParam | null } | undefined)?.graph;
  if (!graph) return;
  const apiJson = writeBasherControllerValues(graph.apiJson, { [markerNodeId]: [value] });
  useDagStore
    .getState()
    .dispatchAtomic(
      [{ type: 'setParam', nodeId, paramPath: 'graph', value: { ...graph, apiJson } }],
      'user',
      `set ${markerNodeId}`,
    );
}

function ValueRow({ nodeId, input }: { nodeId: NodeId; input: WorkflowInput }) {
  const isNumber = input.type === 'number';
  const base = (input.defaultValue ?? (isNumber ? 0 : '')) as number | string;
  const paramPath = comfyControllerPath(input.nodeId);
  const { effective, readOnly, onEdit } = useAnimatableField<number | string>(
    nodeId,
    paramPath,
    base,
    (next) => setInputDefault(nodeId, input.nodeId, next),
  );
  const [draft, setDraft] = useState<string | null>(null);
  const shown = String(effective);
  const commit = () => {
    if (draft === null) return;
    if (isNumber) {
      const n = parseFloat(draft);
      if (Number.isFinite(n)) onEdit(n);
    } else onEdit(draft);
    setDraft(null);
  };
  return (
    <>
      <input
        type={isNumber ? 'number' : 'text'}
        value={draft ?? shown}
        readOnly={readOnly}
        data-testid={`comfy-workflow-value-${input.socket}`}
        onFocus={() => setDraft(shown)}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            commit();
            (e.target as HTMLInputElement).blur();
          }
        }}
        className={`${isNumber ? 'w-16 text-right' : 'w-28'} rounded border border-border bg-bg-2 px-1 text-fg focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent`}
      />
      <ParamDiamond
        nodeId={nodeId}
        paramPath={paramPath}
        value={base}
        testid={`comfy-workflow-diamond-${input.socket}`}
      />
    </>
  );
}

const TYPE_CLASS = 'select-none text-[9px] uppercase tracking-wide text-fg/40';

export function ComfyWorkflowSection({ nodeId }: { nodeId: NodeId }) {
  const node = useDagStore((s) => s.state.nodes[nodeId]);
  const nodes = useDagStore((s) => s.state.nodes);
  if (!node || node.type !== 'ComfyUIWorkflow') return null;
  const graph = (node.params as { graph?: GraphParam | null }).graph ?? null;
  const sockets = workflowSocketsOf(node.params);
  const def = getNodeType(node.type);
  const broken = def ? brokenInputsOf(def, node) : [];
  const wiredFrom = (socket: string) => {
    const b = node.inputs[socket] as NodeRef | NodeRef[] | undefined;
    const ref = Array.isArray(b) ? b[0] : b;
    return ref && nodes[ref.node] ? nodeDisplayName(nodes, ref.node) : null;
  };

  return (
    <section
      data-testid="comfy-workflow-section"
      className="flex flex-col border-t border-border text-[11px]"
    >
      <div className="flex items-center gap-2 px-3 py-1.5">
        <span className="font-mono uppercase tracking-wide text-fg/50">workflow file</span>
        <span data-testid="comfy-workflow-file" className="flex-1 truncate text-fg">
          {graph ? graph.meta.name : 'none picked'}
        </span>
        <button
          type="button"
          data-testid="comfy-workflow-pick"
          onClick={() => pickFile(nodeId)}
          className="rounded border border-border bg-muted px-2 py-0.5 text-[10px] text-fg/80 hover:border-accent hover:text-accent"
        >
          {graph ? 'Change…' : 'Choose…'}
        </button>
      </div>
      {!graph ? (
        <p className="px-3 pb-2 text-fg-dim">
          Pick a ComfyUI workflow (API format). Its Basher inputs and outputs become this node’s
          sockets.
        </p>
      ) : (
        <div className="flex flex-col pb-1">
          <div className="px-3 pt-1 text-[10px] uppercase tracking-wide text-fg/40">inputs</div>
          {sockets.inputs.length === 0 && sockets.fed.length === 0 ? (
            <p className="px-3 text-fg-dim">This file has no Basher inputs.</p>
          ) : null}
          {sockets.inputs.map((input) => {
            const from = wiredFrom(input.socket);
            const keyable = (input.type === 'number' || input.type === 'text') && !from;
            return (
              <div
                key={input.socket}
                data-testid={`comfy-socket-in-${input.socket}`}
                data-socket-type={input.type}
                className="flex items-center gap-1 px-3 py-0.5"
              >
                <span className="flex-1 truncate text-fg">{input.socket}</span>
                <span className={TYPE_CLASS}>{workflowSocketLabel(input.type)}</span>
                {keyable ? (
                  <ValueRow nodeId={nodeId} input={input} />
                ) : (
                  <span className="w-28 truncate text-right text-fg-dim">
                    {from ? `← ${from}` : 'not wired'}
                  </span>
                )}
              </div>
            );
          })}
          {sockets.fed.map((f) => (
            <div
              key={f.nodeId}
              data-testid={`comfy-socket-fed-${f.name}`}
              className="flex items-center gap-1 px-3 py-0.5"
              title="Fed by the workflow itself, one frame back. On the first frame: its own image, or black."
            >
              <span className="flex-1 truncate text-fg-dim">{f.name}</span>
              <span className={TYPE_CLASS}>{f.label}</span>
            </div>
          ))}
          <div className="px-3 pt-1 text-[10px] uppercase tracking-wide text-fg/40">outputs</div>
          {sockets.outputs.length === 0 ? (
            <p className="px-3 text-fg-dim">This file has no Basher outputs.</p>
          ) : null}
          {sockets.outputs.map((o) => (
            <div
              key={o.socket}
              data-testid={`comfy-socket-out-${o.socket}`}
              data-socket-type={o.type}
              className="flex items-center gap-1 px-3 py-0.5"
            >
              <span className="flex-1 truncate text-fg">{o.socket}</span>
              <span className={TYPE_CLASS}>{workflowSocketLabel(o.type)}</span>
            </div>
          ))}
          {broken.map((socket) => (
            <div
              key={`broken:${socket}`}
              data-testid={`comfy-socket-broken-${socket}`}
              className="flex items-center gap-1 px-3 py-0.5 text-red-300"
              title="This wire's socket is not in the workflow file. It is kept and not read."
            >
              <span className="flex-1 truncate">{socket}</span>
              <span className="text-[10px]">not in this file · wire kept</span>
            </div>
          ))}
          {sockets.problems.map((p) => (
            <p key={p} className="px-3 py-0.5 text-red-300" data-testid="comfy-workflow-problem">
              {p}
            </p>
          ))}
        </div>
      )}
    </section>
  );
}
