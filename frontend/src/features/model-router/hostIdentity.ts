import { hostClientApi, webServiceApi } from '@/lib/api';
import { getBackendTransport } from '@/lib/backendTransport';

export type AccountHostKind = 'local' | 'ssh' | 'remote' | 'web';

export type CurrentHostIdentity = {
  hostId: string;
  hostName: string;
  kind: AccountHostKind;
  fingerprint?: string | null;
};

type WebHostHealth = {
  hostId: string | null;
  name: string | null;
  fingerprint: string | null;
};

const webHealthCache = new Map<string, WebHostHealth>();

/** Strip optional `host:` prefix and trim whitespace to get a bare host identifier. */
export function normalizeBareHostId(
  hostId: string | null | undefined
): string | null {
  const trimmed = typeof hostId === 'string' ? hostId.trim() : '';
  if (!trimmed) return null;
  const bare = trimmed.replace(/^host:/i, '').trim();
  return bare || null;
}

/** Compare two host IDs tolerating `host:` prefix differences and UUID casing. */
export function isSameHostId(
  left: string | null | undefined,
  right: string | null | undefined
): boolean {
  const a = normalizeBareHostId(left);
  const b = normalizeBareHostId(right);
  return Boolean(a && b && a.toLowerCase() === b.toLowerCase());
}

/**
 * Resolve the local desktop machine's display hostname, preferring the real OS
 * hostname from Rust (`webServiceApi.getStatus().host_name`) or Electron
 * (`window.dimoDesktop.hostname`), and falling back to `"Local Host"` only when
 * unavailable.
 */
export function resolveDesktopLocalHostname(
  statusHostName?: string | null
): string {
  const fromStatus =
    typeof statusHostName === 'string' ? statusHostName.trim() : '';
  if (fromStatus) return fromStatus;

  const fromBridge =
    typeof window !== 'undefined' &&
    typeof window.dimoDesktop?.hostname === 'string'
      ? window.dimoDesktop.hostname.trim()
      : '';
  if (fromBridge) return fromBridge;

  return 'Local Host';
}

function formatOriginLabel(origin: string): string {
  try {
    const parsed = new URL(origin);
    return parsed.host || origin;
  } catch {
    return origin;
  }
}

async function probeWebHostHealth(origin: string): Promise<WebHostHealth> {
  const cached = webHealthCache.get(origin);
  if (cached) return cached;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 1_500);
  try {
    const response = await fetch(`${origin.replace(/\/+$/, '')}/health`, {
      method: 'GET',
      signal: controller.signal,
    });
    if (!response.ok) {
      const fallback: WebHostHealth = {
        hostId: null,
        name: null,
        fingerprint: null,
      };
      webHealthCache.set(origin, fallback);
      return fallback;
    }
    const payload = (await response.json().catch(() => null)) as {
      host_id?: unknown;
      name?: unknown;
      fingerprint?: unknown;
    } | null;
    const resolved: WebHostHealth = {
      hostId:
        typeof payload?.host_id === 'string' && payload.host_id.trim()
          ? payload.host_id.trim()
          : null,
      name:
        typeof payload?.name === 'string' && payload.name.trim()
          ? payload.name.trim()
          : null,
      fingerprint:
        typeof payload?.fingerprint === 'string' && payload.fingerprint.trim()
          ? payload.fingerprint.trim()
          : null,
    };
    webHealthCache.set(origin, resolved);
    return resolved;
  } catch {
    return { hostId: null, name: null, fingerprint: null };
  } finally {
    clearTimeout(timeout);
  }
}

export async function resolveCurrentHostIdentity(): Promise<CurrentHostIdentity> {
  const transport = getBackendTransport();
  if (transport.environment === 'desktop') {
    const status = await webServiceApi.getStatus().catch(() => null);
    const bareHostId = normalizeBareHostId(status?.host_id);
    const hostId = bareHostId ? `host:${bareHostId}` : 'host:local-desktop';
    return {
      hostId,
      hostName: resolveDesktopLocalHostname(status?.host_name),
      kind: 'local',
      fingerprint: status?.machine_fingerprint?.trim() || null,
    };
  }

  if (transport.environment === 'remote-desktop') {
    const status = await hostClientApi.status().catch(() => null);
    const profile = status?.profile;
    const bareHostId = normalizeBareHostId(profile?.host_id);
    const hostId = bareHostId
      ? `host:${bareHostId}`
      : profile?.id?.trim()
        ? `profile:${profile.id.trim()}`
        : profile?.origin?.trim()
          ? `origin:${profile.origin.trim()}`
          : 'host:remote-desktop';
    const hostName =
      profile?.name?.trim() ||
      (profile?.origin ? formatOriginLabel(profile.origin) : 'Remote Host');
    const kind: AccountHostKind =
      profile?.provision_kind === 'ssh' ? 'ssh' : 'remote';
    return { hostId, hostName, kind, fingerprint: null };
  }

  const origin =
    (transport as { origin?: string }).origin?.trim() ||
    (typeof window !== 'undefined' ? window.location.origin : '');
  const health = origin
    ? await probeWebHostHealth(origin)
    : { hostId: null, name: null, fingerprint: null };
  const bareHostId = normalizeBareHostId(health.hostId);
  const hostId = bareHostId
    ? `host:${bareHostId}`
    : `web:${origin || 'default'}`;
  const isLoopback =
    /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/i.test(origin);
  const hostName =
    health.name ||
    (isLoopback ? 'Local Host' : formatOriginLabel(origin || 'Web Host'));
  return {
    hostId,
    hostName,
    kind: isLoopback ? 'local' : 'web',
    fingerprint: health.fingerprint,
  };
}

/**
 * Resolve the current client's `hostId` for web-handoff without triggering an
 * uncached `/health` HTTP probe in browser-only environments.
 */
export async function resolveCurrentHostIdForHandoff(): Promise<string | null> {
  const transport = getBackendTransport();
  if (
    transport.environment === 'desktop' ||
    transport.environment === 'remote-desktop'
  ) {
    const identity = await resolveCurrentHostIdentity().catch(() => null);
    const hostId = identity?.hostId?.trim();
    if (
      !hostId ||
      hostId === 'host:local-desktop' ||
      hostId === 'host:remote-desktop'
    ) {
      return null;
    }
    return hostId;
  }

  const origin =
    (transport as { origin?: string }).origin?.trim() ||
    (typeof window !== 'undefined' ? window.location.origin : '');
  const cached = origin ? webHealthCache.get(origin) : undefined;
  return cached?.hostId ? `host:${cached.hostId}` : null;
}

export function resetHostIdentityCacheForTests(): void {
  webHealthCache.clear();
}
