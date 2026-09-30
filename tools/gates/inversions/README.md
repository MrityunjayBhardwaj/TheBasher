# Adequacy inversions

Each `*.patch` here is one named inverse edit for `tools/gates/adequacyHarness.mjs`, paired
in `manifest.json` with the gates it should move and with what each of those gates is
**expected** to do. The harness applies it, runs the paired gate files, records red/green
**by name**, puts the tree back, and refuses to report anything unless the tree is
byte-identical afterwards.

```
node tools/gates/adequacyHarness.mjs --list
node tools/gates/adequacyHarness.mjs --all
node tools/gates/adequacyHarness.mjs <name>
```

Exit code is `0` when every pair agrees with its declared expectation, `1` on any
disagreement or withheld verdict, `2` if the tree did not come back clean.

## Why this exists

A gate that has never been seen **red** carries no information. It is a test that happens
to pass, and from the outside the two are indistinguishable — both print a tick.

Three defects in the animation / import / retarget sector were each found by a human
looking at a screen, never by a test: a bone sweeping 360° through a clip (#867), the same
through a glTF clip (#876), and a bake that smoothsteps what its source lerps (#877). Every
one had a test file aimed straight at it. Every one of those files stayed green, because a
property of a **sequence** was being asserted at a single **point** — and continuity,
interpolation parity and bake-versus-source agreement are relational. They hold or fail
_between_ successive samples and are identically satisfied at any one of them.

Issue #883 is the write-up. This directory is the part of it that stays runnable.

## Why a pair declares an expectation instead of just wanting red

The first run of this sweep produced 8 greens out of 19 pairs. Reporting all 8 as blind
gates would have been the same overclaiming the sweep exists to catch: five of them were
inversions aimed **outside** that gate's subject, which is the sweep's aim being wrong, not
the gate's coverage.

So each pair declares `expect: red` or `expect: green` per gate, with the reason. An
expected green — `retargetThenBake` under a value corruption — is a **documented
blindness held in place on purpose**, and it is worth as much as a red: if it ever turns
red, that file's subject has changed and its header note needs rewriting.

## The three things the harness asserts about itself

1. **Each gate is run CLEAN first.** A gate that is already red proves nothing about the
   inversion, and without the baseline the two cases read identically.
2. **The patch is asserted to have changed every file it names**, by content hash, _before_
   any gate runs. An inversion that silently fails to apply makes a perfectly good gate look
   blind and the report is indistinguishable from a real finding. A pair whose patch did not
   land is reported `applied: false` and its verdict is **withheld**, not guessed. Only the
   entry literally named `null` may be an empty patch; any other empty one is withheld too.
   That path has been exercised: a deliberately empty `ctlEmpty.patch` reports
   `VERDICT WITHHELD` and exits 1.
3. **The revert is verified against a clean tree**, in the same command that did the
   mutating — the later check is the one that gets skipped when the number looks right.

Hashes are over content, not size: the edits here are same-length substitutions
(`'linear'` → `'cubic'`), which a size comparison cannot see at all.

## Making a new one

Make the edit by hand, then capture and revert:

```
git diff <file> > tools/gates/inversions/<name>.patch
git checkout <file>
```

Then add a `pairs` entry to `manifest.json` naming the gates it should move and what each
should do. A patch is byte-exact `git diff` output: reflowing its context lines makes it
unappliable. It needs no `.prettierignore` entry — `prettier --check .` walks by extension
and never opens a `.patch` at all.

## The patches

| name                 | inverse edit                                                           | the defect it restores                                                                                |
| -------------------- | ---------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `null`               | nothing (the file is empty)                                            | The control. Every gate must stay green — that is what proves the runner produces no reds of its own. |
| `gltfEulerCanonical` | `gltfImportChain.ts` — drop `continuousEuler`, keep the raw conversion | #876. Each key's Euler representative is chosen canonically, with no memory of the previous key.      |

## What they measured

Run on the tree of the commit that retired the bake pairs (parent `15c170c4`), 2026-09-30, with
`node tools/gates/adequacyHarness.mjs --all`. Every pair agreed with its declared expectation;
harness exit `0`; no verdict withheld; tree byte-identical after every arm (`reverted: true`).
Re-run after any change to a gate in the manifest and re-stamp this paragraph.

| inversion            | gate                               | expected | observed | red   | what redded                                                  |
| -------------------- | ---------------------------------- | -------- | -------- | ----- | ------------------------------------------------------------ |
| `null`               | all three                          | green    | green    | **0** | the control                                                  |
| `gltfEulerCanonical` | `gltfEulerContinuity.gate.test.ts` | red      | red      | **1** | the no-jump bound                                            |
| `gltfEulerCanonical` | `gltfImportChain.test.ts`          | red      | red      | **1** | the B3 SEQUENCE row — 1 of 38; every per-key row stays green |

🔑 **The row that carries the whole point is the partial one.** Under `gltfEulerCanonical`,
`gltfImportChain.test.ts` reds on its B3 SEQUENCE row while every per-key row — including B3's
own — stays green: the same file disagreeing with itself about whether a defect exists, and the
half that says "green" is the half that shipped the defect.

`bindMotionDispatch.test.ts` stays in the control. It was the documented green half of the
retired `bakeClipRotationRadians` pair (it asserts which nodes a bind creates, never a value);
as a control it still proves the runner adds no reds of its own.

## Retired with the clone road (#1053)

Two pairs aimed at the clone road's bone bake, which #1053 deleted with the clone renderer
(a kept clone-road import is not drawn, so nothing mints or bakes a bone channel any more):

- `bakeEasingCubic` — `bakeChannelOps.ts` stamped `'cubic'` on keys copied from a clip whose
  sampler is a raw lerp (#877). It redded `bakedClipParity.gate.test.ts` and, partially,
  `bakeGltfChannel.test.ts` (the interval row red, the keyframe row beside it green — the
  point-versus-sequence blindness this directory exists to show).
- `bakeClipRotationRadians` — `ensureChannelForBone.ts` without `radVec3ToDeg` (#843).

Their patches, their gates and the code they inverted are all gone; read them at `15c170c4`.
The lesson they carried — a relational property asserted at a single point passes whatever
the defect — is the `gltfEulerCanonical` row above, which still runs.
