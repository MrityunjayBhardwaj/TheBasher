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
| `scopeConsumed`       | `src/nodes/SetMaterialOp.ts` — the first consumer's read (ns-2 step 12)   | 🔴 Discard point **(b)**, and the control this harness owed from step 2. The selection is resolved, handed over and thrown away INSIDE the consumer, so the literal range alone decides. The first patch here whose reds are behavioural — see the calibration below.                                 |

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

## 🔴 THE FOURTH CONTROL, OWED SINCE STEP 2 — AND IT IS NOW PAID (ns-2 step 12)

Every patch above targets discard point (a), the hand-off, and every red they produce is a
row this phase minted for itself. Point (b) — discarding the selection **inside a
consumer** — could not be written until an operator read one, and until it had been observed
naming a **behavioural** assertion, a `red > 0` from this phase's own discard could not be
told apart from a harness silently no-opping on a road nobody drives.

`scopeConsumed` is that patch: `SetMaterialOp` still receives its resolved selection, the
required fourth argument still arrives, every import and every census stays green, and the
answer is thrown away at the point of use so the literal range alone decides.

| patch           | red   | what redded                                                    |
| --------------- | ----- | -------------------------------------------------------------- |
| `scopeConsumed` | **3** | three assertions about **what the operator emits**, each named |

```
ns-2 step 12 — 🔴 a SCOPE alone names the faces — with the range left at its default
ns-2 step 12 — the range and the scope INTERSECT — both survive until the accommodation is deleted
ns-2 step 12 — a scope selecting NOTHING lands exactly where an INVERTED RANGE already landed
```

🔑 **THIS IS THE FIRST TIME IN THE PHASE THAT THE HARNESS HAS NAMED SOMETHING OTHER THAN AN
INSTRUMENT.** Compare it to the step-11 table above, where the whole road could be deleted
and only rows written for the road itself noticed. The difference is not the harness — it is
that a consumer now exists. **Step 16's first row can be read as a claim about the road.**

A note for whoever adds the next patch: the first run of this control redded **4**, and the
extra one was `discardPatchRot`'s own "every required patch is still present, by NAME" —
working exactly as intended. A new patch is a deliberate act and the list acknowledges it.

## 🔴 THE EXIT (ns-2 step 16) — all fourteen rows, measured

Run on `838e8c1`, tier **357 files / 4282 tests** green, every perturbation reverted from
bytes saved beforehand and the tree proven byte-identical with `git diff --quiet`. Nine of
the rows are hand perturbations rather than patches, and they are named here so the next run
reproduces them rather than re-inventing them.

**The blocking condition — _if the first row reads 0, the phase is not done_ — is not
tripped. Row 1 reads 8.** Three of the fourteen `must NOT red` predictions were falsified,
all three in the same direction: the instruments are STRONGER than the plan credited them.
No `must red` half failed.

