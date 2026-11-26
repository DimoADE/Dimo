import {
  type ReactNode,
  type SyntheticEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  ExternalLink,
  Eye,
  EyeOff,
  Laptop,
  Loader2,
  LogIn,
  LogOut,
  RefreshCw,
  Trash2,
  User,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { Logo } from '@/components/Logo';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { toast } from '@/components/ui/toast';
import { resolveAccountDisplayName } from '@/features/model-router';
import { useDimoAccount } from '@/features/model-router/useDimoAccount';
import { useAccountDeviceLogin } from '@/pages/settings/useAccountDeviceLogin';
import {
  type AccountDirectoryHost,
  buildEncryptedRequestHeaders,
  decryptResponseBodyText,
  encryptRequestBody,
  exchangeHostAccessGrantOverHttp,
  getLastActiveWebHostId,
  getSavedWebHost,
  getWebClientPublicKeyEd25519,
  getWebRememberHosts,
  handshakeWebE2ee,
  isRelayOrigin,
  listAccountDirectoryHosts,
  listSavedWebHosts,
  parsePairingInvitation,
  type ReachabilityEndpoint,
  removeSavedWebHost,
  requestHostAccessGrant,
  type SavedWebHost,
  selectBestEndpoint,
  setLastActiveWebHostId,
  setWebRememberHosts,
  shouldUseWebE2ee,
  subscribeWebHostStore,
  upsertSavedWebHost,
  type WebE2eeSession,
} from '@/lib/connectivity';
import { BackendTransportProvider, WebTransport } from '@/lib/transport';
import { WebTransportError } from '@/lib/transport/webTransport';
import {
  defaultHostUrl,
  explicitHostUrl,
  looksLikeDimoHost,
} from '@/pages/settings/hostEndpoints';
import '@/styles/legacy/index.css';

const WEB_SESSION_STORAGE_KEY = 'dimo.web_session';
export const WEB_SESSION_DISCONNECT_EVENT = 'dimo:web-disconnect';
export const WEB_SESSION_SWITCH_HOST_EVENT = 'dimo:web-switch-host';

interface StoredWebSession {
  baseUrl: string;
  token: string;
  hostId?: string;
  trustSource?: 'paired' | 'account_linked';
}

export interface DirectWebSessionTarget {
  baseUrl: string;
  token: string;
  hostId?: string;
  name?: string;
  trustSource?: 'paired' | 'account_linked';
}

interface SwitchWebHostEventDetail {
  hostId?: string;
  session?: DirectWebSessionTarget;
}

function normalizeBaseUrl(url: string): string {
  return url.trim().replace(/\/+$/, '');
}

function readStoredWebSession(): StoredWebSession | null {
  try {
    const raw = window.sessionStorage.getItem(WEB_SESSION_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<StoredWebSession> | null;
    if (
      typeof parsed?.baseUrl === 'string' &&
      parsed.baseUrl.trim() &&
      typeof parsed?.token === 'string' &&
      parsed.token.trim()
    ) {
      return {
        baseUrl: normalizeBaseUrl(parsed.baseUrl),
        token: parsed.token.trim(),
        ...(typeof parsed.hostId === 'string' && parsed.hostId.trim()
          ? { hostId: parsed.hostId.trim() }
          : {}),
        ...(parsed.trustSource === 'paired' ||
        parsed.trustSource === 'account_linked'
          ? { trustSource: parsed.trustSource }
          : {}),
      };
    }
    window.sessionStorage.removeItem(WEB_SESSION_STORAGE_KEY);
  } catch {
    // Ignore storage access or JSON parse errors.
  }
  return null;
}

function writeStoredWebSession(session: StoredWebSession): void {
  try {
    const payload: StoredWebSession = {
      baseUrl: normalizeBaseUrl(session.baseUrl),
      token: session.token,
      ...(session.hostId ? { hostId: session.hostId } : {}),
      ...(session.trustSource ? { trustSource: session.trustSource } : {}),
    };
    window.sessionStorage.setItem(
      WEB_SESSION_STORAGE_KEY,
      JSON.stringify(payload)
    );
  } catch {
    // Ignore storage write errors in restricted browser contexts.
  }
}

function clearStoredWebSession(): void {
  try {
    window.sessionStorage.removeItem(WEB_SESSION_STORAGE_KEY);
  } catch {
    // Ignore storage errors.
  }
}

function getRestorableWebSession(): StoredWebSession | null {
  if (typeof window === 'undefined') return null;
  const stored = readStoredWebSession();
  if (!stored) return null;
  const explicit = explicitHostUrl(window.location.search);
  if (
    explicit &&
    normalizeBaseUrl(explicit) !== normalizeBaseUrl(stored.baseUrl)
  ) {
    return null;
  }
  return stored;
}

function isAuthFailure(error: unknown): boolean {
  if (error instanceof WebTransportError) {
    return (
      error.status === 401 ||
      error.status === 403 ||
      error.code === 'unauthorized' ||
      error.code === 'forbidden'
    );
  }
  return false;
}

export function getCurrentWebSessionHostId(): string | null {
  if (typeof window === 'undefined') return null;
  return readStoredWebSession()?.hostId ?? null;
}

export function disconnectWebSession(): void {
  clearStoredWebSession();
  void setLastActiveWebHostId(null);
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent(WEB_SESSION_DISCONNECT_EVENT));
  }
}

