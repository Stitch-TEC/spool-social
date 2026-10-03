# Review-details permission candidate

Preparation only. Neither `.rules` file here is referenced by the app's Firebase deployment configuration. The complete current `firestore.rules` contains separately held work and was not substituted into this candidate.

Baseline: historical deployed August 25 source, commit `9e1e88dbee9cee90c0a3b2408a69893f06cd350a`, SHA256 `be60b8d68aca925c5f1f35baa6b045b3b44dbcb0a0dd02dc6241b21af8760b1d`, 26,767 bytes. The prior stage matched it through a read-only signed-in console; this stage did not reread or publish provider rules.

`run-review-details-native.mjs` starts only an owned local emulator with synthetic projects and requires suite-local evidence paths. It compares native SDK/REST legacy behavior and deny-only extension fences, preserves failed evidence and stops its emulator. It intentionally returns failure if evaluator diagnostics remain, even when all paired outcomes match. It does not deploy, access production, alter grants or relax the gate.

Latest native matrix: 679 paired scenarios / 1,358 requests, all comparisons matching, but 84 inherited evaluator-fault observations. Therefore the candidate is **not accepted for activation**. The final runner's suite-boundary checks were syntax-tested after that matrix; they did not change the rules or request bodies, and were not a fresh native acceptance run.

Current source, limits and remaining activation gates: [Review details rollout](../docs/REVIEW-DETAILS-ROLLOUT.md). Private evidence is retained in the suite's `_archive-2026-10/spool-review-writer-fences-20261002/rules/`.
