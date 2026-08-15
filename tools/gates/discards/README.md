# Discard patches

Each `*.patch` here is one named inverse edit for `tools/gates/discardHarness.mjs`. The
harness applies it, runs the standing unit command, reports what redded **by name**, puts
the tree back, and refuses to report anything unless the tree is byte-identical afterwards.

```
node tools/gates/discardHarness.mjs --list
node tools/gates/discardHarness.mjs <name>
```

## The shape of a discard

A discard is **not** "delete the feature". Deleting a road is easy to detect — a source
census sees the import go. The interesting edit keeps every call in place and throws the
**answer** away at the point of use, because that is the version this repo has already
measured as invisible: reverting a whole render wiring redded one test (a census), while
discarding the resolved value at the `<mesh>` redded **zero of 4059, byte for byte**.

So a patch should leave the resolver called, the import present and the census green, and
change only what happens to the result.

## Making a new one

Make the edit by hand, then capture and revert:

```
git diff <file> > tools/gates/discards/<name>.patch
git checkout <file>
```

A patch is byte-exact `git diff` output: reflowing its context lines makes it unappliable.
It needs no `.prettierignore` entry, and that was measured rather than assumed — `prettier
--check .` walks by extension and never opens a `.patch` at all, so an entry for it would
pass with or without the work and protect nothing. (Naming one explicitly on a prettier
command line _does_ error with "no parser could be inferred", so don't do that.)

## The patches

| name                  | subject                                                                   | why it is here                                                                                                                                                                                                                                                                                        |
| --------------------- | ------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `null`                | nothing (the file is empty)                                               | The null control. `red` must be **0** and the tree byte-identical, and `{files, tests}` must equal the standing tier's own numbers — that is what proves the harness's reporter changed nothing about what ran.                                                                                       |
| `inputAccepts`        | `src/core/dag/ops.ts` — the connect-time socket type check                | The positive control, on a road that has nothing to do with the phase being built. `inputAccepts` is still called; its verdict is discarded. Something must red, with names.                                                                                                                          |
| `scopeHandOff`        | `src/core/dag/evaluator.ts` — the component-scope hand-off (ns-2 step 9b) | This phase's own road, first patchable point. `scopeFor` is still called and its answer is thrown away at the `evaluate` call, so the import, the resolver and every source census stay exactly as they are and only the operator's fourth argument changes.                                          |
| `scopeNeverResolved`  | `src/core/dag/evaluator.ts` — the same line, one step further             | The resolver is never CALLED. `scopeFor` stays defined and imported, so every census still passes; what disappears is the parse. It exists because the difference between it and `scopeHandOff` is the whole question of whether anything observes the resolution as opposed to merely permitting it. |
| `scopeValueCorrupted` | `src/nodes/componentSelection.ts` — the degenerate arm                    | The answer is shape-correct and content-wrong: a total selection of the wrong LENGTH. Nothing throws and no call site moves, so only a reader of the VALUE can notice.                                                                                                                                |
| `scopeRoadRemoved`    | the evaluator's hand-off + the operator's runtime refusal                 | The whole scope road, gone, while still compiling and still passing every source census. The ns-1b analogue of this patch is what redded 22 of 4059.                                                                                                                                                  |

A positive control on a **foreign** road is deliberate. A harness validated only against
the road it was built to measure is validated by its own author's belief that the road
works.

## What they measured (ns-2 step 11, on the DEGENERATE population)

[[K32]] step 4: record the number before believing any green. Measured on `27aeba7`,
tier **354 files / 4217 tests**, every run reverted byte-identical.

| patch                 | red   | files red | what redded                                                         |
| --------------------- | ----- | --------- | ------------------------------------------------------------------- |
| `null`                | **0** | 0         | the control; `{files, tests}` equal the standing tier's own numbers |
| `scopeHandOff`        | **3** | 1         | all three are rows of the MINTED recorder                           |
| `scopeNeverResolved`  | **4** | 2         | the same three, plus step 10's parser-reachability row              |
| `scopeValueCorrupted` | **5** | 2         | every name asserts the resolver's own answer                        |
| `scopeRoadRemoved`    | **6** | 2         | ns-1b's analogue redded **22 of 4059 across 7 files**               |

🔴 **THE FINDING, AND IT IS NOT THE COUNTS.** Not one of those six is a test that predates
this phase's wave 2. Removing the entire component-scope road — resolver, hand-off, runtime
refusal — is invisible to **all 4209 tests that existed before wave 2 wrote its own**. The
nonzero numbers are this phase measuring its own instruments, which is exactly what a census
over call sites does: it bounds who may speak, never that anyone listened.

That is expected and it is not a defect: on a degenerate population every selection is
total, so discarding it changes no output anyone can see. The rewrite and the behaviour
change deliberately do not land in one commit. But it means **no green on this road is
evidence of anything until step 12 ships a consumer**, and any reading that treats `red > 0`
here as coverage is reading the instrument, not the road.

🔑 **The one thing step 10 bought, visible as a single test.** `scopeHandOff` (resolver runs,
answer discarded) and `scopeNeverResolved` (resolver never runs) differ by **exactly one**
red — step 10's row asserting a malformed query still throws through the evaluator. Before
that row existed the tier could not tell those two trees apart at all.

**Still owed, and steps 9b–11 narrow it rather than closing it.** The patches above all
target discard point (a), the hand-off. Point (b) — discarding the selection **inside a
consumer** — cannot be written until an operator reads one, which is step 12. Until (b) has
been observed naming a behavioural assertion, a `red > 0` from this phase's own discard
still cannot be told apart from a harness that silently no-ops on a road nobody drives.
