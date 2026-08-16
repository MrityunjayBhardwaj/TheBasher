// discardPatches — can the discard harness's patches still be applied? (ns-2 step 11)
//
// The discard perturbation is this phase's only clause that discriminates: a census over
// call sites bounds who may SPEAK and never shows that anyone LISTENED, so "apply the
// inverse edit and see what reds" is the one instrument that can tell a wired road from a
// decorative one. Step 16 re-runs it as the phase's exit.
//
// 🔴 AND IT IS A `git diff` PINNED TO LINE CONTEXT, WHICH ROTS SILENTLY. Nothing fails,
// nothing warns, and the harness is only ever run by hand because each run is a full unit
// tier — so the rot surfaces at step 16, on the exit, which is the worst place to learn
// that the instrument measuring your exit has been dead for six commits. That is the
// covered-but-unhonoured shape this project has already paid for three times: an
// instrument everyone can point at and nothing checks.
//
// ⚠️ HOW WIDE THAT ROT SURFACE ACTUALLY IS — MEASURED, because the first version of this
// comment over-claimed it. `git apply` does NOT match on line numbers: it searches for the
// hunk's context and relocates, so reflowing a comment three lines above the hunk is
// tolerated completely (tried, and the patch still applied). What breaks a patch is an
// edit to a CONTEXT line or to the target line itself — verified by changing
// `const evalStart = evalPerfHook ? …`, one of `scopeHandOff`'s six context lines, which
// reds this gate by name. So the surface is narrower than "anything nearby" and it is
// exactly the surface that matters: the lines the patch is actually pinned to.
//
// This asks the real question rather than a proxy for it — `git apply --check`, which is
// exactly what the harness itself will do — so there is no gap between what this gate
// verifies and what the instrument needs.
//
// ⚠️ IT READS THE WORKING TREE, DELIBERATELY. A patch that cannot apply because of your own
// uncommitted edit to the same lines genuinely cannot be run right now, and saying so is
// the honest answer; the harness refuses on a dirty tree for the same reason. CI checks out
// clean, so there it is purely a rot detector.
//
// REF: tools/gates/discardHarness.mjs; tools/gates/discards/README.md;
//      the ns-2 plan §8 steps 2, 11 and 16; issues #607, #660.

import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '../..');
const PATCH_DIR = join(HERE, 'discards');

/**
 * Are any TRACKED files currently modified?
 *
 * 🔴 THIS GATE'S QUESTION IS ONLY MEANINGFUL ON A CLEAN TREE, and the reason is an
 * interaction with the very instrument it protects. The harness works by APPLYING a patch
 * and then running the whole unit tier — this gate included. Mid-run the tree is modified
 * by construction, and two of these patches touch the same hunk of `evaluator.ts`, so
 * while one is applied the other genuinely cannot apply. A gate that answered "false" there
 * would report a rotted instrument on every harness run that used a neighbouring patch,
 * adding a spurious red to the exit measurement the whole phase rests on — the gate
 * corrupting the number it exists to protect.
 *
 * "Undefined" is the honest answer mid-perturbation, not "broken". The harness itself
 * refuses to start on a dirty tree for the same reason, so on any run that was allowed to
 * begin, the tree WAS clean and this gate already had its say before the patch went on.
 */
function workingTreeDirty(): boolean {
  const status = execFileSync('git', ['status', '--porcelain', '--untracked-files=no'], {
    cwd: REPO,
    encoding: 'utf8',
  });
  return status.trim() !== '';
}

/** Every named patch the harness can run, sorted, without the `.patch` suffix. */
export function discardPatchNames(): string[] {
  return readdirSync(PATCH_DIR)
    .filter((name) => name.endsWith('.patch'))
    .map((name) => name.slice(0, -'.patch'.length))
    .sort();
}

export interface PatchApplicability {
  readonly name: string;
  /** Does `git apply --check` accept it against the current working tree? */
  readonly applies: boolean;
  /** git's own complaint, when it does not — the name of the file and hunk that moved. */
  readonly error: string | null;
}

export interface ApplicabilityReport {
  /**
   * `false` when a tracked file is modified — the tree is mid-perturbation and the question
   * has no answer. Callers must branch on this rather than reading `patches` regardless;
   * see {@link workingTreeDirty}.
   */
  readonly decidable: boolean;
  readonly patches: PatchApplicability[];
}

/**
 * Ask git whether each patch would still apply, forward, against the working tree.
 *
 * FORWARD ONLY, and that is the complete question rather than half of one. The harness
 * applies a patch and then reverses it to restore the tree, so it might look as though the
 * reverse direction wants checking too — but a reverse check has to run against the
 * POST-apply tree, and running it here, before anything is applied, asks git to find the
 * patched text in an unpatched file. It would fail on every healthy patch. Reverse
 * applicability follows from forward applicability on the tree git itself just produced,
 * and the harness asserts the restore separately by refusing to report unless the tree
 * comes back byte-identical.
 *
 * 🔴 AN EMPTY PATCH IS APPLICABLE BY THE HARNESS'S OWN RULE, AND THAT RULE IS COPIED HERE
 * RATHER THAN GUESSED AT. `git apply --check` REJECTS an empty file — *"No valid patches in
 * input"* — so a gate that simply asked git would red on the null control, which is a
 * perfectly healthy patch, and the first thing anyone would do is weaken the gate. The
 * harness never calls git on an empty body at all (`discardHarness.mjs:158-159`: it
 * computes `empty` and skips both the apply and the reverse). This function's question is
 * "could the harness run this", so the harness's rule is the correct one and any second
 * spelling of it would be a place for the two to disagree.
 *
 * The null control is included rather than filtered out of the list, because excluding it
 * would mean this gate could not tell "the null control is present" from "the null control
 * was deleted" — and the null control is what proves the harness's reporter changes nothing
 * about what runs.
 */
export function discardPatchApplicability(): ApplicabilityReport {
  if (workingTreeDirty()) return { decidable: false, patches: [] };
  return { decidable: true, patches: discardPatchNames().map(checkOne) };
}

function checkOne(name: string): PatchApplicability {
  const file = join(PATCH_DIR, `${name}.patch`);
  if (readFileSync(file, 'utf8').trim() === '') return { name, applies: true, error: null };
  try {
    execFileSync('git', ['apply', '--check', file], {
      cwd: REPO,
      encoding: 'utf8',
      stdio: 'pipe',
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { name, applies: false, error: message.trim() };
  }
  return { name, applies: true, error: null };
}
