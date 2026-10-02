# Spool transport security — October 1, 2026

Status: reviewed-source preparation, not merged or deployed. The dependency slice
described below is PR #134. It is being assembled with the separately reviewed
access receiver, strict rules/tests and concise help into one release candidate,
so main does not deploy three intermediate combinations. Both raw dependency
audits report zero findings locally; strict application-rules preparation now
passes 75/75. Neither result authorizes live rules activation. See
`RULES-VERIFICATION-2026-10-01.md` for that distinct impact/approval boundary.

## Why this repair is scoped to the existing parent

The locked Firebase **12.7.0** / `@firebase/firestore` **4.9.3** remains unchanged.
Firestore's Node transport declares `@grpc/grpc-js ~1.9.0`, which resolves to affected
1.9.16. The publisher's [certificate-context advisory](https://github.com/grpc/grpc-node/security/advisories/GHSA-m9gg-hp2v-232j)
identifies fixed 1.13.6 and 1.14.5 releases. The accompanying
[error-disclosure advisory](https://github.com/grpc/grpc-node/security/advisories/GHSA-f596-whhp-79r4)
is fixed on the same lines. This is a dependency finding, not evidence that Spool exposes
the advisory's server-side client-certificate/RBAC configuration.

At the October 1 registry check, latest published Firebase was **12.19.0** and Firestore
**4.17.2**, but its manifest still selected `~1.9.0`. The upstream
[Firebase repair PR #10412](https://github.com/firebase/firebase-js-sdk/pull/10412) remained
open. A broad Firebase update therefore would not remove the vulnerable constraint.
The audit tool's suggested Firebase 9 downgrade is not an acceptable compatibility fix.

The application temporarily owns this exact override:

```json
"@firebase/firestore@4.9.3": {
  "@grpc/grpc-js": "1.14.5",
  "@grpc/proto-loader": "0.8.1"
}
```

It follows the reviewed [gRPC 1.14.5 release](https://github.com/grpc/grpc-node/releases/tag/@grpc%2Fgrpc-js@1.14.5)
and aligns Firestore's proto-loader with that transport's 0.8 line. This deliberately
crosses the parent's declared range and requires application-owned compatibility tests;
it is not a published Firebase fix. No global gRPC override or new Admin SDK was added.
Existing esbuild/Undici overrides, Node **22.19.0**, Wrangler **4.143.1**, and required
high-severity audit command/threshold remain unchanged.

## Exact lock delta from the retained 870dd27 source

| Package | Before | After | Reason |
| --- | --- | --- | --- |
| `@grpc/grpc-js` | 1.9.16 | 1.14.5 | Patched transport, exact parent-scoped override |
| `@grpc/proto-loader` | 0.7.15 | 0.8.1 | Matching exact loader override |
| `@js-sdsl/ordered-map` | absent | 4.4.2 | Declared dependency of the new transport |
| `protobufjs` | 7.6.5 | 7.6.6 | Compatible patch re-resolved within loader's `^7.5.5` range |
| `@protobufjs/utf8` | 1.1.1 | 1.1.2 | Compatible patch within protobuf's declared range |
| `yargs` | 17.7.2 | 17.7.3 | Compatible patch within loader's `^17.7.2` range |
| `brace-expansion` | 1.1.18 | 1.1.21 | Patched existing 1.x dependency of minimatch; no override needed |

The three protobuf/CLI patches are part of npm's re-resolution of the changed transport
subtree, not new app features or new direct dependencies. The real SDK serialization
tests below exercise this resolved tree. Original optional native-package `libc` metadata
was preserved after the lock updater omitted it; no unrelated package entry changed.

The brace patch covers the publisher's [nested-group recursion](https://github.com/juliangruber/brace-expansion/security/advisories/GHSA-qhr7-859c-m2p7),
[comma parsing recursion](https://github.com/juliangruber/brace-expansion/security/advisories/GHSA-6j4f-fj2g-mc7p),
and [quadratic expansion](https://github.com/juliangruber/brace-expansion/security/advisories/GHSA-q2hr-2g5m-vwhr)
findings. Ordinary expansion remains covered by a bounded regression fixture.

## What actually loads where

Firestore's Node CJS and ESM exports import gRPC/proto-loader externally. Tests resolve
those imports from Firestore's own installed location and confirm **1.14.5 / 0.8.1**,
including the loader resolved by gRPC. The SDK's embedded version/header strings are
not evidence of the loaded transport version.

The dependency-only production Vite graph contains **444 modules** and uses Firestore's browser
ESM entry. None of the seven changed lock packages, gRPC, proto-loader, or protobuf code
appears in that graph. The combined help candidate requires its own fresh graph
and asset record rather than inheriting that module count. This is build reachability evidence, not a deployed-byte or live
authentication claim. `npm audit --omit=dev` still audits the installed production tree,
including Node-only SDK dependencies; both that audit and the full audit are retained.
The Worker accesses Firestore through its existing REST helper; no Worker/app source is
changed by this preparation.

## Verification and limitations

- Dependency-only acceptance below is retained historical preparation evidence;
  final integrated-source gates are recorded separately in the suite archive.
- Clean locked install on Node 22.19.0; full and omit-dev raw audits report zero findings.
- Nine focused dependency/native tests; **1,302** full ordinary tests pass. The **34**
  emulator-dependent rules tests are skipped in that ordinary run, not counted as passed.
- **16 actual SDK operations** across Node CJS and ESM against local emulator 1.21.0:
  structured serialization (timestamp, bytes, reference, array), CRUD, batches, transactions,
  ordered queries, acknowledged listeners, permission-denied reads/writes/listeners, and
  not-found updates. These use deliberately synthetic local rules, not application rules.
- **Three actual gRPC loopback TLS cases**: valid trust/name accepted; wrong CA and hostname
  denied without delivering an RPC. Generated local certificates are not production PKI,
  and these tests do not reproduce the advisory's server-side client-certificate scenario.
- Existing native Sharp/AVIF test, lint, immutable-action check, Vite build, exact graph,
  and Worker dry bundle pass. No standalone TypeScript check exists in this repository.

SDK/TLS fixtures forbid non-loopback Node connections, use synthetic demo data, and do
not use cloud credentials. No real account, role, draft, rule deployment, or provider
setting is changed. Independent source review, credible application-rules acceptance,
all required hosted gates and separate approved release verification remain necessary.
POM's standing admin-merge approval is not a Spool override.

## Removal and recovery

Remove the scoped override only after a published Firebase parent selects a patched
transport, then repeat clean install, every-copy resolution checks, CJS/ESM native SDK
tests, TLS tests, browser graph, native/toolchain regression, full tests, meaningful rules
acceptance and both raw audits. An open PR or package `latest` label is not that evidence.
When the parent changes, update its exact regression assertion through deliberate review;
do not broaden the override to cover unreviewed versions.

A merge automatically deploys the Worker/SPA under the existing workflow. Do not merge
this source while other release gates remain unverified. Prefer a reviewed forward fix;
reverting the dependency change restores known findings and is not security-equivalent
recovery. No database rollback or rule change is part of this dependency preparation.