export function switchWebHost(hostId: string): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(
    new CustomEvent<SwitchWebHostEventDetail>(WEB_SESSION_SWITCH_HOST_EVENT, {
      detail: { hostId },
    })
  );
}

export function switchWebSession(session: DirectWebSessionTarget): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(
    new CustomEvent<SwitchWebHostEventDetail>(WEB_SESSION_SWITCH_HOST_EVENT, {
      detail: { session },
    })
  );
}

export function detectBrowserDeviceName(): string {
  const ua = typeof navigator !== 'undefined' ? navigator.userAgent : '';
  if (/Edg\//i.test(ua)) return 'Edge (Web)';
  if (/Chrome\//i.test(ua) && !/Edg\//i.test(ua)) return 'Chrome (Web)';
  if (/Safari\//i.test(ua) && !/Chrome\//i.test(ua)) return 'Safari (Web)';
  if (/Firefox\//i.test(ua)) return 'Firefox (Web)';
  return 'Dimo Web';
}

function defaultHostNameFromOrigin(origin: string): string {
  try {
    const parsed = new URL(origin);
    return parsed.host || origin;
  } catch {
    return origin;
  }
}

export async function redeemWebPairingToken(
  host: string,
  pairingCode: string,
  fallbackError: string,
  formatE2eeError?: (reason: string) => string
): Promise<{ accessToken: string; deviceId?: string }> {
  const cleanHost = normalizeBaseUrl(host);
  const useE2ee = shouldUseWebE2ee(cleanHost);
  const plainBody = JSON.stringify({
    pairing_token: pairingCode,
    device_name: detectBrowserDeviceName(),
  });
  const url = `${cleanHost}/api/v1/auth/pairings/redeem`;

  for (let attempt = 0; attempt < 2; attempt++) {
    let e2eeSession: WebE2eeSession | null = null;
    if (useE2ee) {
      try {
        e2eeSession = await handshakeWebE2ee(cleanHost);
      } catch (err) {
        if (isRelayOrigin(cleanHost)) {
          const reason = err instanceof Error ? err.message : String(err);
          throw new Error(
            formatE2eeError
              ? formatE2eeError(reason)
              : `E2EE handshake required for relay Host: ${reason}`
          );
        }
      }
    }

    const response = e2eeSession
      ? await fetch(url, {
          method: 'POST',
          headers: {
            ...(await buildEncryptedRequestHeaders(e2eeSession)),
            'x-dimo-protocol-version': '1.0',
          },
          body: await encryptRequestBody(e2eeSession, plainBody),
        })
      : await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-dimo-protocol-version': '1.0',
          },
          body: plainBody,
        });

    if (e2eeSession && response.status === 412 && attempt === 0) {
      continue;
    }

    if (e2eeSession) {
      const decryptedText = await decryptResponseBodyText(
        e2eeSession,
        response
      );
      if (!response.ok) {
        let message = fallbackError;
        try {
          const payload = JSON.parse(decryptedText) as { message?: string };
          if (payload?.message) message = payload.message;
        } catch {
          // Keep fallback error.
        }
        throw new Error(message);
      }
      const credential = JSON.parse(decryptedText) as {
        device_id?: string;
        access_token?: string;
        device_token?: string;
      };
      const issuedToken = credential?.access_token ?? credential?.device_token;
      if (!issuedToken) {
        throw new Error(fallbackError);
      }
      return { accessToken: issuedToken, deviceId: credential.device_id };
    }

    if (!response.ok) {
      const payload = (await response.json().catch(() => null)) as {
        message?: string;
      } | null;
      throw new Error(payload?.message || fallbackError);
    }
    const credential = (await response.json()) as {
      device_id?: string;
      access_token?: string;
      device_token?: string;
    };
    const issuedToken = credential?.access_token ?? credential?.device_token;
    if (!issuedToken) {
      throw new Error(fallbackError);
    }
    return { accessToken: issuedToken, deviceId: credential.device_id };
  }

  throw new Error(fallbackError);
}

export function WebTransportBootstrap({ children }: { children: ReactNode }) {
  const { t } = useTranslation('app');
  const tRef = useRef(t);
  tRef.current = t;
  const {
    isSignedIn,
    user,
    refresh: refreshAccount,
    signOut: signOutAccount,
  } = useDimoAccount();
  const accountLogin = useAccountDeviceLogin({
    isSignedIn,
    refresh: refreshAccount,
  });
  const [initialSession] = useState<StoredWebSession | null>(() =>
    getRestorableWebSession()
  );
  const [baseUrl, setBaseUrl] = useState(
    () =>
      initialSession?.baseUrl ??
      defaultHostUrl(window.location.origin, window.location.search)
  );
  const [token, setToken] = useState('');
  const [tokenRevealed, setTokenRevealed] = useState(true);
  const [rememberHosts, setRememberHosts] = useState<boolean>(() =>
    getWebRememberHosts()
  );
  const [savedHosts, setSavedHosts] = useState<SavedWebHost[]>([]);
  const [accountHosts, setAccountHosts] = useState<AccountDirectoryHost[]>([]);
  const [accountHostsLoading, setAccountHostsLoading] = useState(false);
  const [busyHostId, setBusyHostId] = useState<string | null>(null);
  const [transport, setTransport] = useState<WebTransport | null>(null);
  const transportRef = useRef<WebTransport | null>(null);
  transportRef.current = transport;
  const [error, setError] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [restoring, setRestoring] = useState(() => Boolean(initialSession));

  const parsedFromToken = useMemo(() => parsePairingInvitation(token), [token]);
  const parsedFromBaseUrl = useMemo(
    () => parsePairingInvitation(baseUrl),
    [baseUrl]
  );
  const parsedInvitation = parsedFromToken ?? parsedFromBaseUrl;

  const hostDiffers = useMemo(() => {
    if (parsedFromBaseUrl) return false;
    try {
      return (
        Boolean(baseUrl) && new URL(baseUrl).origin !== window.location.origin
      );
    } catch {
      return false;
    }
  }, [baseUrl, parsedFromBaseUrl]);

  const refreshSavedHosts = useCallback(async () => {
    const hosts = await listSavedWebHosts();
    setSavedHosts(hosts);
    return hosts;
  }, []);

  useEffect(() => {
    void refreshSavedHosts();
    return subscribeWebHostStore(() => {
      setRememberHosts(getWebRememberHosts());
      void refreshSavedHosts();
    });
  }, [refreshSavedHosts]);

  const refreshAccountHosts = useCallback(async () => {
    if (!isSignedIn || transportRef.current) {
      setAccountHosts([]);
      return;
    }
    setAccountHostsLoading(true);
    try {
      const hosts = await listAccountDirectoryHosts();
      if (!transportRef.current) {
        setAccountHosts(hosts);
      }
    } finally {
      setAccountHostsLoading(false);
    }
  }, [isSignedIn]);

  useEffect(() => {
    if (!isSignedIn || transport) {
      setAccountHosts([]);
      return;
    }
    void refreshAccountHosts();
  }, [isSignedIn, refreshAccountHosts, transport]);

  const createTransport = useCallback((host: string, resolvedToken: string) => {
    const candidate = new WebTransport({
      baseUrl: host,
      token: resolvedToken,
      onAuthError: (authError) => {
        clearStoredWebSession();
        void setLastActiveWebHostId(null);
        candidate.destroy();
        setTransport((current) => (current === candidate ? null : current));
        setError(authError.message || tRef.current('webConnect.authFailed'));
      },
    });
    return candidate;
  }, []);

  const connectSavedHost = useCallback(
    async (saved: SavedWebHost) => {
      setBusyHostId(saved.id);
      setError(null);
      try {
        let selectedOrigin = saved.lastGoodOrigin || saved.origin;
        if (saved.endpoints.length > 1) {
          const probed = await selectBestEndpoint(saved.endpoints, {
            expectedHostId: saved.hostId,
            lastGoodOrigin: saved.lastGoodOrigin,
          });
          if (probed) {
            selectedOrigin = probed.origin;
          }
        }
        const candidate = createTransport(selectedOrigin, saved.accessToken);
        try {
          await candidate.capabilities();
        } catch (err) {
          candidate.destroy();
          if (isAuthFailure(err)) {
            await removeSavedWebHost(saved.id);
            clearStoredWebSession();
          }
          throw err;
        }
        writeStoredWebSession({
          baseUrl: selectedOrigin,
          token: saved.accessToken,
          hostId: saved.hostId ?? saved.id,
          trustSource: saved.trustSource,
        });
        if (getWebRememberHosts()) {
          await upsertSavedWebHost({
            ...saved,
            origin: selectedOrigin,
            lastGoodOrigin: selectedOrigin,
            lastConnectedAt: new Date().toISOString(),
          });
          await setLastActiveWebHostId(saved.id);
        }
        setTransport((current) => {
          if (current && current !== candidate) current.destroy();
          return candidate;
        });
      } catch (nextError) {
        const reason =
          nextError instanceof Error && nextError.message
            ? nextError.message
            : tRef.current('webConnect.authFailed');
        if (transportRef.current) {
          toast.error(
            tRef.current('webConnect.switchHostFailed', {
              name: saved.name,
              reason,
            })
          );
        } else {
          setError(reason);
        }
      } finally {
        setBusyHostId(null);
      }
    },
    [createTransport]
  );

  const connectDirectSession = useCallback(
    async (target: DirectWebSessionTarget) => {
      const normalizedOrigin = normalizeBaseUrl(target.baseUrl);
      const displayName =
        target.name || defaultHostNameFromOrigin(normalizedOrigin);
      setBusyHostId(target.hostId || normalizedOrigin);
      setError(null);
      try {
        const candidate = createTransport(normalizedOrigin, target.token);
        try {
          await candidate.capabilities();
        } catch (err) {
          candidate.destroy();
          throw err;
        }
        writeStoredWebSession({
          baseUrl: normalizedOrigin,
          token: target.token,
          hostId: target.hostId,
          trustSource: target.trustSource,
        });
        setTransport((current) => {
          if (current && current !== candidate) current.destroy();
          return candidate;
        });
      } catch (nextError) {
        const reason =
          nextError instanceof Error && nextError.message
            ? nextError.message
            : tRef.current('webConnect.authFailed');
        if (transportRef.current) {
          toast.error(
            tRef.current('webConnect.switchHostFailed', {
              name: displayName,
              reason,
            })
          );
        } else {
          setError(reason);
        }
      } finally {
        setBusyHostId(null);
      }
    },
    [createTransport]
  );

  const connectAccountHost = useCallback(
    async (host: AccountDirectoryHost) => {
      setBusyHostId(host.hostId);
      setError(null);
      try {
        if (host.endpoints.length === 0) {
          throw new Error(tRef.current('webConnect.noReachableEndpoints'));
        }
        const probed = await selectBestEndpoint(host.endpoints, {
          expectedHostId: host.hostId,
        });
        if (!probed) {
          throw new Error(tRef.current('webConnect.endpointUnreachable'));
        }
        const clientPublicKeyEd25519 = await getWebClientPublicKeyEd25519();
        const grant = await requestHostAccessGrant({
          hostId: host.hostId,
          clientPublicKeyEd25519,
          clientKind: 'web',
          preset: 'workstation',
        });
        const credential = await exchangeHostAccessGrantOverHttp({
          origin: probed.origin,
          hostId: host.hostId,
          grantToken: grant.grantToken,
          deviceName: detectBrowserDeviceName(),
          clientKind: 'web',
          preset: 'workstation',
        });
        const candidate = createTransport(
          probed.origin,
          credential.accessToken
        );
        try {
          await candidate.capabilities();
        } catch (err) {
          candidate.destroy();
          throw err;
        }
        writeStoredWebSession({
          baseUrl: probed.origin,
          token: credential.accessToken,
          hostId: host.hostId,
          trustSource: 'account_linked',
        });
        if (getWebRememberHosts()) {
          const saved = await upsertSavedWebHost({
            id: host.hostId,
            hostId: host.hostId,
            name: host.hostName || probed.name || host.hostId,
            origin: probed.origin,
            endpoints: host.endpoints,
            lastGoodOrigin: probed.origin,
            accessToken: credential.accessToken,
            deviceId: credential.deviceId,
            trustSource: 'account_linked',
            accountUserId: user?.id ?? undefined,
            lastConnectedAt: new Date().toISOString(),
          });
          await setLastActiveWebHostId(saved.id);
        }
        setTransport((current) => {
          if (current && current !== candidate) current.destroy();
          return candidate;
        });
      } catch (nextError) {
        setError(
          nextError instanceof Error && nextError.message
            ? nextError.message
            : tRef.current('webConnect.authFailed')
        );
      } finally {
        setBusyHostId(null);
      }
    },
    [createTransport, user?.id]
  );

  useEffect(() => {
    const handleDisconnect = () => {
      clearStoredWebSession();
      void setLastActiveWebHostId(null);
      setError(null);
      setTransport((current) => {
        current?.destroy();
        return null;
      });
    };
    const handleSwitchHost = (event: Event) => {
      const detail = (event as CustomEvent<SwitchWebHostEventDetail>).detail;
      if (detail?.session) {
        void connectDirectSession(detail.session);
        return;
      }
      if (!detail?.hostId) return;
      void getSavedWebHost(detail.hostId).then((saved) => {
        if (saved) {
          void connectSavedHost(saved);
        }
      });
    };
    window.addEventListener(WEB_SESSION_DISCONNECT_EVENT, handleDisconnect);
    window.addEventListener(WEB_SESSION_SWITCH_HOST_EVENT, handleSwitchHost);
    return () => {
      window.removeEventListener(
        WEB_SESSION_DISCONNECT_EVENT,
        handleDisconnect
      );
      window.removeEventListener(
        WEB_SESSION_SWITCH_HOST_EVENT,
        handleSwitchHost
      );
    };
  }, [connectDirectSession, connectSavedHost]);

  useEffect(() => {
    if (!initialSession) {
      let active = true;
      const explicit = explicitHostUrl(window.location.search);

      const tryRestoreFromIndexedDb = async () => {
        if (getWebRememberHosts()) {
          const lastActiveId = await getLastActiveWebHostId();
          if (!active) return;
          if (lastActiveId) {
            const saved = await getSavedWebHost(lastActiveId);
            if (!active) return;
            if (
              saved &&
              (!explicit ||
                saved.endpoints.some(
                  (ep) =>
                    normalizeBaseUrl(ep.origin) === normalizeBaseUrl(explicit)
                ) ||
                normalizeBaseUrl(saved.origin) === normalizeBaseUrl(explicit))
            ) {
              setRestoring(true);
              try {
                await connectSavedHost(saved);
              } finally {
                if (active) setRestoring(false);
              }
              return;
            }
          }
        }
        if (explicit) return;
        const isHost = await looksLikeDimoHost(window.location.origin);
        if (active && !isHost) setBaseUrl('');
      };

      void tryRestoreFromIndexedDb();
      return () => {
        active = false;
      };
    }

    let active = true;
    const candidate = createTransport(
      initialSession.baseUrl,
      initialSession.token
    );
    void candidate
      .capabilities()
      .then(() => {
        if (!active) {
          candidate.destroy();
          return;
        }
        writeStoredWebSession(initialSession);
        setError(null);
        setTransport(candidate);
      })
      .catch((nextError) => {
        candidate.destroy();
        if (!active) return;
        if (isAuthFailure(nextError)) {
          clearStoredWebSession();
        }
        setError(
          nextError instanceof Error && nextError.message
            ? nextError.message
            : tRef.current('webConnect.authFailed')
        );
      })
      .finally(() => {
        if (active) {
          setRestoring(false);
        }
      });

    return () => {
      active = false;
    };
  }, [connectSavedHost, createTransport, initialSession]);

  const connect = async (event: SyntheticEvent) => {
    event.preventDefault();
    const invitationFromToken = parsePairingInvitation(token);
    const invitationFromBaseUrl = parsePairingInvitation(baseUrl);
    const invitation = invitationFromToken ?? invitationFromBaseUrl;
    const rawToken = (
      token.trim() || (invitationFromBaseUrl ? baseUrl.trim() : '')
    ).trim();
    let host = invitationFromBaseUrl ? '' : normalizeBaseUrl(baseUrl);
    const invitationEndpoints: ReachabilityEndpoint[] =
      invitation?.endpoints ?? [];

    if (!rawToken) return;
    if (!host && invitationEndpoints.length === 0) return;

    setConnecting(true);
    setError(null);

    let discoveredHostId = invitation?.hostId;
    let discoveredHostName: string | undefined;

    try {
      if (invitationEndpoints.length > 0) {
        const candidates: ReachabilityEndpoint[] = host
          ? [{ origin: host }, ...invitationEndpoints]
          : invitationEndpoints;
        const probed = await selectBestEndpoint(candidates, {
          expectedHostId: invitation?.hostId,
          lastGoodOrigin: host || undefined,
        });
        if (!probed) {
          setError(t('webConnect.notAHost'));
          setConnecting(false);
          return;
        }
        host = probed.origin;
        discoveredHostId = probed.hostId ?? discoveredHostId;
        discoveredHostName = probed.name;
      } else if (!(await looksLikeDimoHost(host))) {
        setError(t('webConnect.notAHost'));
        setConnecting(false);
        return;
      }
    } catch (nextError) {
      setError(
        nextError instanceof Error && nextError.message
          ? nextError.message
          : t('webConnect.notAHost')
      );
      setConnecting(false);
      return;
    }

    let resolvedToken = rawToken;
    let issuedDeviceId: string | undefined;
    if (invitation) {
      try {
        const redeemed = await redeemWebPairingToken(
          host,
          invitation.pairingToken,
          t('webConnect.authFailed'),
          (reason) => t('webConnect.e2eeRequired', { reason })
        );
        resolvedToken = redeemed.accessToken;
        issuedDeviceId = redeemed.deviceId;
      } catch (nextError) {
        setError(
          nextError instanceof Error
            ? nextError.message
            : t('webConnect.authFailed')
        );
        setConnecting(false);
        return;
      }
    }

    const candidate = createTransport(host, resolvedToken);
    try {
      await candidate.capabilities();
      writeStoredWebSession({
        baseUrl: host,
        token: resolvedToken,
        ...(discoveredHostId ? { hostId: discoveredHostId } : {}),
      });
      if (rememberHosts) {
        const saved = await upsertSavedWebHost({
          id: discoveredHostId || host,
          hostId: discoveredHostId,
          name: discoveredHostName || defaultHostNameFromOrigin(host),
          origin: host,
          endpoints:
            invitationEndpoints.length > 0
              ? [{ origin: host }, ...invitationEndpoints]
              : [{ origin: host }],
          lastGoodOrigin: host,
          accessToken: resolvedToken,
          deviceId: issuedDeviceId,
          trustSource: 'paired',
          lastConnectedAt: new Date().toISOString(),
        });
        await setLastActiveWebHostId(saved.id);
      }
      setToken('');
      setTransport(candidate);
    } catch (nextError) {
      candidate.destroy();
      if (isAuthFailure(nextError)) {
        clearStoredWebSession();
      }
      setError(
        nextError instanceof Error
          ? nextError.message
          : t('webConnect.authFailed')
      );
    } finally {
      setConnecting(false);
    }
  };

  if (transport) {
    return (
      <BackendTransportProvider transport={transport}>
        {children}
      </BackendTransportProvider>
    );
  }

  if (restoring) {
    return (
      <div className="legacy-design web-connect">
        <main className="web-connect__frame">
          <div className="web-connect__card" role="status" aria-live="polite">
            <div className="web-connect__brand">
              <Logo showText size="window" />
            </div>
            <div className="web-connect__intro">
              <h1 className="web-connect__title">{t('webConnect.title')}</h1>
              <p className="web-connect__description">
                {t('webConnect.connecting')}
              </p>
            </div>
          </div>
        </main>
      </div>
    );
  }

  const hasEmbeddedEndpoints = Boolean(
    parsedInvitation && parsedInvitation.endpoints.length > 0
  );
  const canSubmit =
    Boolean(token.trim() || parsedFromBaseUrl) &&
    (Boolean(baseUrl.trim() && !parsedFromBaseUrl) || hasEmbeddedEndpoints);

  const onlineAccountHosts = accountHosts.filter(
    (ah) =>
      ah.online &&
      ah.endpoints.length > 0 &&
      !savedHosts.some(
        (saved) => saved.hostId === ah.hostId || saved.id === ah.hostId
      )
  );
  const accountDisplayName = user ? resolveAccountDisplayName(user) : '';

  return (
    <div className="legacy-design web-connect">
      <main className="web-connect__frame">
        <form
          className="web-connect__card"
          onSubmit={(event) => void connect(event)}
          aria-label={t('webConnect.formLabel')}
        >
          <div className="web-connect__brand">
            <Logo showText size="window" />
          </div>
          <div className="web-connect__intro">
            <h1 className="web-connect__title">{t('webConnect.title')}</h1>
            <p className="web-connect__description">
              {t('webConnect.description')}
            </p>
          </div>

          {savedHosts.length > 0 ? (
            <div className="space-y-1.5">
              <div className="text-xs font-medium text-muted-foreground">
                {t('webConnect.savedHosts')}
              </div>
              <div className="space-y-1">
                {savedHosts.map((host) => {
                  const isBusy = busyHostId === host.id;
                  return (
                    <div
                      key={host.id}
                      className="flex items-center justify-between gap-2 rounded-md border border-border/70 bg-card px-2.5 py-2 text-xs transition-colors hover:bg-muted/50"
                    >
                      <button
                        type="button"
                        className="flex min-w-0 flex-1 items-center gap-2.5 rounded-sm text-left focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-60"
                        disabled={busyHostId !== null || connecting}
                        onClick={() => void connectSavedHost(host)}
                      >
                        {isBusy ? (
                          <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-muted-foreground" />
                        ) : (
                          <Laptop className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                        )}
                        <span className="min-w-0 flex-1">
                          <span className="block truncate font-medium text-foreground">
                            {host.name}
                          </span>
                          <span className="block truncate font-mono text-xs text-muted-foreground">
                            {host.lastGoodOrigin || host.origin}
                          </span>
                        </span>
                      </button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        disabled={busyHostId !== null || connecting}
                        className="h-6 w-6 shrink-0 text-muted-foreground hover:text-destructive"
                        aria-label={t('webConnect.removeSavedHost', {
                          name: host.name,
                        })}
                        onClick={() => {
                          void removeSavedWebHost(host.id).then(() => {
                            toast.success(
                              t('webConnect.savedHostRemoved', {
                                name: host.name,
                              })
                            );
                          });
                        }}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  );
                })}
              </div>
            </div>
          ) : null}

          <div
            className="space-y-2 rounded-md border border-border/70 bg-card/60 p-2.5"
            data-testid="web-connect-account-section"
          >
            {isSignedIn ? (
              <>
                <div className="flex items-center justify-between gap-2">
                  <div className="flex min-w-0 items-center gap-1.5 text-xs font-medium text-muted-foreground">
                    <User className="h-3.5 w-3.5 shrink-0" />
                    <span className="truncate">
                      {t('webConnect.accountHosts')}
                    </span>
                    {accountDisplayName ? (
                      <span className="truncate font-normal text-foreground/80">
                        · {accountDisplayName}
                      </span>
                    ) : null}
                  </div>
                  <div className="flex shrink-0 items-center gap-1">
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="h-6 w-6 text-muted-foreground hover:text-foreground"
                      disabled={accountHostsLoading || busyHostId !== null}
                      aria-label={t('webConnect.accountRefresh')}
                      title={t('webConnect.accountRefresh')}
                      onClick={() => void refreshAccountHosts()}
                    >
                      <RefreshCw
                        className={
                          accountHostsLoading
                            ? 'h-3 w-3 animate-spin'
                            : 'h-3 w-3'
                        }
                      />
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="h-6 px-1.5 text-xs text-muted-foreground hover:text-foreground"
                      disabled={busyHostId !== null}
                      onClick={() => void signOutAccount()}
                    >
                      <LogOut className="mr-1 h-3 w-3" />
                      {t('webConnect.accountSignOut')}
                    </Button>
                  </div>
                </div>
                {onlineAccountHosts.length > 0 ? (
                  <div className="space-y-1">
                    {onlineAccountHosts.map((host) => {
                      const isBusy = busyHostId === host.hostId;
                      return (
                        <button
                          key={host.hostId}
                          type="button"
                          disabled={busyHostId !== null || connecting}
                          onClick={() => void connectAccountHost(host)}
                          className="flex w-full items-center justify-between gap-2 rounded-md border border-border/70 bg-card px-2.5 py-2 text-left text-xs transition-colors hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-60"
                        >
                          <span className="flex min-w-0 items-center gap-2">
                            <span className="h-2 w-2 shrink-0 rounded-full bg-success" />
                            <span className="truncate font-medium text-foreground">
                              {host.hostName}
                            </span>
                          </span>
                          <span className="inline-flex shrink-0 items-center gap-1 text-xs font-medium text-primary">
                            {isBusy ? (
                              <Loader2 className="h-3 w-3 animate-spin" />
                            ) : null}
                            {isBusy
                              ? t('webConnect.connecting')
                              : t('webConnect.oneClickConnect')}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                ) : !accountHostsLoading ? (
                  <p className="text-xs text-muted-foreground">
                    {t('webConnect.accountNoOnlineHosts')}
                  </p>
                ) : null}
              </>
            ) : accountLogin.loginState ? (
              <div className="space-y-2 text-xs">
                <div className="flex items-center justify-between gap-2">
                  <span className="inline-flex items-center gap-1.5 font-medium text-foreground">
                    <Loader2 className="h-3.5 w-3.5 animate-spin text-primary" />
                    {t('webConnect.accountApproveInBrowser')}
                  </span>
                  <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs font-semibold text-foreground">
                    {accountLogin.loginState.login.userCode}
                  </code>
                </div>
                <div className="flex items-center justify-end gap-1.5">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="h-7 px-2 text-xs"
                    onClick={accountLogin.reopenVerifyUrl}
                  >
                    <ExternalLink className="mr-1 h-3 w-3" />
                    {t('webConnect.accountOpenVerifyPage')}
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-7 px-2 text-xs"
                    onClick={accountLogin.cancelLogin}
                  >
                    {t('webConnect.accountCancelSignIn')}
                  </Button>
                </div>
              </div>
            ) : (
              <div className="flex items-center justify-between gap-2">
                <span className="min-w-0 text-xs text-muted-foreground">
                  {t('webConnect.accountSignInPrompt')}
                </span>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="h-7 shrink-0 px-2.5 text-xs"
                  disabled={
                    accountLogin.startingLogin ||
                    busyHostId !== null ||
                    connecting
                  }
                  onClick={() => void accountLogin.startLogin()}
                >
                  {accountLogin.startingLogin ? (
                    <Loader2 className="mr-1 h-3 w-3 animate-spin" />
                  ) : (
                    <LogIn className="mr-1 h-3 w-3" />
                  )}
                  {t('webConnect.accountSignIn')}
                </Button>
              </div>
            )}
            {accountLogin.authError ? (
              <p className="text-xs text-destructive">
                {accountLogin.authError}
              </p>
            ) : null}
          </div>

          <div className="flex items-center gap-2 py-0.5 text-xs text-muted-foreground">
            <span className="h-px flex-1 bg-border" />
            <span>{t('webConnect.orManualConnect')}</span>
            <span className="h-px flex-1 bg-border" />
          </div>

          <label className="web-connect__field">
            <span>{t('webConnect.hostLabel')}</span>
            <Input
              value={baseUrl}
              onChange={(event) => setBaseUrl(event.target.value)}
              required={!hasEmbeddedEndpoints}
              placeholder="http://127.0.0.1:17891"
              className="font-mono text-sm"
            />
            {hostDiffers ? (
              <span className="web-connect__hint">
                {t('webConnect.hostMismatch')}
              </span>
            ) : null}
          </label>
          <label className="web-connect__field">
            <span>{t('webConnect.tokenLabel')}</span>
            <span className="web-connect__token">
              <Input
                type={tokenRevealed ? 'text' : 'password'}
                value={token}
                onChange={(event) => setToken(event.target.value)}
                placeholder={t('webConnect.tokenPlaceholder')}
                required={!parsedFromBaseUrl}
                autoFocus
                className="flex-1 font-mono text-sm"
              />
              <Button
                type="button"
                variant="outline"
                size="icon"
                className="web-connect__reveal"
                onClick={() => setTokenRevealed((value) => !value)}
                aria-label={
                  tokenRevealed
                    ? t('webConnect.hideToken')
                    : t('webConnect.showToken')
                }
              >
                {tokenRevealed ? (
                  <EyeOff className="h-3.5 w-3.5" />
                ) : (
                  <Eye className="h-3.5 w-3.5" />
                )}
              </Button>
            </span>
            {hasEmbeddedEndpoints ? (
              <span className="text-xs text-success">
                {t('webConnect.pairingDetected')}
              </span>
            ) : null}
          </label>

          <div className="flex items-center gap-2 text-xs text-muted-foreground select-none">
            <Checkbox
              id="web-connect-remember-host"
              checked={rememberHosts}
              onCheckedChange={(next) => {
                setRememberHosts(next);
                setWebRememberHosts(next);
              }}
            />
            <label
              htmlFor="web-connect-remember-host"
              className="cursor-pointer"
            >
              {t('webConnect.rememberHost')}
            </label>
          </div>

          {error ? (
            <p role="alert" className="web-connect__error">
              {error}
            </p>
          ) : null}
          <Button
            className="w-full"
            type="submit"
            disabled={connecting || busyHostId !== null || !canSubmit}
          >
            {connecting ? (
              <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
            ) : null}
            {connecting ? t('webConnect.connecting') : t('webConnect.connect')}
          </Button>
        </form>
      </main>
    </div>
  );
}
