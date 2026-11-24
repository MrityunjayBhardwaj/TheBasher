// Which model files a ComfyUI workflow loads (#1722) — the checkpoints, LoRAs, VAEs and
// ControlNets its loader nodes name, so their licences can be looked up.
//
// Read off the VALUES, not off a list of loader class names. A ComfyUI install grows loader nodes
// with every custom-node pack (`CheckpointLoaderSimple`, `UNETLoader`, `LoraLoader`, a dozen
// third-party ones), and a list of class names would miss the one it has not heard of — silently,
// which is the direction a licence check must never fail in. Every one of them names its file by
// the file's name, and a model file's name ends in a weights extension.
//
// `apiJson` is `unknown`-shaped on purpose (the node stores it verbatim and does not lock into a
// ComfyUI schema version), so this reads defensively and never throws.
//
// REF: src/nodes/ComfyUIWorkflow.ts (`graph.apiJson`); src/core/comfy/comfyGraph.ts.

const WEIGHTS_FILE = /\.(safetensors|ckpt|pt|pth|bin|gguf|onnx)$/i;

/** The model files `apiJson` names, each once, in the order first met. */
export function comfyModelNames(apiJson: unknown): string[] {
  if (apiJson === null || typeof apiJson !== 'object') return [];
  const names: string[] = [];
  for (const node of Object.values(apiJson as Record<string, unknown>)) {
    if (node === null || typeof node !== 'object') continue;
    const inputs = (node as { inputs?: unknown }).inputs;
    if (inputs === null || typeof inputs !== 'object') continue;
    for (const value of Object.values(inputs as Record<string, unknown>)) {
      if (typeof value !== 'string') continue;
      const name = value.trim();
      if (WEIGHTS_FILE.test(name) && !names.includes(name)) names.push(name);
    }
  }
  return names;
}
