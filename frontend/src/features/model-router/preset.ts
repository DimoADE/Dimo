import type {
  AgentModelProviderSaveRequest,
  DshProviderSaveRequest,
  OpenCodeProviderConnectRequest,
} from 'shared/types';

import type { RouterProvision } from './account';

/**
 * Agents whose provider settings offer ModelRouter. Kept in step with the
 * site's ROUTER_AGENTS / MARKET_AGENTS: the site offers one-click setup for
 * agents listed here, and the desktop offers the entry where it can write a
 * working preset.
 */
export const MODEL_ROUTER_AGENTS = [
  'claude_code',
  'codex',
  'gemini',
  'antigravity',
  'kimi_code',
  'deepseek_harness',
  'grok',
  'zcode',
  'qoder',
  'opencode',
  'pi',
  'omp',
  'cline',
  'openclaw',
  'hermes',
  'codebuddy',
  'trae',
  'auggie',
  'command_code',
  'mimo_code',
] as const;

export function supportsModelRouter(agentId: string) {
  return (MODEL_ROUTER_AGENTS as readonly string[]).includes(agentId);
}

/** One preset per agent: provisioning again updates it instead of piling up copies. */
export const ROUTER_PROVIDER_NAME = 'Dimo ModelRouter';
export const ROUTER_OPENCODE_PROVIDER_ID = 'dimo-modelrouter';

const DSH_PROVIDER_ID_BASE_MAX_LEN = 56;

export function routerProviderBaseName(
  provision: Pick<RouterProvision, 'group' | 'groups'>
): string {
  const rawGroup = provision.group?.trim();
  if (rawGroup && rawGroup.toLowerCase() !== 'auto') {
    return rawGroup;
  }
  const resolvedGroups = (provision.groups ?? [])
    .map((item) => item.trim())
    .filter((item) => item.length > 0 && item.toLowerCase() !== 'auto');
  if (resolvedGroups.length > 0) {
    return resolvedGroups.join('+');
  }
  if (rawGroup) {
    return rawGroup;
  }
  return ROUTER_PROVIDER_NAME;
}

export function nextUniqueRouterProviderName(
  baseName: string,
  existingNames: Iterable<string> = []
): string {
  const taken = new Set(
    Array.from(existingNames, (name) => name.trim().toLowerCase()).filter(
      Boolean
    )
  );
  const trimmed = baseName.trim() || ROUTER_PROVIDER_NAME;
  if (!taken.has(trimmed.toLowerCase())) {
    return trimmed;
  }
  let suffix = 1;
  while (taken.has(`${trimmed}_${suffix}`.toLowerCase())) {
    suffix += 1;
  }
  return `${trimmed}_${suffix}`;
}

export function resolveRouterProviderName(
  provision: Pick<RouterProvision, 'group' | 'groups'>,
  existingNames: Iterable<string> = []
): string {
  return nextUniqueRouterProviderName(
    routerProviderBaseName(provision),
    existingNames
  );
}

export function nextUniqueOpenCodeProviderId(
  providerName: string,
  existingIds: Iterable<string> = []
): string {
  const taken = new Set(
    Array.from(existingIds, (id) => id.trim().toLowerCase()).filter(Boolean)
  );
  const raw = providerName
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[^a-z0-9]+/, '')
    .replace(/[-._]+$/, '');
  const base =
    raw && /[a-z]/.test(raw) && /^[a-z0-9][a-z0-9._-]*$/.test(raw)
      ? raw
      : raw && /^[0-9][a-z0-9._-]*$/.test(raw)
        ? `dimo-${raw}`
        : ROUTER_OPENCODE_PROVIDER_ID;
  if (!taken.has(base)) {
    return base;
  }
  let suffix = 1;
  while (taken.has(`${base}_${suffix}`)) {
    suffix += 1;
  }
  return `${base}_${suffix}`;
}

export function nextUniqueDshProviderId(
  providerName: string,
  existingIds: Iterable<string> = []
): string {
  const taken = new Set(
    Array.from(existingIds, (id) => id.trim().toLowerCase()).filter(Boolean)
  );
  const raw = providerName
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
  const prefixed = !raw
    ? ROUTER_OPENCODE_PROVIDER_ID
    : /^[a-z]/.test(raw)
      ? raw
      : `dimo-${raw}`;
  const base =
    prefixed.slice(0, DSH_PROVIDER_ID_BASE_MAX_LEN).replace(/-+$/, '') ||
    ROUTER_OPENCODE_PROVIDER_ID;
  if (!taken.has(base)) {
    return base;
  }
  let suffix = 1;
  while (taken.has(`${base}-${suffix}`)) {
    suffix += 1;
  }
  return `${base}-${suffix}`;
}

/**
 * Public model gateway. Matches the site `baseUrlForAgentImport` contract:
 * Claude Code, Gemini CLI, and Antigravity use the root because those clients
 * append their own version path. OpenAI-compatible clients need `/v1`.
 */
