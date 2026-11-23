# Dimo Pulse SDK (`@vibex/pulse-sdk`)

Typed TypeScript + ESM SDK, Standard Webhooks signer/verifier, Dual-Primitive workflow builders, REST client, and CLI (`vibex-pulse`) for **Dimo Pulse** — Dimo's AI-Native Event-Driven Automation Engine (`v0.5.2`).

Zero external runtime dependencies (built on Node 20+ `node:crypto`, `fetch`, and native TypeScript type-stripping).

> Note: The workspace package name (`@vibex/pulse-sdk`), CLI binary (`vibex-pulse`), and environment variable prefix (`VIBEX_*`) are retained verbatim from `packages/pulse-sdk/package.json` and `src/client.ts` for wire and script compatibility with Dimo Host.

## Package Export Subpaths

| Subpath | Description |
| --- | --- |
| `@vibex/pulse-sdk` (`.`) | Main entrypoint: wire types matching `crates/api-types/src/pulse.rs`, `defineEvent`, `pulseRule`, `pulseWorkflow`, `PulseClient`, `PulseHttpError`, `evaluatePulseRuleLocally`, `validatePulseRuleSpec`, plus Standard Webhooks re-exports. |
| `@vibex/pulse-sdk/webhook` (`./webhook`) | Standalone Standard Webhooks helpers: `signStandardWebhook`, `verifyStandardWebhook`, `decodeWebhookSecret`, and constants (`STANDARD_WEBHOOK_SECRET_PREFIX`, `MAX_STANDARD_WEBHOOK_BYTES` = 64 KiB, `DEFAULT_WEBHOOK_TOLERANCE_SECONDS` = 300s). |
| `@vibex/pulse-sdk/cli` (`./cli`) | Programmatic CLI runner (`runCli`, `main`, `CliIo`, `CliRunResult`) backing `vibex-pulse emit` and `vibex-pulse dry-run`. |

## Capabilities

- **Typed Wire Contracts (`src/types.ts`)** — 1:1 TypeScript definitions for `EventEnvelope`, `GateFilterAst`, `PulseRuleSpec`, `PulseTargetSpec`, `PulseTemporalSpec`, `PresetOrchestratorKind`, `MandateOrigin`, and Dual-Primitive `SessionStep` / `BotStep` workflow specs.
- **Custom Event Schemas (`defineEvent`)** — Exhaustive (No Fail-Fast) JSON Schema + custom payload validation and monotonic ULID `EventEnvelope` generation.
- **Standard Webhooks (`@vibex/pulse-sdk/webhook`)** — Constant-time HMAC-SHA256 verification (`timingSafeEqual`) checking body ceiling (≤ 64 KiB), required headers, and 5-minute replay window before JSON parsing.
- **Fluent Builders (`pulseRule`, `pulseWorkflow`)** — Declarative rule authoring across all 5 receptor kinds (`Session`, `Bot`, `Group`, `User`, `Workflow`) and Dual-Primitive workflows mixing ephemeral `sessionStep` nodes with persistent `botStep` nodes.
- **REST Client (`PulseClient`)** — Speaks `/api/pulse/*` on Dimo Host with optional Bearer token and Standard Webhooks HMAC-SHA256 (`x-pulse-source-id` + `webhook-*` headers), configurable request timeout (`timeoutMs`, default `15_000` ms), and a pluggable `PulseTransport` seam for testing.
- **CLI (`vibex-pulse`)** — `vibex-pulse emit` (live or `--offline` envelope generation) and `vibex-pulse dry-run` (local offline or Host-side rule evaluation).

## Endpoint & Authentication Environment Variables

`PulseClient` resolves connection settings in the following precedence order:

| Setting | Resolution Order |
| --- | --- |
| **Base URL** | `options.baseUrl` → `VIBEX_PULSE_URL` → `VIBEX_SERVER_URL` → `http://127.0.0.1:${VIBEX_WEB_PORT}` (when set) → `http://127.0.0.1:17891` (default for both Dimo Desktop `dimo-server --desktop` and standalone `dimo-server`) |
| **Bearer Token** | `options.bearerToken` → `VIBEX_PULSE_TOKEN` → `VIBEX_SERVER_TOKEN` |
| **Webhook HMAC Secret** | `options.hmacSecret` → `VIBEX_PULSE_WEBHOOK_SECRET` (supports `whsec_<base64>` or raw UTF-8 secret) |

If your `dimo-server` listens on a custom host or port, pass `baseUrl` or set `VIBEX_SERVER_URL` / `VIBEX_PULSE_URL`.

## Quick Start

### Define an Event, Build a Rule, and Save via `PulseClient`

```ts
import {
  defineEvent,
  pulseRule,
  PulseClient,
} from '@vibex/pulse-sdk';

const CoverageDropped = defineEvent<{ repo: string; coverage: number }>({
  eventType: 'ci.coverage.dropped',
  summary: 'Emitted when main branch coverage drops below threshold',
  jsonSchema: {
    type: 'object',
    required: ['repo', 'coverage'],
    properties: {
      repo: { type: 'string', minLength: 1 },
      coverage: { type: 'number', minimum: 0, maximum: 100 },
    },
    additionalProperties: false,
  },
});

const rule = pulseRule('Guard test coverage')
  .mode('observe')
  .fromSources('sdk_custom')
  .onEventTypes(CoverageDropped.eventType)
  .notBotActor()
  .whereLt('/coverage', 80)
  .toFreshSession({
    agentId: 'codex',
    workspaceIsolation: 'isolated_worktree',
    subscribeThread: true,
    promptTemplate: 'Coverage in {{repo}} dropped to {{coverage}}%. Add missing tests.',
  })
  .build();

const client = new PulseClient({ timeoutMs: 15_000 });
const deck = await client.deckSnapshot();
await client.defineSchema({
  eventType: CoverageDropped.eventType,
  summary: CoverageDropped.summary,
  jsonSchema: CoverageDropped.jsonSchema,
});
await client.saveRule({ spec: rule, enabled: true });
```

### Verify Inbound Standard Webhooks (`@vibex/pulse-sdk/webhook`)

```ts
import {
  signStandardWebhook,
  verifyStandardWebhook,
} from '@vibex/pulse-sdk/webhook';

const signed = signStandardWebhook({
  secret: process.env.VIBEX_PULSE_WEBHOOK_SECRET!,
  payload: { repo: 'Dimo', coverage: 74.5 },
});

const verified = verifyStandardWebhook<{ repo: string; coverage: number }>({
  secret: process.env.VIBEX_PULSE_WEBHOOK_SECRET!,
  headers: signed.headers,
  rawBody: signed.body,
});
```

### CLI & Programmatic Runner (`vibex-pulse` / `@vibex/pulse-sdk/cli`)

```bash
# Emit an event to Dimo Host (or pass --offline to print an EventEnvelope without sending)
vibex-pulse emit \
  --type ci.coverage.dropped \
  --data '{"repo":"Dimo","coverage":74.5}' \
  --url http://127.0.0.1:17891 \
  --token "$VIBEX_SERVER_TOKEN"

# Dry-run a rule against a sample event locally (or pass --url to evaluate on Dimo Host)
vibex-pulse dry-run --rule ./rule.json --event ./event.json
```

```ts
import { runCli } from '@vibex/pulse-sdk/cli';

const result = await runCli([
  'emit',
  '--type', 'ci.coverage.dropped',
  '--data', '{"repo":"Dimo","coverage":74.5}',
  '--offline',
]);
```
