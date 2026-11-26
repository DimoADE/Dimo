/**
 * Unified Account Host Directory + Ed25519 HostAccessGrant exchange helpers
 * shared across Desktop and WebUI.
 */

import { accountApi, AccountError } from '@/features/model-router/account';
import {
  buildEncryptedRequestHeaders,
  decryptResponseBodyText,
  encryptRequestBody,
  handshakeWebE2ee,
  isRelayOrigin,
  shouldUseWebE2ee,
  type WebE2eeSession,
} from './webE2ee';
import {
  normalizeRemoteOrigin,
  type ReachabilityEndpoint,
} from './happyEyeballs';
import { extractHostGrantJti, signWebHostGrantPop } from './webHostStore';

export interface AccountDirectoryHost {
  hostId: string;
  hostName: string;
  osType?: string | null;
  osArch?: string | null;
  version?: string | null;
  online: boolean;
  lastSeenAt?: string | null;
  endpoints: ReachabilityEndpoint[];
}

export interface HostAccessGrantResult {
  grantToken: string;
  expiresAt: number;
  kid: string;
  hostId: string;
}

export async function listAccountDirectoryHosts(): Promise<
  AccountDirectoryHost[]
> {
  try {
    const response = await accountApi.listDirectoryHosts();
    const rawHosts = Array.isArray(response?.hosts) ? response.hosts : [];
    return rawHosts
      .filter(
        (item): item is Record<string, unknown> =>
          Boolean(item) && typeof item === 'object'
      )
      .map((item) => {
        const hostId =
          typeof item.hostId === 'string'
            ? item.hostId.trim()
            : typeof item.host_id === 'string'
              ? item.host_id.trim()
              : '';
        const hostName =
          typeof item.hostName === 'string' && item.hostName.trim()
            ? item.hostName.trim()
            : typeof item.host_name === 'string' && item.host_name.trim()
              ? item.host_name.trim()
              : hostId;
        const endpoints: ReachabilityEndpoint[] = [];
        const addEndpoint = (origin: unknown, kind?: string) => {
          if (typeof origin !== 'string' || !origin.trim()) return;
          const clean = normalizeRemoteOrigin(origin);
          if (!endpoints.some((e) => e.origin === clean)) {
            endpoints.push({ origin: clean, kind });
          }
        };
        if (Array.isArray(item.endpoints)) {
          for (const ep of item.endpoints) {
            if (ep && typeof ep === 'object') {
              const obj = ep as { origin?: unknown; kind?: unknown };
              addEndpoint(
                obj.origin,
                typeof obj.kind === 'string' ? obj.kind : undefined
              );
            }
          }
        }
        if (Array.isArray(item.customPublicOrigins)) {
          for (const origin of item.customPublicOrigins) {
            addEndpoint(origin, 'custom_public');
          }
        }
        if (Array.isArray(item.customRelayOrigins)) {
          for (const origin of item.customRelayOrigins) {
            addEndpoint(origin, 'custom_relay');
          }
        }
        if (typeof item.officialRelayOrigin === 'string') {
          addEndpoint(item.officialRelayOrigin, 'official_relay');
        }
        return {
          hostId,
          hostName,
          osType: typeof item.osType === 'string' ? item.osType : null,
          osArch: typeof item.osArch === 'string' ? item.osArch : null,
          version: typeof item.version === 'string' ? item.version : null,
          online: Boolean(item.online),
          lastSeenAt:
            typeof item.lastSeenAt === 'string' ? item.lastSeenAt : null,
          endpoints,
        };
      })
      .filter((item) => Boolean(item.hostId));
  } catch (error) {
    if (
      error instanceof AccountError &&
      (error.code === 'signed_out' ||
        error.code === 'unsupported' ||
        error.code === 'network')
    ) {
      return [];
    }
    return [];
  }
}

export async function requestHostAccessGrant(input: {
  hostId: string;
  clientPublicKeyEd25519: string;
  clientKind: 'desktop' | 'web' | 'mobile';
  preset?: 'workstation' | 'companion';
}): Promise<HostAccessGrantResult> {
  return accountApi.issueHostAccessGrant({
    hostId: input.hostId,
    clientPublicKeyEd25519: input.clientPublicKeyEd25519,
    clientKind: input.clientKind,
    preset: input.preset ?? 'workstation',
  });
}

export async function exchangeHostAccessGrantOverHttp(input: {
  origin: string;
  hostId: string;
  grantToken: string;
  deviceName: string;
  clientKind?: 'web' | 'desktop' | 'mobile';
  preset?: 'workstation' | 'companion';
  fetchImpl?: typeof fetch;
}): Promise<{ deviceId?: string; accessToken: string }> {
  const cleanOrigin = normalizeRemoteOrigin(input.origin);
  const jti = extractHostGrantJti(input.grantToken);
  const { clientPublicKeyEd25519, popSignature } = await signWebHostGrantPop(
    jti,
    input.hostId
  );

  const payload = {
    grant_token: input.grantToken.trim(),
    device_name: input.deviceName,
    client_kind: input.clientKind ?? 'web',
    preset: input.preset ?? 'workstation',
    client_public_key_ed25519: clientPublicKeyEd25519,
    pop_signature: popSignature,
  };

  const fetchFn = input.fetchImpl ?? globalThis.fetch.bind(globalThis);
  const url = `${cleanOrigin}/api/v1/auth/grant-exchange`;
  const plainJson = JSON.stringify(payload);
  let response: Response | null = null;
  let responseText = '';

  for (let attempt = 0; attempt < 2; attempt += 1) {
    let session: WebE2eeSession | null = null;
    if (shouldUseWebE2ee(cleanOrigin)) {
      try {
        session = await handshakeWebE2ee(cleanOrigin, { fetchImpl: fetchFn });
      } catch (err) {
        if (isRelayOrigin(cleanOrigin)) {
          throw new Error(
            `E2EE handshake required for relay Host: ${
              err instanceof Error ? err.message : String(err)
            }`
          );
        }
      }
    }

    if (session) {
      const encHeaders = await buildEncryptedRequestHeaders(session);
      const encBody = await encryptRequestBody(session, plainJson);
      response = await fetchFn(url, {
        method: 'POST',
        headers: {
          ...encHeaders,
          'x-dimo-protocol-version': '1.0',
        },
        body: encBody,
      });
    } else {
      response = await fetchFn(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-dimo-protocol-version': '1.0',
        },
        body: plainJson,
      });
    }

    if (response.status === 412 && session && attempt === 0) {
      continue;
    }

    responseText = session
      ? await decryptResponseBodyText(session, response)
      : await response.text();
    break;
  }

  if (!response) {
    throw new Error('Host grant exchange failed without response');
  }

  if (!response.ok) {
    let message = `Host rejected grant exchange (HTTP ${response.status})`;
    try {
      const parsed = JSON.parse(responseText) as { message?: string };
      if (parsed?.message) message = parsed.message;
    } catch {
      // Keep default error message.
    }
    throw new Error(message);
  }

  const credential = JSON.parse(responseText) as {
    device_id?: string;
    access_token?: string;
    device_token?: string;
  };
  const accessToken = credential.access_token ?? credential.device_token;
  if (!accessToken) {
    throw new Error('Host did not return a device credential');
  }
  return {
    deviceId: credential.device_id,
    accessToken,
  };
}
