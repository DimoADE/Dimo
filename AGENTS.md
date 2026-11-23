# Dimo Agent Guidelines

Lean guidance for coding agents working in Dimo. Keep context light: read deeper docs **on demand** for the branch you touch rather than front-loading everything.

## On-Demand Context Pointers

- **Find any doc or ADR**: [`docs/INDEX.md`](docs/INDEX.md) (directory map, task routing table, all active ADRs).
- **System boundaries & 26-crate map**: [`docs/architecture.md`](docs/architecture.md).
- **Domain terminology**: [`CONTEXT.md`](CONTEXT.md).
- **Frontend UI, tokens & styling**: [`DESIGN.md`](DESIGN.md) and [`frontend/CLAUDE.md`](frontend/CLAUDE.md) (read when touching user-visible UI).
- **Engineering discipline & complex tasks**: [`maiden-skill`](.agents/skills/maiden-skill/SKILL.md) and task-matching skills under `.agents/skills/`.

## Core Architectural Invariants

1. **Single-Seam Rust Host + Electron Thin Shell** ([ADR-0078](docs/adr/0078-host-command-registry-single-seam.md), [ADR-0090](docs/adr/0090-electron-thin-shell-and-desktop-sidecar.md)): Product commands register once in `HostCommandRegistry` (`crates/application`, mirrored in `shared/hostCommands.ts`) and push updates flow through `HostEventBus`. `electron/` (`@dimo/electron`) is a thin shell spawning `dimo-server --desktop`; UI components talk through `BackendTransport` (`frontend/src/lib/transport/`), keeping Electron Desktop and headless `dimo-server` identical.
2. **Agent Integration** ([ADR-0087](docs/adr/0087-dedicated-agent-engine-first-acp-fallback.md)): Route all coding agents through `crates/agents` + `crates/conversations`, prioritizing **dedicated native Agent engine adapters** first and **ACP (v1/v2 + Registry)** as compatibility fallback. Reserve `crates/executors` strictly for workspace shell scripts and shared log/identity types.
3. **SQLite Single-Authority Conversations** ([ADR-0091](docs/adr/0091-sqlite-single-authority-conversation-projection.md)): `conversation_events` and `conversation_timeline_rows` on `WritePool(1)` / `ReadPool(4)` are the sole authority for conversation history and timeline projections.
4. **Full-Trust v4 Plugins with Zero Host Privilege** ([ADR-0048](docs/adr/0048-full-trust-plugin-execution-model.md), [ADR-0069](docs/adr/0069-everything-is-a-plugin-platform.md)): Official plugins in `plugins/*` use the exact same public contract as third-party plugins—no plugin-ID special cases in Host code.

## Essential Commands & Generated Artifacts

Full scripts live in [`package.json`](package.json):

- `pnpm run dev` — Launch Electron desktop app + Vite HMR + `dimo-server --desktop` sidecar.
- `pnpm run check` / `pnpm run lint` / `pnpm run format` — Typecheck, lint (`--max-warnings 0`, clippy `-D warnings`), and format.
- `pnpm --filter ./frontend test` / `pnpm run electron:test` / `cargo test --workspace` — Unit and integration tests (run targeted tests first).
- `pnpm run arch:check` & `pnpm run plugin:no-privilege` — Verify architecture invariants and zero plugin privilege.

Regenerate derived artifacts via scripts instead of editing them by hand:

- `shared/types.ts` → register new `#[derive(TS)]` types in [`generate_types.rs`](crates/server/src/bin/generate_types.rs) and run `pnpm run generate-types`.
- `crates/db/.sqlx/` → run `pnpm run prepare-db` after SQLx query or migration changes.
- `docs/protocol/v1/` → run `pnpm run remote-protocol-schema` (checked via `remote-protocol-schema:check`).
- `docs/plugins/contract-bindings.md` → run `node scripts/plugin-contract-report.mjs`.

## Documentation Authoring Standards

Every document in this repository must stay accurate, concise, and easy to index:

1. **Write current truth in place**: When behavior or architecture changes, edit the existing section directly. Never append revision banners (`状态注记`), `## Amendment` sections, or "previously A, updated to B" change histories.
2. **Keep prose high-signal and brief**: Record durable contracts, boundaries, and key trade-offs. Compress historical background to 2–3 sentences; omit sprint logs, PR checklists, debugging diaries, and implementation blow-by-blows.
3. **Delete obsolete docs cleanly**: Once a plan lands or a spec/ADR is replaced, fold durable contracts into the canonical doc and delete the obsolete file. Never commit completed plans, temporary audits, scratch todos, or screenshot dumps into `docs/`.
4. **Follow canonical paths, naming, and indexing**: Place each doc in its designated directory per [`docs/INDEX.md`](docs/INDEX.md) using lowercase ASCII `kebab-case.md` (ADRs: `docs/adr/NNNN-kebab-case.md` with `status: accepted` frontmatter). Update [`docs/INDEX.md`](docs/INDEX.md) in the same change whenever adding, moving, renaming, or deleting a doc.
