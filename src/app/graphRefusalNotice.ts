// #1586 — an edit the graph refuses says why, on screen.
//
// The graph refuses an edit by throwing, with a message written for the person editing ("a Lag
// keeps a history of its own … build the step into the Solver's own sub-network instead"). Of
// the 133 places the UI dispatches, 9 catch that (counted 2026-10-09 by a brace-tracking
// script over src/app and src/viewport). From the rest it left as an uncaught error:
// the control snapped back, nothing appeared, and the reason went to the console (measured in
// the running app: no new text on the page, the refusal as an uncaught page error).
//
// One place turns that into a notice: the window's own report of an error nobody caught. That
// is exactly the set that was silent. A caller that catches a refusal and reports it itself
// (an import does) is not reported twice, and a door added later needs nothing.
//
// Blender does the same at its operator door: a refused operator reports its reason
// (`BKE_report(reports, RPT_ERROR, "Loop in parents")`, `object_relations.cc`), and the report
// is shown in the status bar. Houdini shows a node's errors "in the network editor, parameter
// editor, and info window" (`hom/hou/NodeError`).
//
// The error is still thrown and still reaches the console: the notice is added, nothing is
// swallowed. In development React reports one uncaught handler error twice (observed: two
// page errors with one stack); the notification store keeps a single toast for one message.

import { GraphRefusal } from '../core/dag/ops';
import { useNotificationStore } from './stores/notificationStore';

/** The op name a refusal opens with: said by the graph for a log, noise to a person. */
const OP_PREFIX =
  /^(?:addNode|removeNode|connect|disconnect|setParam|setMeta|setSpareParam|removeSpareParam|setOutput|dispatch): /;
const SCHEMA = /^params failed schema for ([^:]+): ([\s\S]+)$/;
const LONGEST = 400;

/** What to show for `error`, or null when it is not the graph refusing an edit. */
export function graphRefusalText(error: unknown): string | null {
  if (!(error instanceof GraphRefusal)) return null;
  const said = error.message.replace(OP_PREFIX, '');
  const schema = SCHEMA.exec(said);
  const text = schema ? schemaRefusal(schema[1], schema[2]) : said;
  return text.length > LONGEST ? `${text.slice(0, LONGEST - 1)}…` : text;
}

/** A value the node's schema refused: the first thing the schema says, and where. */
function schemaRefusal(nodeType: string, issues: string): string {
  try {
    const [first] = JSON.parse(issues) as { message?: unknown; path?: unknown }[];
    if (typeof first?.message === 'string') {
      const path = Array.isArray(first.path) ? first.path.join('.') : '';
      return `${nodeType}${path ? ` ${path}` : ''} can't take that value: ${first.message}`;
    }
  } catch {
    // Not the shape expected: say it as the graph said it.
  }
  return `${nodeType} can't take that value: ${issues.split('\n')[0]}`;
}

type ErrorSource = Pick<Window, 'addEventListener' | 'removeEventListener'>;

/**
 * Show every graph refusal nobody caught, as an error notice. Returns the function that stops.
 * `source` is the window; a test hands in its own.
 */
export function installGraphRefusalNotices(source: ErrorSource = window): () => void {
  const show = (error: unknown): void => {
    const message = graphRefusalText(error);
    if (message !== null) useNotificationStore.getState().notify({ severity: 'error', message });
  };
  const onError = (event: Event): void => show((event as ErrorEvent).error);
  const onRejection = (event: Event): void => show((event as PromiseRejectionEvent).reason);
  source.addEventListener('error', onError);
  source.addEventListener('unhandledrejection', onRejection);
  return () => {
    source.removeEventListener('error', onError);
    source.removeEventListener('unhandledrejection', onRejection);
  };
}
