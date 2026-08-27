# External model licences — the recorded verdicts

Phase A0 of the AI track. Every AI model this project may reach for, and whether the
repo's permissive-only posture (THESIS.md §35) allows it.

Checked **2026-08-26** against the licence text, not against summaries. Every verdict below
cites the file or agreement it came from.

**Why this file exists.** `scripts/license-audit.mjs` walks the npm production dependency
tree. A model reached over HTTP is not in that tree, so the existing gate cannot see this
population **by construction** — it would have returned a clean pass no matter what terms
these models carried. The point of A0 is that a restricted model is _named as blocked_
rather than built against and discovered at ship time.

**This is a record, not legal advice.** It states what the terms say and cites where.

---

## The verdicts

| model                            | role                        | licence                       | verdict                        |
| -------------------------------- | --------------------------- | ----------------------------- | ------------------------------ |
| Kimodo — inference code          | text-to-motion (A1)         | Apache-2.0                    | ✅ **ALLOWED**                 |
| Kimodo — 6 checkpoints (SOMA/G1) | text-to-motion weights (A1) | NVIDIA Open Model             | ⚠️ **ALLOWED WITH CONDITIONS** |
| **Kimodo-SMPLX-RP-v1**           | text-to-motion weights      | NVIDIA R&D Model              | 🔴 **BLOCKED**                 |
| **PartField** (code + weights)   | element perception (A6)     | NVIDIA License (non-standard) | 🔴 **BLOCKED**                 |
| SAMPart3D (code + weights)       | element perception (A6)     | MIT                           | ✅ **ALLOWED**                 |
| UniRig (code + weights)          | auto-rigging (unscheduled)  | MIT                           | ✅ **ALLOWED**                 |
| TRELLIS (code)                   | text-to-3D (A4)             | MIT (the _majority_ of it)    | ✅ **ALLOWED**                 |
| TRELLIS (weights)                | text-to-3D weights (A4)     | MIT                           | ✅ **ALLOWED**                 |
| InstantMesh (code)               | text-to-3D (A4)             | Apache-2.0                    | ✅ **ALLOWED**                 |
| InstantMesh (weights)            | text-to-3D weights (A4)     | Apache-2.0                    | ✅ **ALLOWED**                 |
| **nvdiffrast**                   | mesh extraction (A4)        | NVIDIA Source Code (1-Way)    | 🔴 **BLOCKED**                 |
| **diff-gaussian-rasterization**  | rendering, via TRELLIS (A4) | Gaussian-Splatting License    | 🔴 **BLOCKED**                 |
| **Hunyuan3D 2.0**                | text-to-3D (A4)             | Tencent Community License     | 🔴 **BLOCKED**                 |

**A1 has a subject.** Kimodo's code is Apache-2.0 and six of its seven checkpoints are
commercially usable. **A6 has a subject too, but not the one to reach for first** — PartField
is blocked and SAMPart3D is the unblocked alternative.

🔴 **A4 does NOT yet have a subject, and the reason is finding 3 below.** Both leading
open text-to-3D candidates have genuinely permissive weights **and** reach the mesh through
`nvdiffrast`, whose terms forbid commercial use. The four ✅ rows above are true and, read
alone, would send someone straight into a pipeline they may not ship.

---

## Two findings that would not survive a casual check

### 1. The licence varies _per checkpoint_, inside one release

Kimodo ships seven checkpoints from one repository under one README. Six are NVIDIA Open
Model. One — `Kimodo-SMPLX-RP-v1`, the SMPL-X skeleton variant — is the **NVIDIA Internal
Scientific Research and Development Model License**, which forbids production use outright.

Probing one checkpoint answers for that checkpoint and no other. A summary of "Kimodo's
licence" is wrong for one seventh of the release, and the wrong seventh is the one a reader
reaching for a familiar skeleton would pick first.

### 2. The "used over HTTP, never linked or shipped" carve-out does **not** transfer

THESIS.md §35 records the precedent: _"ComfyUI is GPL but used over HTTP, never linked or
shipped."_ That reasoning is sound **for the GPL** and does not generalise:

