/**
 * Multi-endpoint Happy Eyeballs selector, full `dimo-pairing:` parser,
 * HTTPS Mixed Content filter, and relay pairing beacon lookup.
 */

import { isLoopbackOrigin, isRelayOrigin } from './webE2ee';

export interface ReachabilityEndpoint {
  origin: string;
  kind?: string;
}

export interface ParsedPairingInvitation {
  hostId?: string;
  preset?: string;
  pairingId?: string;
  pairingToken: string;
  expiresAt?: string;
  endpoints: ReachabilityEndpoint[];
}

export interface ProbedEndpoint {
  origin: string;
  hostId?: string;
  name?: string;
  version?: string;
  latencyMs: number;
}

const PAIRING_CODE_PATTERN = /^[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{8}$/;

export function normalizeRemoteOrigin(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return '';
  if (!trimmed.includes('://')) {
    return `http://${trimmed.replace(/\/+$/, '')}`;
  }
  return trimmed.replace(/\/+$/, '');
}

export function parsePairingInvitation(
  input: string
): ParsedPairingInvitation | null {
  const raw = input.trim();
  if (!raw) return null;

  if (raw.startsWith('dimo-pairing:')) {
    try {
      const payload = JSON.parse(raw.slice('dimo-pairing:'.length)) as {
        host_id?: unknown;
        preset?: unknown;
        pairing_id?: unknown;
        pairing_token?: unknown;
        expires_at?: unknown;
        reachability?: unknown;
      };
      if (
        typeof payload.pairing_token !== 'string' ||
        !payload.pairing_token.trim()
      ) {
        return null;
      }
      const pairingToken = payload.pairing_token
        .trim()
        .replace(/[\s-]+/g, '')
        .toUpperCase();
      const endpoints: ReachabilityEndpoint[] = [];
      if (Array.isArray(payload.reachability)) {
        for (const entry of payload.reachability) {
          if (
            entry &&
            typeof entry === 'object' &&
            typeof (entry as { origin?: unknown }).origin === 'string'
          ) {
            const origin = normalizeRemoteOrigin(
              (entry as { origin: string }).origin
            );
            if (!origin) continue;
            const kind =
              typeof (entry as { kind?: unknown }).kind === 'string'
                ? (entry as { kind: string }).kind
                : undefined;
            if (!endpoints.some((e) => e.origin === origin)) {
              endpoints.push({ origin, kind });
            }
          }
        }
      }
      return {
        hostId:
          typeof payload.host_id === 'string' && payload.host_id.trim()
            ? payload.host_id.trim()
            : undefined,
        preset:
          typeof payload.preset === 'string' && payload.preset.trim()
            ? payload.preset.trim()
            : undefined,
        pairingId:
          typeof payload.pairing_id === 'string' && payload.pairing_id.trim()
            ? payload.pairing_id.trim()
            : undefined,
        pairingToken,
        expiresAt:
          typeof payload.expires_at === 'string' && payload.expires_at.trim()
            ? payload.expires_at.trim()
            : undefined,
        endpoints,
      };
    } catch {
      return null;
    }
  }

  const canonical = raw.replace(/[\s-]+/g, '').toUpperCase();
  if (PAIRING_CODE_PATTERN.test(canonical)) {
    return { pairingToken: canonical, endpoints: [] };
  }
  return null;
}

/**
 * Browsers block `http://` fetches from an `https://` page (Mixed Content)
 * except for loopback addresses. Drop blocked endpoints before probing so
 * HTTPS WebUI cleanly prefers custom HTTPS origins and relays.
 */
export function filterReachableEndpointsForPage(
  endpoints: ReachabilityEndpoint[],
  pageProtocol: string = typeof window !== 'undefined'
    ? window.location.protocol
    : 'http:'
): ReachabilityEndpoint[] {
  const isHttpsPage = pageProtocol === 'https:';
  const seen = new Set<string>();
  const filtered: ReachabilityEndpoint[] = [];
  for (const item of endpoints) {
    const origin = normalizeRemoteOrigin(item.origin);
    if (!origin || seen.has(origin)) continue;
    if (
      isHttpsPage &&
      origin.toLowerCase().startsWith('http://') &&
      !isLoopbackOrigin(origin)
    ) {
      continue;
    }
    seen.add(origin);
    filtered.push({ origin, kind: item.kind });
  }
  return filtered;
}

/**
 * Staggered Happy Eyeballs priority tier:
 * - Tier 0 (0ms): last-known-good origin, loopback, or LAN
 * - Tier 1 (250ms): custom_public, public, custom_relay, or tunnel
 * - Tier 2 (500ms): official_relay or generic /t/ relay
 */
export function endpointPriorityTier(
  endpoint: ReachabilityEndpoint,
  lastGoodOrigin?: string | null
): 0 | 1 | 2 {
  const origin = normalizeRemoteOrigin(endpoint.origin);
  if (lastGoodOrigin && normalizeRemoteOrigin(lastGoodOrigin) === origin) {
    return 0;
  }
  const kind = endpoint.kind?.toLowerCase();
  if (kind === 'lan' || isLoopbackOrigin(origin)) {
    return 0;
  }
  if (
    kind === 'custom_public' ||
    kind === 'public' ||
    kind === 'custom_relay' ||
    kind === 'tunnel'
  ) {
    return 1;
  }
  if (kind === 'official_relay' || isRelayOrigin(origin)) {
    return 2;
  }
  return 1;
}

const TIER_DELAY_MS: Record<0 | 1 | 2, number> = {
  0: 0,
  1: 250,
  2: 500,
};

export async function probeHostHealth(
  origin: string,
  options?: {
    expectedHostId?: string | null;
    timeoutMs?: number;
    signal?: AbortSignal;
    fetchImpl?: typeof fetch;
  }
): Promise<ProbedEndpoint> {
  const cleanOrigin = normalizeRemoteOrigin(origin);
  const fetchFn = options?.fetchImpl ?? globalThis.fetch.bind(globalThis);
  const timeoutMs = options?.timeoutMs ?? 4_000;
  const controller = new AbortController();
  const onExternalAbort = () => controller.abort();
  if (options?.signal?.aborted) {
    controller.abort();
  } else {
    options?.signal?.addEventListener('abort', onExternalAbort, { once: true });
  }
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const startedAt =
    typeof performance !== 'undefined' ? performance.now() : Date.now();
  try {
    const response = await fetchFn(`${cleanOrigin}/health`, {
      method: 'GET',
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    const body = (await response.json()) as {
      status?: unknown;
      ok?: unknown;
      host_id?: unknown;
      name?: unknown;
      version?: unknown;
    };
    const isOk = body?.status === 'ok' || body?.ok === true;
    if (!isOk) {
      throw new Error('Not a healthy Dimo Host');
    }
    const hostId =
      typeof body.host_id === 'string' && body.host_id.trim()
        ? body.host_id.trim()
        : undefined;
    if (
      options?.expectedHostId &&
      hostId &&
      hostId !== options.expectedHostId.trim()
    ) {
      throw new Error('Host ID mismatch');
    }
    const elapsed =
      (typeof performance !== 'undefined' ? performance.now() : Date.now()) -
      startedAt;
    return {
      origin: cleanOrigin,
      hostId,
      name:
        typeof body.name === 'string' && body.name.trim()
          ? body.name.trim()
          : undefined,
      version:
        typeof body.version === 'string' && body.version.trim()
          ? body.version.trim()
          : undefined,
      latencyMs: Math.max(1, Math.round(elapsed)),
    };
  } finally {
    clearTimeout(timer);
    options?.signal?.removeEventListener('abort', onExternalAbort);
  }
}

export async function selectBestEndpoint(
  endpoints: ReachabilityEndpoint[],
  options?: {
    expectedHostId?: string | null;
    lastGoodOrigin?: string | null;
    pageProtocol?: string;
    timeoutMs?: number;
    fetchImpl?: typeof fetch;
  }
): Promise<ProbedEndpoint> {
  const candidates = filterReachableEndpointsForPage(
    endpoints,
    options?.pageProtocol
  );
  if (candidates.length === 0) {
    throw new Error('No reachable endpoints available for this Host');
  }
  if (candidates.length === 1) {
    return probeHostHealth(candidates[0]!.origin, {
      expectedHostId: options?.expectedHostId,
      timeoutMs: options?.timeoutMs,
      fetchImpl: options?.fetchImpl,
    });
  }

  // Shift tier delays so the lowest available tier starts immediately at 0ms.
  const tiered = candidates.map((ep) => ({
    endpoint: ep,
    tier: endpointPriorityTier(ep, options?.lastGoodOrigin),
  }));
  const minTier = Math.min(...tiered.map((t) => t.tier)) as 0 | 1 | 2;
  const baseDelay = TIER_DELAY_MS[minTier];

  const raceController = new AbortController();
  return new Promise<ProbedEndpoint>((resolve, reject) => {
    let remaining = tiered.length;
    let settled = false;
    const errors: string[] = [];
    const timers: Array<ReturnType<typeof setTimeout>> = [];

    const finishSuccess = (winner: ProbedEndpoint) => {
      if (settled) return;
      settled = true;
      for (const timer of timers) clearTimeout(timer);
      raceController.abort();
      resolve(winner);
    };

    const recordFailure = (origin: string, err: unknown) => {
      if (settled) return;
      const msg = err instanceof Error ? err.message : String(err);
      errors.push(`${origin}: ${msg}`);
      remaining -= 1;
      if (remaining <= 0) {
        settled = true;
        for (const timer of timers) clearTimeout(timer);
        reject(
          new Error(
            `Could not reach Host via any endpoint (${errors[0] ?? 'failed'})`
          )
        );
      }
    };

    for (const { endpoint, tier } of tiered) {
      const delayMs = Math.max(0, TIER_DELAY_MS[tier] - baseDelay);
      const launch = () => {
        if (settled) return;
        void probeHostHealth(endpoint.origin, {
          expectedHostId: options?.expectedHostId,
          timeoutMs: options?.timeoutMs ?? 4_500,
          signal: raceController.signal,
          fetchImpl: options?.fetchImpl,
        })
          .then(finishSuccess)
          .catch((err) => recordFailure(endpoint.origin, err));
      };
      if (delayMs === 0) {
        launch();
      } else {
        timers.push(setTimeout(launch, delayMs));
      }
    }
  });
}

export async function lookupRelayBeacon(
  relayOrigin: string,
  pairingCode: string,
  options?: { fetchImpl?: typeof fetch; signal?: AbortSignal }
): Promise<{ hostId: string; origin: string }> {
  const canonical = pairingCode
    .trim()
    .replace(/[\s-]+/g, '')
    .toUpperCase();
  if (!canonical) {
    throw new Error('Pairing code is required');
  }
  const digest = await globalThis.crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(`vibex-pair-code-v1:${canonical}`)
  );
  const hex = Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
    .slice(0, 32);
  const topic = `vbx-p-${hex}`;
  const cleanRelay = normalizeRemoteOrigin(relayOrigin);
  let beaconBase = cleanRelay;
  try {
    beaconBase = new URL(cleanRelay).origin;
  } catch {
    // Fallback to normalized origin if URL parsing fails.
  }
  const fetchFn = options?.fetchImpl ?? globalThis.fetch.bind(globalThis);
  const response = await fetchFn(
    `${beaconBase}/v1/beacon/${encodeURIComponent(topic)}`,
    {
      method: 'GET',
      signal: options?.signal,
    }
  );
  if (!response.ok) {
    throw new Error(`Relay beacon lookup failed (HTTP ${response.status})`);
  }
  const body = (await response.json()) as {
    host_id?: unknown;
    hostId?: unknown;
    origin?: unknown;
  };
  const hostId =
    typeof body.host_id === 'string'
      ? body.host_id.trim()
      : typeof body.hostId === 'string'
        ? body.hostId.trim()
        : '';
  const origin =
    typeof body.origin === 'string' ? normalizeRemoteOrigin(body.origin) : '';
  if (!origin) {
    throw new Error('Relay beacon payload missing origin');
  }
  return { hostId, origin };
}