export const MODEL_GATEWAY_ORIGIN = 'https://model.dimo-ai.com';
const LEGACY_MODEL_HOST = 'model.xforever.xin';
const MODEL_GATEWAY_HOST = 'model.dimo-ai.com';
const MODEL_GATEWAY_ROOT_AGENTS = new Set([
  'claude_code',
  'gemini',
  'antigravity',
]);

function isOfficialModelGateway(url: URL): boolean {
  if (url.username || url.password) return false;
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return false;
  if (url.port && url.port !== '443') return false;
  const host = url.hostname.toLowerCase();
  if (host === LEGACY_MODEL_HOST || host === MODEL_GATEWAY_HOST) return true;
  const path = url.pathname.replace(/\/+$/, '') || '/';
  const siteRouter = path === '/api/router' || path.startsWith('/api/router/');
  return (
    siteRouter &&
    (host === 'vibex.xforever.xin' ||
      host === 'dimo-ai.com' ||
      host === 'www.dimo-ai.com')
  );
}

/**
 * Rewrites only the official model gateway onto the current host and the path
 * that agent's client expects. Any other URL, including a provider the user
 * typed, is returned unchanged.
 */
export function officialModelBaseUrl(agentId: string, issued: string): string {
  const trimmed = issued.trim();
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return trimmed;
  }
  if (!isOfficialModelGateway(url)) return trimmed;
  return MODEL_GATEWAY_ROOT_AGENTS.has(agentId)
    ? MODEL_GATEWAY_ORIGIN
    : `${MODEL_GATEWAY_ORIGIN}/v1`;
}

function withOpenAiVersion(base: string): string {
  const trimmed = base.replace(/\/+$/, '');
  return trimmed.endsWith('/v1') ? trimmed : `${trimmed}/v1`;
}

/** The chosen model first, then the rest the key can reach. */
function orderedModels(provision: RouterProvision) {
  return [
    provision.model,
    ...provision.models.filter((model) => model.id !== provision.model.id),
  ];
}

/**
 * The `model` field is agent-specific: most agents take a bare model id, Pi /
 * OMP / OpenClaw and Grok take a JSON spec that also names the wire protocol
 * or model list.
 */
function modelField(provision: RouterProvision) {
  const ids = orderedModels(provision).map((model) => model.id);
  if (provision.agentId === 'pi' || provision.agentId === 'omp') {
    return JSON.stringify({
      id: provision.model.id,
      api:
        provision.protocol === 'anthropic'
          ? 'anthropic-messages'
          : 'openai-completions',
      models: ids,
    });
  }
  if (provision.agentId === 'openclaw') {
    return JSON.stringify({
      id: provision.model.id,
      models: ids,
    });
  }
  if (provision.agentId === 'grok') {
    return JSON.stringify({
      id: provision.model.id,
      api_backend: 'responses',
      context_window: null,
      models: ids,
    });
  }
  return provision.model.id;
}

export function providerSaveRequest(
  provision: RouterProvision,
  existingId: string | null,
  providerName?: string
): AgentModelProviderSaveRequest {
  const name = providerName?.trim() || routerProviderBaseName(provision);
  return {
    id: existingId,
    name,
    agent_id: provision.agentId,
    api_url: officialModelBaseUrl(provision.agentId, provision.baseUrl),
    api_key: provision.apiKey,
    model: modelField(provision),
  };
}

export function openCodeConnectRequest(
  provision: RouterProvision,
  enabled = true,
  identity?: { providerId?: string; name?: string }
): OpenCodeProviderConnectRequest {
  const anthropic = provision.protocol === 'anthropic';
  const issued = officialModelBaseUrl(provision.agentId, provision.baseUrl);
  const name = identity?.name?.trim() || routerProviderBaseName(provision);
  const providerId =
    identity?.providerId?.trim() || nextUniqueOpenCodeProviderId(name);
  return {
    provider_id: providerId,
    name,
    npm: anthropic ? '@ai-sdk/anthropic' : '@ai-sdk/openai-compatible',
    api: null,
    // The Anthropic SDK package expects the versioned root. Claude Code keeps
    // the unversioned gateway root and appends /v1 itself.
    base_url: anthropic ? withOpenAiVersion(issued) : issued,
    api_key: provision.apiKey,
    models: orderedModels(provision).map((model) => ({
      id: model.id,
      name: model.name,
    })),
    enabled,
  };
}

export function dshProviderSaveRequest(
  provision: RouterProvision,
  setDefault = true,
  identity?: { id?: string; displayName?: string }
): DshProviderSaveRequest {
  const displayName =
    identity?.displayName?.trim() || routerProviderBaseName(provision);
  const id = identity?.id?.trim() || nextUniqueDshProviderId(displayName);
  return {
    id,
    display_name: displayName,
    notes: null,
    api: 'openai-completions',
    base_url: officialModelBaseUrl(provision.agentId, provision.baseUrl),
    api_key: provision.apiKey,
    models: orderedModels(provision).map((model) => ({
      id: model.id,
      name: model.name,
    })),
    set_default: setDefault,
    default_model: provision.model.id,
  };
}
