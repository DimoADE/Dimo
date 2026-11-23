# Dependency and License Audit

The release gate runs `pnpm run dependency:licenses` (`scripts/check-dependency-licenses.mjs`) against the resolved production `pnpm` dependency graph and locked Cargo metadata. All third-party registry dependencies must declare an approved permissive or weak-copyleft SPDX license expression; workspace crates are covered by the repository license and excluded from external registry checks.

## Policy & Exceptions

- **Reviewed Unknown-Metadata Exceptions (`REVIEWED_UNKNOWN_PACKAGES`)**: `khroma@2.1.0` omits the `license` field in `package.json` while shipping an unmodified MIT `license` file in its tarball. The exception is pinned to the exact version so any upgrade requires explicit re-review.
- **Reviewed Non-SPDX License Exceptions (`REVIEWED_NON_SPDX_PACKAGES`)**: `@gsap/react@2.1.2` and `gsap@3.15.0` publish their license as the human-readable GSAP Standard License rather than an SPDX expression; the upstream license permits no-charge commercial use. Both exceptions are pinned to exact versions so any upgrade triggers explicit re-review.
- **Transitive Security Overrides**: Root `package.json` `pnpm.overrides` pins patched versions for transitive advisories so production dependency graphs stay free of `high` and `critical` vulnerabilities.
- **Unfixed Advisory Exceptions**: `pnpm.auditConfig.ignoreGhsas` records a high advisory only when no patched release exists and the production path does not accept untrusted vulnerable input. `GHSA-fc5q-39xc-vjpf` (`picomatch <=4.0.7`, no upstream patch) is ignored because the only production edge is `@dimoai/plugin-cli` → `vite`, which compiles developer-authored build globs. Remove the entry once upstream ships a fix.
- **Online CI Advisory Gates**: CI additionally enforces `rustsec/audit-check` for Cargo crates and `pnpm audit --prod --audit-level high` for npm packages, complementing the deterministic offline license gate.

See root [`THIRD_PARTY_NOTICES.md`](../../THIRD_PARTY_NOTICES.md) and [`docs/third-party/`](../third-party/) for third-party attributions and vendored skill provenance.

## Verification

```bash
node --test scripts/check-dependency-licenses.test.mjs
pnpm run dependency:licenses
pnpm audit --prod --audit-level high
```
