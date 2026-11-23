# CLAUDE.md

Follow [`AGENTS.md`](AGENTS.md) for context pointers, architecture invariants, commands, and documentation standards.

## Quick Test Filters

```bash
pnpm --dir frontend exec vitest run src/path/to/file.test.ts
pnpm --dir frontend exec vitest run -t "test name"
cargo test -p agents test_name
pnpm run electron:check && pnpm run electron:test
```

## Non-Obvious Gotchas

- **Path aliases**: `@` → `frontend/src`, `shared` → `shared/`.
- **`qa-mode` feature**: `pnpm run lint` compiles Rust with `--features qa-mode` (`QaMock`); keep code compiling under both default and `qa-mode` features.
- **SQLx offline metadata**: Install `sqlx-cli` once (`cargo install sqlx-cli --no-default-features --features sqlite`) before running `pnpm run prepare-db`.
- **TLS initialization order**: `install_rustls_crypto_provider` runs once at startup (`reqwest` uses no-provider mode); construct TLS clients only after startup initialization.
- **Dynamic dev ports**: `scripts/run-electron-dev.js` writes runtime ports to local `.dev-ports.json` (gitignored); keep local secrets in `.env` files only.
- **UI & styling**: Read [`DESIGN.md`](DESIGN.md) and [`frontend/CLAUDE.md`](frontend/CLAUDE.md) when modifying frontend UI or CSS.
- **Documentation discipline**: Always write current-state truth in place, delete retired docs, avoid historical fluff, and keep [`docs/INDEX.md`](docs/INDEX.md) in sync (see `AGENTS.md`).
