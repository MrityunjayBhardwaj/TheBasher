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

| name           | subject                                                    | why it is here                                                                                                                                                                                                  |
| -------------- | ---------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `null`         | nothing (the file is empty)                                | The null control. `red` must be **0** and the tree byte-identical, and `{files, tests}` must equal the standing tier's own numbers — that is what proves the harness's reporter changed nothing about what ran. |
| `inputAccepts` | `src/core/dag/ops.ts` — the connect-time socket type check | The positive control, on a road that has nothing to do with the phase being built. `inputAccepts` is still called; its verdict is discarded. Something must red, with names.                                    |

A positive control on a **foreign** road is deliberate. A harness validated only against
the road it was built to measure is validated by its own author's belief that the road
works. The one control that matters most is still owed: once this phase's own road has a
consumer, discard the resolved selection **inside that consumer** and confirm the harness
names the assertion that catches it. Until that has been observed once, a `red > 0` from
this phase's own discard cannot be told apart from a harness that silently no-ops.