|                                      | what it restricts                              | does HTTP isolation escape it? |
| ------------------------------------ | ---------------------------------------------- | ------------------------------ |
| GPL                                  | **distribution** — conveying the work, linking | yes, if never conveyed         |
| NVIDIA License §3.3, NVIDIA R&D §3.1 | **use** — every use, wherever it runs          | **no**                         |

PartField's §3.3 reads: _"The Work and any derivative works thereof only may be used or
intended for use non-commercially."_ Running it on our own server to serve a paying customer
**is** commercial use. Standing it behind an HTTP boundary changes nothing.

🔴 **So the ComfyUI precedent must not be cited for a non-commercially-licensed model.** It is
a distribution argument being applied to a use restriction.

### 3. The licence varies per _pipeline stage_, not only per checkpoint

Finding 1 says a release can carry two licences across its checkpoints. This is the same
shape one level up, and it is what decides phase A4.

A text-to-3D model earns its keep by producing a **mesh**. Neither leading open candidate
produces one from its weights alone — both reach it through a differentiable rasteriser, and
that stage is where the permissive story stops:

| component                                 | licence                    | restricts | verdict |
| ----------------------------------------- | -------------------------- | --------- | ------- |
| TRELLIS weights                           | MIT                        | —         | ✅      |
| InstantMesh weights                       | Apache-2.0                 | —         | ✅      |
| `nvdiffrast` (**both** need it)           | NVIDIA Source Code (1-Way) | **use**   | 🔴      |
| `diff-gaussian-rasterization` (→ TRELLIS) | Gaussian-Splatting License | **use**   | 🔴      |

This is not a transitive-dependency technicality. InstantMesh's `requirements.txt` installs
nvdiffrast **directly**, as a line of its own:

```
git+https://github.com/NVlabs/nvdiffrast/
```

And nvdiffrast §3.3 is _verbatim_ the clause PartField is already blocked under — so by
finding 2, standing it behind our own HTTP server changes nothing.

**"TRELLIS is MIT" is true and it is not the answer to the question A4 asks.** The question
is whether we may run the thing that makes the mesh.

⚠️ **What this does NOT establish**, stated so nobody reads more into it than was measured:
whether an inference-only GLB path can avoid the encumbered rasteriser altogether — marching
cubes is the obvious candidate, and `PyMCubes` (MIT) already sits in InstantMesh's
requirements. That question is answerable by reading the inference code and was not answered
here. Nor does this cover the hosted APIs (Meshy, Tripo, fal), where the terms are a contract
rather than a licence and would need their own verdicts.

---

## The cited text

### Kimodo — inference code · ✅ ALLOWED

