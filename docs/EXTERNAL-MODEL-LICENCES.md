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

**A1 has a subject.** Kimodo's code is Apache-2.0 and six of its seven checkpoints are
commercially usable. **A6 has a subject too, but not the one to reach for first** — PartField
is blocked and SAMPart3D is the unblocked alternative.

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

## The gate

`scripts/external-models.json` is the machine-readable record;
`scripts/external-model-audit.mjs` enforces it, and `npm run license-audit` runs it before the
npm tree walk, so CI needed no new wiring.

Two checks, and the second is the one with teeth:

1. **The manifest is well formed** — every entry has a verdict from a closed set, a reason, and
   at least one cited URL. A verdict with no citation is an opinion, and is rejected. A
   conditional grant with no listed conditions is rejected. A missing or malformed
   `checkedAt` is rejected, so a stale audit cannot pass quietly.
2. **No BLOCKED model is referenced anywhere in `src/`.** Recording a verdict makes it known;
   this makes it enforced.

Verified by constructing the failure rather than assuming it: a file referencing
`Kimodo-SMPLX-RP-v1` in `src/` makes the gate exit **3** and name the file; removing it returns
exit **0** with `932 source files scanned` printed as the denominator. Repeated with
`partfield` to confirm the gate is not keyed to one model.

### To add or re-check a model

Add an entry to `scripts/external-models.json` with the cited URLs, bump `checkedAt`, and add
a section here. Then run `npm run license-audit`.

🔴 **Two reasons to re-check rather than trust this file:**

- The NVIDIA Open Model grant is **revocable**, and the Trustworthy AI terms it incorporates
  live at a URL that can change without the licence changing.
- **Check the specific checkpoint, not the project.** Finding 1 above exists because one
  release carried two licences.
