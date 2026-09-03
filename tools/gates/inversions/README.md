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

| name                      | inverse edit                                                           | the defect it restores                                                                                |
| ------------------------- | ---------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `null`                    | nothing (the file is empty)                                            | The control. Every gate must stay green — that is what proves the runner produces no reds of its own. |
| `bakeEasingCubic`         | `bakeChannelOps.ts` — `easing: 'linear'` → `'cubic'`                   | #877. The bake stamps smoothstep on keys copied from a clip whose sampler is a raw lerp.              |
| `gltfEulerCanonical`      | `gltfImportChain.ts` — drop `continuousEuler`, keep the raw conversion | #876. Each key's Euler representative is chosen canonically, with no memory of the previous key.      |
| `bakeClipRotationRadians` | `bakeClipOntoRig.ts` — drop `radVec3ToDeg`                             | Every baked bone rotation scaled by π/180. Included for its **green** half.                           |

## What they measured

Run on `dec4aa2` — the commit that adds the harness, and an ancestor of this branch's head, so the citation resolves. Every pair agreed with its declared expectation; harness exit `0`; tree
byte-identical after every arm.

| inversion                 | gate                               | expected  | observed  | red   | what redded                                                        |
| ------------------------- | ---------------------------------- | --------- | --------- | ----- | ------------------------------------------------------------------ |
| `null`                    | all six                            | green     | green     | **0** | the control                                                        |
| `bakeEasingCubic`         | `bakedClipParity.gate.test.ts`     | red       | red       | **2** | the interval row, and the by-name easing assertion                 |
| `bakeEasingCubic`         | `bakeGltfChannel.test.ts`          | red       | red       | **1** | the interval row **only** — the keyframe row beside it stays green |
| `gltfEulerCanonical`      | `gltfEulerContinuity.gate.test.ts` | red       | red       | **1** | the no-jump bound: 360.1° travelled between keys 7.60° apart       |
| `gltfEulerCanonical`      | `gltfImportChain.test.ts`          | red       | red       | **1** | the B3 SEQUENCE row — 82.5° against a true 262.5°                  |
| `bakeClipRotationRadians` | `bakeClipOntoRig.test.ts`          | red       | red       | **3** | three rows, including the file's own falsifying arm                |
| `bakeClipRotationRadians` | `retargetThenBake.test.ts`         | **green** | **green** | **0** | nothing — and that is the finding, not a gap. See below.           |

🔑 **The two rows that carry the whole point are the ones where a file redded _partially_.**
Under `bakeEasingCubic`, `bakeGltfChannel.test.ts` reds on its interval row and stays green
on its keyframe row, from the same fixture and the same bake. Under `gltfEulerCanonical`,
`gltfImportChain.test.ts` reds on its B3 SEQUENCE row while every per-key row — including
B3's own — stays green. Those are the same file disagreeing with itself about whether a
defect exists, and the half that says "green" is the half that shipped three defects.

🔴 **`retargetThenBake` under a value corruption is the one expected green, and removing it
would be a mistake.** Its central assertion is `expect(JSON.stringify(after)).toBe(before)`
— a self-comparison, correct for its actual subject (the second-bind guard) and structurally
incapable of gating "the value is right", because a corruption present in both terms cancels
exactly. The pair exists so that blindness stays visible and stays deliberate. What covers
the values is `bakeClipOntoRig.test.ts`, one level down, which reds three times on the same
inversion.

## What is NOT here yet

The sweep that produced the finding covered **19 gate/inversion pairs** across the sector.
Four are materialised here — the three that carried a real defect plus the control. The
other fifteen were run by hand and are not reproducible from this directory; adding one is
the two-step capture above. Nothing in this README should be read as a claim that the sector
is fully swept.

Only the animation / import / retarget sector was ever swept. The 60-odd `.gate.test.ts`
files belonging to the geometry track were deliberately not touched.

REF: issue #883; `tools/gates/discardHarness.mjs` (the sibling instrument — whole-tier
discards rather than paired gates); `tools/gates/discards/README.md`.