Apache-2.0, already on the audit's permissive allowlist. GitHub reports SPDX `Apache-2.0`.
Its skeleton dependency [SOMA-X](https://github.com/NVlabs/SOMA-X) is also Apache-2.0.

- <https://github.com/nv-tlabs/kimodo/blob/main/LICENSE>

### Kimodo — the six commercially usable checkpoints · ⚠️ ALLOWED WITH CONDITIONS

`Kimodo-SOMA-RP-v1.1`, `Kimodo-SOMA-SEED-v1.1`, `Kimodo-SOMA-RP-v1`, `Kimodo-G1-RP-v1`,
`Kimodo-SOMA-SEED-v1`, `Kimodo-G1-SEED-v1` — all **NVIDIA Open Model License**, confirmed on
both the repo's checkpoint table and the Hugging Face model cards (`license_name:
nvidia-open-model-license`, ungated).

The licence states _"Models are commercially usable"_ and grants rights to _"sell, offer for
sale, distribute."_ It is **not** equivalent to MIT or Apache-2.0, and is recorded separately
for four reasons:

1. **Attribution (§3.1).** Ship a `NOTICE` file reading _"Licensed by NVIDIA Corporation under
   the NVIDIA Open Model License"_, and pass a copy of the agreement to recipients.
2. **Acceptable use (§2.3).** Use must stay consistent with NVIDIA's Trustworthy AI terms,
   incorporated by reference — so those terms can change without the licence changing.
3. **Automatic termination (§2.1).** Rights end on bypassing or weakening any safety guardrail,
   and on instituting copyright or patent litigation against NVIDIA.
4. **Revocable (§2.2).** The grant is described as revocable. MIT and Apache-2.0 are not.
   Treat continued availability as a dependency that can be withdrawn — the material
   difference from a permissive licence, and the reason this is a separate verdict rather
   than a footnote on ALLOWED.

⚠️ **Training-data note.** The full _Bones Rigplay 1_ dataset (700 h) is proprietary; only the
288 h _BONES-SEED_ subset is public, under a custom `bones-seed-license` and auto-gated. This
does not change the weights' verdict — the weights carry their own grant — but it is why the
weights' licence, not the data's, is the thing to rely on.

- <https://github.com/nv-tlabs/kimodo#models>
- <https://www.nvidia.com/en-us/agreements/enterprise-software/nvidia-open-model-license/>

### Kimodo-SMPLX-RP-v1 · 🔴 BLOCKED

**NVIDIA Internal Scientific Research and Development Model License**, §3.1:

> _"The Model and any Derivative Model may not be distributed, deployed, sublicensed, publicly
> displayed, publicly performed, or sublicensed by You. You may not use the Model or a
> Derivative Model in a production environment or for the purpose of generating works for sale
> or distribution."_

§2 limits the grant to _"internal, scientific research and development and in a non-production
environment."_ Generating works for sale or distribution is precisely this product. **Blocked.**

Use a SOMA or G1 checkpoint instead. If an SMPL-X skeleton is ever required, that is a
licensing problem, not an engineering one — SMPL-X's own terms are the reason this variant is
licensed differently.

- <https://www.nvidia.com/en-us/agreements/enterprise-software/nvidia-internal-scientific-research-and-development-model-license/>

### PartField · 🔴 BLOCKED — twice over

**Code.** GitHub reports `NOASSERTION`: a non-standard "NVIDIA License". §3.3:

> _"The Work and any derivative works thereof only may be used or intended for use
> non-commercially. Notwithstanding the foregoing, NVIDIA Corporation and its affiliates may
> use the Work and any derivative works commercially. As used herein, 'non-commercially' means
> for non-commercial research and educational purposes only."_

§3.2 propagates that limitation into any derivative works, so it cannot be wrapped away.

**Weights.** Worse, and easy to miss: the released checkpoint is hosted on a **personal
account with no declared licence at all** (`license: None`). No licence is not a permissive
licence — it is default copyright, granting nothing. The repo also records that licensing has
already constrained this release: _"Due to licensing restrictions, we are unable to release the
model that was also trained on PartNet."_

**Use SAMPart3D for A6.** PartField must not be designed in — and per finding 2 above, putting
it behind a service boundary does not rescue it.

- <https://github.com/nv-tlabs/PartField/blob/main/LICENSE>
- <https://huggingface.co/mikaelaangel/partfield-ckpt>

### SAMPart3D · ✅ ALLOWED

MIT on both halves — GitHub SPDX `MIT` on `Pointcept/SAMPart3D`, and the Hugging Face model
card declares `license: mit`, ungated. The unblocked path for A6.

- <https://github.com/Pointcept/SAMPart3D/blob/main/LICENSE>
- <https://huggingface.co/yhyang-myron/SAMPart3D>

### UniRig · ✅ ALLOWED

MIT on both halves — GitHub SPDX `MIT` on `VAST-AI-Research/UniRig`, and the Hugging Face
model card declares `license: mit`, ungated.

Licensing is not what gates this one. Auto-rigging waits on point-data survival in the
geometry model: a generated rig through an operator that drops point data deforms wrong with
no error.

- <https://github.com/VAST-AI-Research/UniRig/blob/main/LICENSE>
- <https://huggingface.co/VAST-AI/UniRig>

---

### TRELLIS — inference code · ✅ ALLOWED (the MIT part of it)

`LICENSE`: **MIT License, Copyright (c) Microsoft Corporation.**

The README's grant is worded carefully, and the wording is the finding:

> "TRELLIS models and the majority of the code are licensed under the MIT License."

**"the majority"** is doing real work. Two submodules are carved out — `diffoctreerast`,
which the README states is "derived from the diff-gaussian-rasterization project", and a
modified Flexicubes. Both carry their own terms and both are recorded separately below.

**Sources:** `github.com/microsoft/TRELLIS/blob/main/LICENSE`, `github.com/microsoft/TRELLIS#license`

### TRELLIS — weights · ✅ ALLOWED

The `microsoft/TRELLIS-image-large` model card declares **MIT**, with no separate weights
licence and no non-commercial clause. The weights really are unencumbered.

That is worth stating precisely because it is the half that misleads: what a director wants
from A4 is a mesh, and the weights are not what produce one. See finding 3.

**Source:** `huggingface.co/microsoft/TRELLIS-image-large`

### InstantMesh — code + weights · ✅ ALLOWED

`LICENSE` is the **Apache License 2.0**; the model card declares `apache-2.0`. Both sit on
the audit's existing permissive allowlist.

Its dependency set does not. See the next entry, and note that this one is not buried in a
lockfile — it is a line in `requirements.txt`.

**Sources:** `github.com/TencentARC/InstantMesh/blob/main/LICENSE`,
`huggingface.co/TencentARC/InstantMesh`

### nvdiffrast · 🔴 BLOCKED — and it is the entry that decides A4

**Nvidia Source Code License (1-Way Commercial)**, §3.3:

> "The Work and any derivative works thereof only may be used or intended for use
> non-commercially. The Work or derivative works thereof may be used or intended for use by
> Nvidia or its affiliates commercially or non-commercially. As used herein,
> 'non-commercially' means for research or evaluation purposes only and not for any direct
> or indirect monetary gain."

This restricts **use**, not distribution — so finding 2 applies and the over-HTTP carve-out
does not reach it. It is also, word for word, the clause PartField is blocked under.

What makes it decisive rather than incidental is that **both** A4 candidates need it.
InstantMesh's `requirements.txt` ends with `git+https://github.com/NVlabs/nvdiffrast/`, and
TRELLIS's installation instructions name it alongside `diffoctreerast`, `kaolin`, `spconv`
and `flash-attn`. Mesh extraction is the stage A4 exists to reach.

**Sources:** `github.com/NVlabs/nvdiffrast/blob/main/LICENSE.txt`,
`github.com/TencentARC/InstantMesh/blob/main/requirements.txt`,
`github.com/microsoft/TRELLIS#installation`

### diff-gaussian-rasterization · 🔴 BLOCKED

The **Gaussian-Splatting License** (Inria / MPII):

> "The _Software_ may be used 'non-commercially', i.e., for research and/or evaluation
> purposes only."
>
> "THE USER CANNOT USE, EXPLOIT OR DISTRIBUTE THE _SOFTWARE_ FOR COMMERCIAL PURPOSES WITHOUT
> PRIOR AND EXPLICIT CONSENT OF LICENSORS."

A use restriction, with a named contact for commercial consent
(`stip-sophia.transfert@inria.fr`). TRELLIS's `diffoctreerast` is stated by TRELLIS's own
README to derive from this project, so the restriction travels with the derivative.

**Source:** `github.com/graphdeco-inria/diff-gaussian-rasterization/blob/main/LICENSE.md`

### Hunyuan3D 2.0 · 🔴 BLOCKED — three ways, independently

The **Tencent Hunyuan 3D 2.0 Community License Agreement**. Not OSI-approved, and it fails
the repo's posture on three separate grounds, any one of which is sufficient:

1. **Territorial.** In capitals, at the top of the agreement:

   > "THIS LICENSE AGREEMENT DOES NOT APPLY IN THE EUROPEAN UNION, UNITED KINGDOM AND SOUTH
   > KOREA"

   The defined Territory is "the worldwide territory, excluding the territory of the European
   Union, United Kingdom and South Korea." For a user there, there is no grant at all.

2. **Scale.** Above **1 million monthly active users** as of the release date, a separate
   licence must be requested from Tencent.

3. **Conduct.** An Acceptable Use Policy is incorporated by reference, so the terms can move
   without the licence file moving — the same revocability concern recorded for the NVIDIA
   Open Model grant.

A licence that stops applying based on **where a user lives** is not one a shipped feature
can rest on. Recorded by name rather than quietly passed over, which is A0's stated exit.

**Source:** `github.com/Tencent-Hunyuan/Hunyuan3D-2/blob/main/LICENSE`

## The gate

`src/core/licensing/external-models.json` is the machine-readable record;
`scripts/external-model-audit.mjs` enforces it, and `npm run license-audit` runs it before the
npm tree walk, so CI needed no new wiring.

Three checks, and the second is the one with teeth:

1. **The manifest is well formed** — every entry has a verdict from a closed set, a reason, and
   at least one cited URL. A verdict with no citation is an opinion, and is rejected. A
   conditional grant with no listed conditions is rejected. A malformed date is rejected.
2. **No BLOCKED model is referenced** anywhere under `src/`, `tests/` or `scripts/`. Recording a
   verdict makes it known; this makes it enforced.
3. **No verdict has gone stale.** Past `staleness.warnAfterDays` (180) the audit warns; past
   `staleness.failAfterDays` (365) it fails. A per-model `checkedAt` overrides the manifest-wide
   one, so re-checking one model does not claim the others were re-checked.

Verified by constructing each failure rather than by observing a pass:

| constructed                                                | result                                                                 |
| ---------------------------------------------------------- | ---------------------------------------------------------------------- |
| blocked model referenced in `src/`                         | exit **3**, file named                                                 |
| blocked model referenced in `tests/`                       | exit **3**, file named                                                 |
| blocked model referenced in `scripts/`                     | exit **3**, file named                                                 |
| second blocked model, to show the gate is not keyed to one | exit **3**                                                             |
| `checkedAt` pushed past 365 days                           | exit **3**, age named                                                  |
| `checkedAt` pushed into the 180-day band                   | exit **0** with a warning — a review prompt must not red the build     |
| all probes removed                                         | exit **0**, `1229 files scanned across src, tests, scripts (3 exempt)` |

**`docs/` is deliberately not scanned**, and three files are exempt by exact path —
`external-models.json`, `external-model-audit.mjs`, and its test. Naming a blocked model is
their job; without the exemption the gate reds on its own record. The exemption list is
enumerated, never a glob or a directory, and a test asserts it stays that way — an over-broad
exemption re-opens the hole it was cut for while the gate keeps printing a pass.

### 🔴 What this gate does NOT catch

Stated plainly, because a control whose limits are unwritten gets trusted past them.

**It is a static text scan, so it cannot see a model id that does not exist at build time** — one
assembled by concatenation, supplied by a graph param, read from a config file, or typed into a
field. A checkpoint whose terms forbid production use can still be reached that way, and the
gate will report a clean pass. That pass is then read as coverage, which is worse than no gate.

No amount of widening the roots reaches this. The closure belongs where a model id is first
resolved into a request — the generation capability A1 builds, which should consult this same
manifest and refuse a BLOCKED id at runtime. Tracked as #739; part 2 lands with A1 (#729).

A second, smaller limit: matching is by substring, so an unrelated identifier containing
`partfield` would be reported. That direction is the safe one — it over-reports rather than
under-reports — and the report names the file, so it costs a glance.

### To add or re-check a model

Add an entry to `src/core/licensing/external-models.json` with the cited URLs, set its `checkedAt`, and add
a section here. Then run `npm run license-audit`.

🔴 **Two reasons to re-check rather than trust this file:**

- The NVIDIA Open Model grant is **revocable**, and the Trustworthy AI terms it incorporates
  live at a URL that can change without the licence changing. That is what the staleness
  thresholds exist for.
- **Check the specific checkpoint, not the project.** Finding 1 above exists because one
  release carried two licences.