| #   | perturbation                                            | red      | must red — measured                                                   | must NOT red — measured                                                  |
| --- | ------------------------------------------------------- | -------- | --------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| 1   | `scopeHandOff` — answer discarded at the hand-off       | **8**    | 🔴 **NOT 12 / 13a / 13b — zero of them.** 5 × step 9b, 3 × step 10    | —                                                                        |
| 2   | `scopeNeverResolved` / `scopeRoadRemoved`               | 9 / 15   | the same, plus step 10's parser-reachability row                      | —                                                                        |
| 3   | `scopeConsumed` — `SetMaterialOp` only                  | **8**    | 3 × step 12 + 5 × #638                                                | ✅ 0 array rows, 0 mirror rows, 0 exit rows                              |
| 4   | `scopeArrayConsumed` — `ArrayModifier` only             | **9**    | 4 × 13a + 2 × the exit + 3 × step 10                                  | ✅ 0 mirror rows, 0 step-12 rows                                         |
| 5   | `scopeMirrorConsumed` — `MirrorModifier` only           | **8**    | 5 × 13b + 3 × the exit                                                | ✅ 0 array rows, 0 step-12 rows                                          |
| 6   | the canonicaliser over-coalesces (#677's own bug)       | **1**    | step 9's both-directions row, alone                                   | ✅ 12.5's two-instances assertion                                        |
| 7   | the resolver returns a total selection unconditionally  | **38**   | 12 (×8), 13a (×4), 13b (×5), the exit (×5), 9b, 10, the language      | —                                                                        |
| 8   | the builder ignores the descriptor's scope field        | **22**   | 12.5's parity row, ×5 descriptors                                     | ✅ the sharing assertion                                                 |
| 9   | 🔴 CORRELATED — builder **and** `faceCountOf` ignore it | **20**   | 12.5's literal row (`24`), and its mirror twin (`18`)                 | ✅ **the parity gate is ABSENT** — the whole reason row 2 of 12.5 exists |
| 10  | the scope removed from the geometry KEY                 | **25**   | 12.5's two-instances assertion                                        | ❌ **the count-parity gate ALSO redded (×4)** — see below                |
| 11  | `chain.scope` dropped from one declaration              | **1757** | step 4's refusal, **at registration, by name**                        | ❌ **unanswerable** — see below                                          |
| 12  | a `muted:` guard restored in one operator               | **3**    | both no-second-honouring detectors + the operator's own blindness row | ✅ the five bypass hashes                                                |
| 13  | a hand-maintained membership list re-introduced         | **1**    | "THREE membership lists remain, each with a reason"                   | ✅ nothing behavioural                                                   |
| 14  | `chain.section` disagreeing with the node's stack       | **30**   | step 4's section row + 4 × step 7's membership rows                   | ❌ **20+ behavioural rows redded too** — see below                       |

### 🔴 Row 1 — the count is 8, and the plan named the wrong witnesses

The exit's headline row was written expecting steps 12, 13a and 13b to observe it. **Not one
of them does.** Those files call `evaluate` DIRECTLY — deliberately, because the muted case
can only be observed on a direct call — so a patch on `evaluator.ts` is off their path
entirely. What observes the hand-off is step 9b's five rows and step 10's three, and three of
those eight are behavioural (a key set and a byte count over a real sweep).

⇒ **the per-operator arms (rows 3–5) are what carry the phase's behavioural proof**, and the
harness did not have two of the three until this step (#679). The exit table asked a question
its own instrument could not answer, and that only became visible by running it.

### 🔴 Row 10 — a key is not only an identity, it is a CACHE key

Predicted: the count-parity gate cannot see a key change, because it compares a count against
a build for one descriptor. Measured: it redded four times, and the failure names show why —
two differently-scoped descriptors now produce **the same key**, so the registry hands the
second one the FIRST one's cached build. Parity then compares a count for one scope against
a geometry built for another. The gate is sensitive to key collisions as well as to
count/build drift, which is more than it was credited with.

### 🔴 Row 11 — the refusal is at REGISTRATION, so the row has no `must NOT red` half

Dropping `chain.scope` from one declaration does not red a gate; it stops the registry from
seeding at all, and 1757 tests fail carrying the refusal's own sentence:
`registerNodeType(ArrayModifier): chain declaration is missing scope.` "Does the arithmetic
stay green?" has no answer when no node can register. The totality refusal is unsurvivable
rather than detectable — stronger than the table's phrasing, and worth stating that way.

### 🔴 Row 14 — its own step made the prediction false

"Must NOT red anything behavioural" was written when `chain.section` was a label. **Step 7
derived stack membership from it**, so a lying section does not mislabel an operator, it
moves it to another stack: `operatorStack`, the addModifier mutator and the read-side parity
all red. The prediction is stale by construction, and the staleness is the design working.

⚠️ The table's row 14 also names an `inspectorSections` cross-check. Revision 2 deliberately
did **not** build one (§17: it would infer correspondence from a field answering a different
question, and 3 of 7 operators would need an exemption). The check that exists — and that
fired — is the declaration-vs-behaviour one.

### The step-17 delta, recorded rather than folded into the table above

The table above is stamped with the tree it ran on and stays as it was. Step 17
added `operatorScopeHonouring.gate.test.ts`, and re-running every arm on `18501fc` moved
exactly three of them, each by exactly two:

| arm                   | step 16 | step 17 | what joined                                       |
| --------------------- | ------- | ------- | ------------------------------------------------- |
| `scopeConsumed`       | 8       | **10**  | the honouring cross-check **and its minted liar** |
| `scopeArrayConsumed`  | 9       | **11**  | the same two                                      |
| `scopeMirrorConsumed` | 8       | **10**  | the same two                                      |

🔴 **THE TREES THESE RUNS WERE STAMPED WITH ARE `6773c79` (step 16) AND `7c8c418` (step 17)**,
and the ids that stood here before the merge-gate review — `838e8c1` and `18501fc` — were
pre-amend objects on **no branch at all**, reachable only until the next `gc`. Both readings
stand: `git diff` between each pre-amend id and the commit that shipped is **this file and
nothing else**, which is what recording a measurement after taking it looks like. But a
citation a reader cannot resolve is not a citation, so the stamps now name commits that are
ancestors of the branch head.

Every other arm is byte-identical, including both controls.

🔑 **THE SHAPE IS THE POINT.** The three arms that moved are the three that discard INSIDE a
consumer; the four that patch the evaluator did not move, because the new gate calls
`evaluate` directly and is off their path — [[H375]] again, one file later. So the honouring
check is a per-consumer detector that nobody had to aim: it reds for whichever operator stops
honouring, without being told which one, which is the property the three separate arms buy
one at a time. **Its liar row moving with it is the useful half** — an arm that redded only
the cross-check would leave open whether the check had merely become unsatisfiable.
