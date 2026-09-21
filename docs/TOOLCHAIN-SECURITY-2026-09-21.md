# Spool development-tool security — September 21, 2026

## Scope and release boundary

This repairs development/build dependency findings, not app behavior. The fresh audit of main
`c2f747cc42147c4f6c75a974d1b6eb8f8d99cf6a` reported seven entries: four high and three moderate.
These represent four advisory families, because npm also reports vulnerable dependency parents.
All affected packages are development dependencies. The 198 non-root production lockfile records
remain byte-for-byte identical, and no application/Worker source, Firebase rules, bindings, runtime
compatibility date, AI gateway behavior, identity, client data or provider configuration changes.

**A merge is a deployment:** Spool's existing main workflow builds and automatically deploys to
Cloudflare. This preparation does not authorize that merge or constitute production acceptance.
Review the exact commit and all four required hosted checks before deciding whether to release.
Firestore rules deployment remains manual and is unnecessary for this change.

## Reviewed versions

| Component | Before | After | Reason |
| --- | --- | --- | --- |
| Wrangler | 4.116.0 (`~4.116.0`) | **4.131.0**, exact manifest/deploy pin | First patched Wrangler release for this Sharp chain; do not float the deploy tool |
| Miniflare | 4.20260730.0 | 5.20260910.0-alpha | Exact dependency selected by that Wrangler release, not an independently forced override |
| Sharp / bundled libheif | Sharp 0.35.2 | Sharp 0.35.4 / libheif 1.23.2 | Native image decoder fix |
| Vitest and its matching packages | 4.1.7 | **4.1.11**, exact direct pin | Patched mocker redirect boundary, same major/minor line |
| js-yaml | 4.3.1 | 4.3.2 | Bounded YAML merge handling fix; existing ESLint dependency range |
| baseline-browser-mapping | 2.10.44 | 2.11.25 | Fixed invalid-input handling; existing browserslist dependency range |

The previous decision to stay on Wrangler 4.116 avoided Miniflare's alpha line when it offered no
security benefit. That rationale no longer applies to this advisory: the old release pins vulnerable
Sharp 0.35.2. The selected **published Wrangler release** carries its own matching Miniflare and
workerd versions. No direct Miniflare dependency or new Sharp override is introduced. Spool does not
call a Miniflare API in application source; its package, native library and local Worker behavior are
verified through the actual installed toolchain. Existing esbuild and undici overrides are unchanged.
Node remains **22.19.0** in both verification and deployment; Vite's Safari 14 build floor is unchanged.

Sources: [Sharp/libheif advisory](https://github.com/advisories/GHSA-rgj7-g3m4-5g8c),
[Vitest/mocker advisory](https://github.com/advisories/GHSA-82fw-gwwq-j7x9),
[js-yaml advisory](https://github.com/advisories/GHSA-2883-xcg3-v3hh),
[baseline-browser-mapping advisory](https://github.com/advisories/GHSA-w5vr-8v7q-w6rv), and
[Wrangler 4.131.0 release](https://github.com/cloudflare/workers-sdk/releases/tag/wrangler%404.131.0).

## Verification contract

`scripts/toolchain-security.test.js` runs in the existing full test job. It verifies the manifest,
lockfile, Wrangler/Miniflare/Sharp relationship and exact release command; scans every resolved copy
of each patched package; loads the native Sharp dependency through Miniflare's own resolution; and
encodes/decodes synthetic AVIF bytes with the actual patched native library. No customer image is used.

Release verification must include locked install, full and production-only audits, complete unit
tests, actual Firestore emulator rules tests, lint, immutable-action checks, production Vite build,
Worker syntax, dry-run Worker bundle and an isolated local Worker smoke check. This JavaScript repo
has no standalone TypeScript/typecheck command; do not claim a nonexistent typecheck passed.
Linux hosted CI also exercises the native regression, rather than relying solely on macOS binaries.
No test invokes a live Google/AI provider or changes production Firebase/Cloudflare data.

The existing high-severity audit, CodeQL, dependency-review and build checks remain required. No
audit threshold, test, coverage gate, branch protection, event trigger or deploy permission is relaxed.
The audit workflow's outdated toolchain explanation is corrected; its commands are unchanged.

### Local acceptance

Verified on Node 22.19.0: clean locked install; **zero full and production-only audit findings**;
**509 ordinary tests passed** (the 30 emulator tests are intentionally skipped without an emulator),
then **all 30 rules tests passed** against Firestore emulator 1.21.0 / Java 21. Lint, 12 immutable action
references, Vite build, Worker syntax and Wrangler dry bundle passed. The local Worker returned 200
for health and the built SPA/module, and correctly denied anonymous draft access with 401.
Four new native/toolchain tests are included in those counts. No TypeScript gate exists here.

The local Java runtime was a checksum-verified portable Temurin 21.0.12.1 download confined to the
suite's dated QA archive; no global Java installation or production credentials were required.
Hosted required-check results and any later merge/deployment acceptance belong to the PR/release
record; local green does not substitute for them.

## After an approved merge, or if release fails

Watch the separate deployment workflow for the exact merge SHA. Then verify the public app loads
and its existing `/api/health` route responds; installed iPhone/Mac verification is useful because
Spool's service worker/browser state is not proven by a build. Do not mark production accepted from
the source PR's green checks alone. A failure of the new exact-version check is a stop, not a reason
to skip it or install an unpinned Wrangler.

Prefer a reviewed fix-forward. Reverting this update restores known vulnerable development tooling;
it is not a security-equivalent rollback. If urgent runtime recovery is necessary, the owner should
select the previously verified Worker deployment and verify it separately—without reverting database
rules, data, bindings, secrets or gateway restrictions. No rollback or deployment was performed as
part of preparing this source change.
