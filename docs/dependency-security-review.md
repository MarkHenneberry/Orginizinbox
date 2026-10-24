# Dependency security review

Reviewed 2026-10-20 against the npm registry audit and the installed dependency tree.
This is a dependency review, not a penetration test or live Vercel/DB validation.
No product semantics, production flags, secrets, schema or migrations changed.

## Updates

Keep Next.js and eslint-config-next together at 16.3.8, within the existing 16.3
line. Keep workflow/core at 4.8.5 and @workflow/vitest at 4.0.21. Do not upgrade
Workflow to 5 merely to satisfy npm's suggested force fix.

Workflow 4 pins devalue 5.8.1 exactly. Override only @workflow/core's devalue to
5.9.4 (same major). Its serialization-format helpers resolve the same patched
package. Patch the existing Undici 7 override from 7.29.0 to 7.29.1. Remove these
overrides only when the upstream packages resolve safe versions themselves.

Other updates are lockfile resolutions within the existing dependency ranges:
brace-expansion 1.1.21 / 2.1.7 / 5.0.12, http-cache-semantics 4.3.0,
ip-address 10.7.4, js-yaml 4.3.2, proxy-addr 2.0.8, qs 6.16.1, sharp 0.35.5
(and its matching platform binaries/libvips), source-map-js 1.2.2. A compatible
fastq patch also changes from 1.20.1 to 1.20.3 during resolution.

No audit fix --force, package-manager major upgrade, application rewrite or
vulnerable-package downgrade was used. Commit the lockfile with package.json;
deployment must use npm ci to retain these reviewed transitive resolutions.

## All original findings and exposure

The original 31 audit entries include propagated parent-package findings, not
31 distinct exploitable application vulnerabilities.

| Finding family | Installed use / original production exposure | Resolution |
| --- | --- | --- |
| Next.js (critical/high/moderate/low) | Production framework. Windows RCE does not apply to Linux Vercel; app/icon.tsx uses fixed ImageResponse content, not attacker-controlled SVG; no Draft Mode/use-cache or dynamic metadata-image input was found. Image optimizer/cache vulnerabilities still warrant patching the framework rather than assuming platform mitigation. | 16.3.8 patches all currently reported Next.js advisories. |
| proxy-addr (critical) | Express under the Workflow CLI/local dashboard, not the Next.js application request server. No application trust-proxy/IP authorization use. | 2.0.8. |
| devalue and propagated Workflow packages (high/moderate/low) | Real Workflow serialization dependency; most reported attacks require special malformed/shared-memory/custom-reviver inputs not used by our small argument/result envelopes. Do not dismiss a runtime parser dependency as development-only. | Scoped 5.9.4 override; same Workflow major and wire formats. |
| undici and propagated Workflow World packages (high/moderate/low) | HTTP dependency in local and Vercel Workflow adapters. Custom WebSocket, caching-interceptor and BalancedPool use was not found in application code; adapter exposure is not assumed absent. | 7.29.1. |
| sharp/libvips (high) | Next.js image processing. Current app uses first-party logo assets and no customer image-upload flow; still a production image decoder. | 0.35.5 plus matching platform packages. |
| ip-address (moderate) | socks under ImapFlow. No user-controlled proxy address/SSRF allowlist implementation; relevant to mail transport dependencies, not just lint. | 10.7.4. |
| http-cache-semantics (high) | got/downloader under Workflow Nest/SWC tooling; not the application's authenticated fetch cache. | 4.3.0. |
| qs (moderate) | Express/body-parser in local Workflow dashboard, not normal Next.js route parsing. | 6.16.1. |
| brace-expansion (high/moderate) | File/glob tooling in ESLint, Workflow CLI, SWC and local queue dependencies; no customer-supplied glob evaluation in application code. | Same-major patches on each dependency branch. |
| js-yaml (high) | ESLint configuration loader; application does not parse uploaded YAML. | 4.3.2. |
| source-map-js (high) | PostCSS/Tailwind source-map tooling, not customer-submitted source maps. | 1.2.2. |
| braces plus micromatch/fast-glob/Next ESLint parents (high) | Development-only ESLint glob chain. No application imports or customer-controlled glob input. | Accepted tooling risk below; no published upstream patch. |

## Remaining finding

Full npm audit retains five high-severity entries for ONE advisory:
[GHSA-vfj7-8cjw-p6xm](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm).
The dependency path is eslint-config-next -> @next/eslint-plugin-next -> fast-glob
-> micromatch -> braces 3.0.3. It is marked dev-only in the lockfile, and
`npm audit --omit=dev` reports zero vulnerabilities after the updates.

The advisory has no published patched braces release. npm's force suggestion
downgrades eslint-config-next to 14, which is not an appropriate Next.js 16 fix.
Do not replace the parser with an unrelated package or override it to an
incompatible major merely to obtain a green audit.

Risk: malicious deeply nested glob patterns could crash lint/build tooling.
The deployed application does not accept/evaluate such patterns, so no production
request-path exploit was identified. Keep build configuration trusted; do not run
untrusted fork code with production secrets. Monitor the advisory and update the
toolchain when an upstream compatible fix exists. Full audit intentionally remains
nonzero; do not hide it with an increased severity threshold.

## Compatibility and deployment caveats

Focused tests use the actual Workflow 4 serializer/revivers with the patched
dependency for arguments and results, identity sharing, Dates/Map/Set/typed bytes,
legacy JSON-array wire format, and encrypted recovery results/wrong-key rejection.
These do not claim to replay every historical Vercel run or prove DB transactions.
Do not start provider requests or connect the integration harness to production.

The patched production build's 75 .nft.json trace manifests contain no braces,
micromatch, fast-glob, eslint-config-next or @next/eslint-plugin-next files.
Shipping a package in node_modules is not the same as exposing its CLI or parser
as an HTTP endpoint. Repeat this trace check after future toolchain changes.

The npm Undici override patches installed dependencies, not Node.js's embedded
global fetch implementation. Vercel's managed Node runtime must also receive
platform security updates; its actual deployed patch version was not inspected or
changed here. Re-run both audits on future lockfile/runtime updates.

This clears the identified production dependency-audit blocker; it does not clear
the independent real-Postgres, large-job TTL, migration and controlled-rollout
validation requirements documented in outlook-state-storage.md.

## Validation results

- npm install completed, including the existing Prisma generation postinstall;
  no database migration or query was run.
- Full suite: 1,200 passed, one skipped, including six new Workflow serializer
  compatibility tests. The live-provider safety proof was explicitly disabled for
  this local test process, as in prior offline validation.
- ESLint, TypeScript and the Next.js 16.3.8 production build passed. The build
  compiled nine Workflow steps and five Workflows.
- npm audit --omit=dev: zero findings. Full npm audit: five high entries from the
  one development-only braces advisory; zero critical/moderate/low findings.
- PostgreSQL and DB-backed Workflow integration suites remain unrun: no isolated
  TEST_DATABASE_URL is available. Existing no-production-fallback safeguards were
  not changed, and no live provider or payment requests were made.

References:
- [Next.js 16.3.8](https://github.com/vercel/next.js/releases/tag/v16.3.8)
- [devalue 5.9.4](https://github.com/sveltejs/devalue/releases/tag/v5.9.4)
- [Undici 7.29.1](https://github.com/nodejs/undici/releases/tag/v7.29.1)
