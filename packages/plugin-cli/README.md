# `@dimoai/plugin-cli` (`dimo-plugin`)

Official authoring toolchain (`v2.0.0`) for scaffolding, validating, building, testing, live-linking, diagnosing, and packaging **Dimo v4 Full-Trust Plugins** (`.vxp`).

## Commands

```bash
# Bind a running Dimo Host (writes ~/.dimo/pluginrc; uses Remote Protocol v1 POST /api/v1/call/*)
dimo-plugin run server [--http://127.0.0.1:17891] [--token <token>]

# Scaffold, validate, build, test, and package
dimo-plugin toolchain                                       # Print Host version, contract, SDK paths, and templates
dimo-plugin init [dir] [--publisher <id>] [--template full] # Scaffold a v4 plugin package (16 templates)
dimo-plugin validate [dir] [--json]                         # Validate manifest, README summary, contents, icons, and schema
dimo-plugin build [dir]                                     # Bundle Worker & App surfaces (esbuild / Vite Module Federation)
dimo-plugin test [dir] [--host]                             # Run unit tests, or full live Host journey with --host
dimo-plugin pack [dir] [--output file.vxp]                  # Produce a deterministic .vxp archive with sha256 digest

# Live development against the bound Host
dimo-plugin install --link [dir]                            # Build and register a linked development directory
dimo-plugin dev [dir]                                       # Alias of `run dev`: build, watch, candidate reload & Vite HMR
dimo-plugin run dev [dir]                                   # Watch sources, reload Worker generations, serve Federation HMR
dimo-plugin run build [dir]                                 # Build within the bound Host context
dimo-plugin run test [dir] [--host]                         # Run tests (or live Host journey with --host)
dimo-plugin reload [id|dir]                                 # Trigger an immediate candidate reload on the Host
dimo-plugin doctor [dir]                                    # Inspect installation, generation, runtimes, contributions & crashes
dimo-plugin uninstall [dir] [--delete-data]                 # Uninstall from Host (never deletes your source directory)
```

Available `--template` values: `skill`, `mcp`, `file-tab`, `editor-tab`, `full`, `ts-worker`, `node-worker`, `python-worker`, `rust-worker`, `host-service`, `hooks`, `host-chrome`, `provider-import`, `provider-catalog`, `panel`, `kanban-view`.

## Relationship with `dimo plugin` (`npx-cli`)

- `dimo-plugin` (`@dimoai/plugin-cli`) is the plugin author build, validation, testing, and HMR toolchain.
- `dimo plugin` (from the `dimo` CLI in `npx-cli/`) provides user and developer Host commands: `add --dev` (links the directory and returns immediately), `run dev` (watches and drives HMR), `add --web` / `--profile`, `publish`, `list`, `enable`, `disable`, `update`, `remove`, and `gc-runtimes`.

When working inside the Dimo monorepo, build once with `pnpm --filter @dimoai/plugin-cli build` and invoke `node packages/plugin-cli/dist/cli.js <command>`.

## Documentation

- [SDK & CLI Reference](../../docs/plugins/sdk-and-cli.md)
- [Plugin Developer Guide](../../docs/plugins/developer-guide.md)
- [Package v4 Specification](../../docs/plugins/package-v4.md)
- [Host & Contribution Bindings](../../docs/plugins/contract-bindings.md)
