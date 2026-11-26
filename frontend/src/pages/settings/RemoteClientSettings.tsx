import {
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { UNSAFE_LocationContext } from 'react-router-dom';
import { backendListen } from '@/lib/backendTransport';
import {
  ChevronDown,
  Cloud,
  Laptop,
  Loader2,
  Radio,
  RefreshCw,
  Server,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { ConfirmDialog } from '@/components/dialogs/shared/ConfirmDialog';
import { resolveCloudRelayTargetOrigin } from '@/components/layout/HostSelector';
import { TextInput } from '@astryxdesign/core/TextInput';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import { Switch } from '@/components/ui/switch';
import { toast } from '@/components/ui/toast';
import {
  reconcileRemoteHostAccount,
  useDimoAccount,
} from '@/features/model-router';
import {
  hostClientApi,
  type DiscoveredHost,
  type HostClientProfile,
  type SavedHostUpdateView,
} from '@/lib/api';
import { getSiteUrl } from '@/lib/branding';
import {
  type AccountDirectoryHost,
  listAccountDirectoryHosts,
  parsePairingInvitation,
  requestHostAccessGrant,
} from '@/lib/connectivity';
import { getErrorMessage } from '@/lib/modals';
import { cn } from '@/lib/utils';

import { AppSurfaceHost } from '@/components/plugins/AppSurfaceHost';
import { contributionIconComponent } from '@/components/plugins/contributionIcon';
import { createBackendAppSurfaceTransport } from '@/lib/api/appSurfaceTransport';
import { createPluginControlApi } from '@/lib/api/plugins';
import { getLocalDesktopTransport } from '@/lib/transport';
import {
  localProvisionerSurfaces,
  prefillProvisionerSettings,
  provisionedHostPayload,
  provisionerForKind,
  type LocalProvisionerSurface,
} from './localProvisionerSurfaces';
import {
  provisionKindLabel,
  savedHostAddress,
  savedHostOrigin,
  savedHostSource,
  type SavedHostSource,
} from './savedHostAddress';
import { SettingsSection } from './SettingsUi';
import { SurfaceLoading } from '@/components/layout/SurfaceLoading';

function isNeedsToken(error: unknown): boolean {
  return getErrorMessage(error).includes('needs_token');
}

function connectErrorMessage(
  error: unknown,
  failed: string,
  loginRejected: string
): string {
  const message = getErrorMessage(error);
  if (/permission denied/i.test(message)) return loginRejected;
  const cleaned = message
    .replace(/^(internal error:\s*)+/i, '')
    .replace(/^(worker_request_failed:\s*)+/i, '')
    .replace(/^(worker_failed:\s*)+/i, '')
    .trim();
  return cleaned || failed;
}

const HOST_SOURCE_COPY: Record<SavedHostSource, string> = {
  discovered: 'webService.hostSourceDiscovered',
  manual: 'webService.hostSourceManual',
  ssh: 'webService.hostSourceSsh',
  other: 'webService.hostSourceOther',
};

function SavedHostFacts({ profile }: { profile: HostClientProfile }) {
  const { t } = useTranslation('settings');
  const [open, setOpen] = useState(false);
  return (
    <div className={cn('settings-host-facts', open && 'is-open')}>
      <button
        type="button"
        className="settings-host-facts__toggle"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        {t('webService.hostDetails')}
      </button>
      {open ? (
        <dl>
          <div>
            <dt>{t('webService.hostSourceLabel')}</dt>
            <dd>
              {t(HOST_SOURCE_COPY[savedHostSource(profile.provision_kind)])}
            </dd>
          </div>
          <div>
            <dt>{t('webService.savedHostAddressLabel')}</dt>
            <dd>
              <code title={savedHostAddress(profile)}>
                {savedHostAddress(profile)}
              </code>
            </dd>
          </div>
          {profile.host_id ? (
            <div>
              <dt>{t('webService.hostIdLabel')}</dt>
              <dd>
                <code title={profile.host_id}>{profile.host_id}</code>
              </dd>
            </div>
          ) : null}
          {profile.last_connected_at ? (
            <div>
              <dt>{t('webService.lastConnectedLabel')}</dt>
              <dd>{new Date(profile.last_connected_at).toLocaleString()}</dd>
            </div>
          ) : null}
        </dl>
      ) : null}
    </div>
  );
}

function hostKey(host: { origin: string; host_id?: string | null }): string {
  return host.host_id?.trim() || host.origin;
}

function useLocalProvisioners() {
  const [panels, setPanels] = useState<LocalProvisionerSurface[]>([]);
  const [openId, setOpenId] = useState<string | null>(null);
  const [surfaceReloadKey, setSurfaceReloadKey] = useState(0);
  const api = useMemo(
    () => createPluginControlApi(getLocalDesktopTransport()),
    []
  );
  const surfaceTransport = useMemo(
    () => createBackendAppSurfaceTransport(getLocalDesktopTransport()),
    []
  );

  const reload = useCallback(async () => {
    const [catalog, contributions] = await Promise.all([
      api.catalog(),
      api.contributionCatalog(),
    ]);
    setPanels(localProvisionerSurfaces(catalog, contributions));
  }, [api]);

  useEffect(() => {
    let cancelled = false;
    void reload().catch(() => {
      if (!cancelled) setPanels([]);
    });
    return () => {
      cancelled = true;
    };
  }, [reload]);

  const open = useCallback(
    (panel: LocalProvisionerSurface) => {
      if (!panel.plugin.enabled) {
        void api
          .setEnabled(panel.plugin.id, true)
          .then(() => reload())
          .then(() => setOpenId(panel.plugin.id))
          .catch(() => undefined);
        return;
      }
      setOpenId((current) =>
        current === panel.plugin.id ? null : panel.plugin.id
      );
    },
    [api, reload]
  );

  const ensureOpen = useCallback(
    async (panel: LocalProvisionerSurface) => {
      if (!panel.plugin.enabled) {
        await api.setEnabled(panel.plugin.id, true).catch(() => undefined);
        await reload().catch(() => undefined);
      }
      setSurfaceReloadKey((current) => current + 1);
      setOpenId(panel.plugin.id);
    },
    [api, reload]
  );

  return {
    panels,
    openId,
    surfaceReloadKey,
    open,
    ensureOpen,
    surfaceTransport,
    api,
  };
}

export function RemoteClientSettings() {
  const { t } = useTranslation(['settings', 'common']);
  const { isSignedIn, overview } = useDimoAccount();
  const hasRelayPermission = Boolean(
    isSignedIn && overview?.relayPermission !== false
  );
  const relayPublicOrigin =
    overview?.assignedRelayServer?.publicOrigin?.trim() || getSiteUrl();
  const locationContext = useContext(UNSAFE_LocationContext);
  const rawSearch =
    locationContext?.location.search ??
    (typeof window !== 'undefined' ? window.location.search : '');
  const requestedAction = useMemo(
    () => new URLSearchParams(rawSearch).get('action'),
    [rawSearch]
  );
  const provisioners = useLocalProvisioners();
  const [profiles, setProfiles] = useState<HostClientProfile[]>([]);
  const [localHostId, setLocalHostId] = useState<string | null>(null);
  const [accountHosts, setAccountHosts] = useState<AccountDirectoryHost[]>([]);
  const [loadingAccountHosts, setLoadingAccountHosts] = useState(false);
  const [discovered, setDiscovered] = useState<DiscoveredHost[]>([]);
  const [loading, setLoading] = useState(true);
  const [scanning, setScanning] = useState(false);
  const [connectingKey, setConnectingKey] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [tokenFor, setTokenFor] = useState<string | null>(null);
  const [token, setToken] = useState('');
  const [manualOpen, setManualOpen] = useState(
    () => requestedAction === 'connect'
  );
  const [manualOrigin, setManualOrigin] = useState('');
  const [manualCode, setManualCode] = useState('');
  const [manualUseRelay, setManualUseRelay] = useState(false);
  const [savedUseRelayById, setSavedUseRelayById] = useState<
    Record<string, boolean>
  >({});
  const [hostUpdates, setHostUpdates] = useState<SavedHostUpdateView[]>([]);
  const [updatingId, setUpdatingId] = useState<string | null>(null);
  const autoOpenedSshRef = useRef(false);

  useEffect(() => {
    if (requestedAction === 'connect') {
      setManualOpen(true);
    }
  }, [requestedAction]);

  useEffect(() => {
    if (requestedAction !== 'ssh') {
      autoOpenedSshRef.current = false;
      return;
    }
    if (autoOpenedSshRef.current) return;
    const sshPanel = provisioners.panels.find((panel) => panel.kind === 'ssh');
    if (!sshPanel) return;
    autoOpenedSshRef.current = true;
    if (provisioners.openId !== sshPanel.plugin.id) {
      provisioners.open(sshPanel);
    }
  }, [provisioners, requestedAction]);

  const connected = profiles.find((profile) => profile.connected) ?? null;

  const loadStatus = useCallback(async () => {
    const status = await hostClientApi.status();
    setProfiles(status.profiles);
    setLocalHostId(status.local_host_id ?? null);
    return status;
  }, []);

  const loadAccountHosts = useCallback(async () => {
    if (!isSignedIn) {
      setAccountHosts([]);
      return;
    }
    setLoadingAccountHosts(true);
    try {
      setAccountHosts(await listAccountDirectoryHosts());
    } finally {
      setLoadingAccountHosts(false);
    }
  }, [isSignedIn]);

  const connectAccountHost = useCallback(
    async (host: AccountDirectoryHost) => {
      const key = `account:${host.hostId}`;
      setConnectingKey(key);
      try {
        if (
          typeof hostClientApi.identity !== 'function' ||
          typeof hostClientApi.connectWithGrant !== 'function'
        ) {
          throw new Error(t('webService.clientConnectFailed'));
        }
        const identity = await hostClientApi.identity();
        const grant = await requestHostAccessGrant({
          hostId: host.hostId,
          clientPublicKeyEd25519: identity.publicKeyEd25519,
          clientKind: 'desktop',
          preset: 'workstation',
        });
        const result = await hostClientApi.connectWithGrant({
          hostId: host.hostId,
          name: host.hostName,
          endpoints: host.endpoints,
          grantToken: grant.grantToken,
        });
        if (result.profile?.connected) {
          void reconcileRemoteHostAccount(result.profile);
        }
        if (result.stopped_host) {
          toast.info(t('webService.stoppedHostForClient'));
        }
        await loadStatus();
        toast.success(t('webService.clientConnected'));
      } catch (error) {
        toast.error(
          connectErrorMessage(
            error,
            t('webService.clientConnectFailed'),
            t('webService.sshLoginRejected')
          )
        );
      } finally {
        setConnectingKey(null);
      }
    },
    [loadStatus, t]
  );

  const loadHostUpdates = useCallback(async () => {
    try {
      setHostUpdates(await hostClientApi.hostUpdates());
    } catch {
      setHostUpdates([]);
    }
  }, []);

  const scan = useCallback(async () => {
    setScanning(true);
    try {
      setDiscovered(await hostClientApi.discover());
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : t('webService.clientDiscoverFailed')
      );
    } finally {
      setScanning(false);
    }
  }, [t]);

  useEffect(() => {
    void loadAccountHosts();
  }, [loadAccountHosts]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        await loadStatus();
        if (!cancelled) await scan();
        if (!cancelled) await loadHostUpdates();
      } catch (error) {
        if (!cancelled) {
          toast.error(
            error instanceof Error
              ? error.message
              : t('webService.clientStatusFailed')
          );
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [loadHostUpdates, loadStatus, scan, t]);

  useEffect(() => {
    if (!connected) return;
    const timer = window.setInterval(() => {
      void loadStatus().catch((error) => {
        if (isNeedsToken(error)) {
          toast.error(t('webService.clientRevoked'));
        }
      });
    }, 8000);
    return () => window.clearInterval(timer);
  }, [connected, loadStatus, t]);

  useEffect(() => {
    let cancelled = false;
    let stop: (() => void) | undefined;
    void backendListen<void>('host-client-changed', () => {
      if (!cancelled) void loadStatus().catch(() => undefined);
    })
      .then((unlisten) => {
        if (cancelled) {
          unlisten();
          return;
        }
        stop = unlisten;
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
      stop?.();
    };
  }, [loadStatus]);

  const savedMatch = useCallback(
    (host: DiscoveredHost) =>
      profiles.find(
        (profile) =>
          (host.host_id && profile.host_id === host.host_id) ||
          profile.origin === host.origin
      ),
    [profiles]
  );

  const connect = useCallback(
    async (request: {
      origin?: string;
      token?: string;
      profile_id?: string;
      key: string;
    }) => {
      setConnectingKey(request.key);
      try {
        const parsedInvitation = request.token
          ?.trim()
          .startsWith('dimo-pairing:')
          ? parsePairingInvitation(request.token)
          : null;
        const resolvedOrigin =
          request.origin?.trim() ||
          parsedInvitation?.endpoints[0]?.origin ||
          undefined;
        const result = await hostClientApi.connect({
          origin: resolvedOrigin,
          token: request.token,
          profile_id: request.profile_id,
          ...(parsedInvitation && parsedInvitation.endpoints.length > 0
            ? { endpoints: parsedInvitation.endpoints }
            : {}),
        });
        if (result.profile?.connected) {
          void reconcileRemoteHostAccount(result.profile);
        }
        await loadStatus();
        setToken('');
        setManualCode('');
        setTokenFor(null);
        setExpandedId(result.profile.id);
        if (result.profile.connected) {
          toast.success(t('webService.clientConnected'));
        }
        if (result.stopped_host) {
          toast.success(t('webService.stoppedHostForClient'));
        }
        return true;
      } catch (error) {
        if (isNeedsToken(error)) {
          setTokenFor(request.key);
          toast.error(t('webService.clientNeedsCode'));
          await loadStatus().catch(() => undefined);
        } else {
          toast.error(
            connectErrorMessage(
              error,
              t('webService.clientConnectFailed'),
              t('webService.sshLoginRejected')
            )
          );
        }
        return false;
      } finally {
        setConnectingKey(null);
      }
    },
    [loadStatus, t]
  );

  const connectDiscovered = useCallback(
    async (host: DiscoveredHost) => {
      const key = hostKey(host);
      const saved = savedMatch(host);
      if (saved?.has_credential && tokenFor !== key) {
        await connect({
          origin: host.origin,
          profile_id: saved.id,
          key,
        });
        return;
      }
      if (!token.trim()) {
        setTokenFor(key);
        return;
      }
      await connect({ origin: host.origin, token: token.trim(), key });
    },
    [connect, savedMatch, token, tokenFor]
  );

  const connectSaved = useCallback(
    async (profile: HostClientProfile) => {
      const source = savedHostSource(profile.provision_kind);
      let origin = savedHostOrigin(profile);
      const useRelay =
        hasRelayPermission &&
        source !== 'ssh' &&
        Boolean(savedUseRelayById[profile.id] ?? origin.includes('/t/'));
      if (useRelay) {
        origin = resolveCloudRelayTargetOrigin(
          origin,
          relayPublicOrigin,
          profile.host_id
        );
      }
      if (source === 'ssh' || source === 'other') {
        const provisioner = provisionerForKind(
          provisioners.panels,
          profile.provision_kind
        );
        if (!provisioner?.handler) {
          toast.error(
            t('webService.provisionerRequired', {
              label:
                provisionKindLabel(
                  profile.provision_kind,
                  provisioners.panels
                ) || profile.provision_kind,
            })
          );
          return;
        }
        setConnectingKey(profile.id);
        try {
          if (!provisioner.plugin.enabled) {
            await provisioners.api.setEnabled(provisioner.plugin.id, true);
          }
          const ensured = (await provisioners.api.invokeContribution(
            provisioner.plugin.id,
            provisioner.handler,
            { profile: provisionedHostPayload(profile) },
            provisioner.timeoutSeconds
          )) as { origin?: unknown };
          const ensuredOrigin =
            typeof ensured?.origin === 'string' ? ensured.origin.trim() : '';
          if (!ensuredOrigin) {
            throw new Error(t('webService.clientConnectFailed'));
          }
          origin = ensuredOrigin;
        } catch (error) {
          if (source === 'ssh') {
            await prefillProvisionerSettings(
              provisioners.api,
              provisioner.plugin.id,
              profile
            );
            await provisioners.ensureOpen(provisioner);
          }
          toast.error(
            connectErrorMessage(
              error,
              t('webService.clientConnectFailed'),
              t('webService.sshLoginRejected')
            )
          );
          setConnectingKey(null);
          return;
        }
      }
      if (
        profile.has_credential &&
        !profile.needs_token &&
        tokenFor !== profile.id
      ) {
        await connect({
          profile_id: profile.id,
          origin,
          key: profile.id,
        });
        return;
      }
      if (!token.trim()) {
        setTokenFor(profile.id);
        setExpandedId(profile.id);
        return;
      }
      await connect({
        profile_id: profile.id,
        origin,
        token: token.trim(),
        key: profile.id,
      });
    },
    [
      connect,
      hasRelayPermission,
      provisioners,
      relayPublicOrigin,
      savedUseRelayById,
      t,
      token,
      tokenFor,
    ]
  );

  const connectManual = useCallback(async () => {
    const rawOriginInput = manualOrigin.trim();
    const rawCodeInput = manualCode.trim();
    const invitationInput = rawCodeInput.startsWith('dimo-pairing:')
      ? rawCodeInput
      : rawOriginInput.startsWith('dimo-pairing:')
        ? rawOriginInput
        : null;
    const parsedInvitation = invitationInput
      ? parsePairingInvitation(invitationInput)
      : null;

    const rawOrigin = rawOriginInput.startsWith('dimo-pairing:')
      ? (parsedInvitation?.endpoints[0]?.origin ?? '')
      : rawOriginInput || parsedInvitation?.endpoints[0]?.origin || '';
    const effectiveCode = invitationInput ?? rawCodeInput;

    if (!rawOrigin && !parsedInvitation?.endpoints.length) {
      toast.error(t('webService.clientOriginRequired'));
      return;
    }
    const saved = rawOrigin
      ? profiles.find((profile) => profile.origin === rawOrigin)
      : undefined;
    const origin =
      rawOrigin && hasRelayPermission && manualUseRelay
        ? resolveCloudRelayTargetOrigin(
            rawOrigin,
            relayPublicOrigin,
            saved?.host_id
          )
        : rawOrigin || undefined;
    if (saved?.has_credential && !effectiveCode) {
      const ok = await connect({
        origin,
        profile_id: saved.id,
        key: 'manual',
      });
      if (ok) {
        setManualOpen(false);
      }
      return;
    }
    if (!effectiveCode && !saved?.has_credential) {
      toast.error(t('webService.clientNeedsCode'));
      return;
    }
    const ok = await connect({
      origin,
      token: effectiveCode || undefined,
      profile_id: saved?.id,
      key: 'manual',
    });
    if (ok) {
      setManualOpen(false);
    }
  }, [
    connect,
    hasRelayPermission,
    manualCode,
    manualOrigin,
    manualUseRelay,
    profiles,
    relayPublicOrigin,
    t,
  ]);

  const disconnectHost = useCallback(async () => {
    try {
      await hostClientApi.disconnect();
      await loadStatus();
      toast.success(t('webService.clientDisconnected'));
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : t('webService.clientConnectFailed')
      );
    }
  }, [loadStatus, t]);

  const confirmHostUpdate = useCallback(
    async (profile: HostClientProfile, update: SavedHostUpdateView) => {
      const confirmed = await ConfirmDialog.show({
        title: t('webService.hostUpdateTitle'),
        message: t('webService.hostUpdateMessage', {
          name: profile.name,
          address: savedHostAddress(profile),
          from: update.current_version ?? '—',
          to: update.latest_version ?? '—',
        }),
        confirmText: t('webService.hostUpdateConfirm'),
        cancelText: t('common:cancel'),
        variant: 'info',
      });
      if (confirmed !== 'confirmed') return;
      setUpdatingId(profile.id);
      try {
        const result = await hostClientApi.applyHostUpdate(profile.id);
        toast.success(
          t('webService.hostUpdateDone', { version: result.toVersion })
        );
        await loadStatus();
        await loadHostUpdates();
      } catch (error) {
        const message = getErrorMessage(error);
        toast.error(
          message.includes('host_update_unreachable')
            ? t('webService.hostUpdateFailed')
            : message
        );
        await loadHostUpdates();
      } finally {
        setUpdatingId(null);
      }
    },
    [loadHostUpdates, loadStatus, t]
  );

  const deleteHost = useCallback(
    async (profile: HostClientProfile) => {
      const confirmed = await ConfirmDialog.show({
        title: t('webService.deleteHostTitle'),
        message: t('webService.deleteHostMessage', { name: profile.name }),
        confirmText: t('webService.deleteHost'),
        cancelText: t('common:cancel'),
        variant: 'destructive',
      });
      if (confirmed !== 'confirmed') return;
      try {
        await hostClientApi.delete(profile.id);
        await loadStatus();
        if (expandedId === profile.id) setExpandedId(null);
        toast.success(t('webService.clientHostDeleted'));
      } catch (error) {
        toast.error(
          error instanceof Error
            ? error.message
            : t('webService.clientDeleteFailed')
        );
      }
    },
    [expandedId, loadStatus, t]
  );

  const discoveredVisible = useMemo(
    () =>
      discovered.filter(
        (host) =>
          !connected ||
          hostKey(host) !== (connected.host_id || connected.origin)
      ),
    [connected, discovered]
  );

  const accountHostsVisible = useMemo(
    () =>
      accountHosts.filter(
        (host) =>
          (!localHostId || host.hostId !== localHostId) &&
          !profiles.some((profile) => profile.host_id === host.hostId)
      ),
    [accountHosts, localHostId, profiles]
  );

  if (loading) {
    return <SurfaceLoading />;
  }

  const openProvisioner = provisioners.panels.find(
    (panel) => panel.plugin.id === provisioners.openId
  );

  return (
    <div className="settings-sections">
      <SettingsSection
        icon={Radio}
        title={t('webService.discoverTitle')}
        action={
          <div className="flex items-center gap-2">
            {provisioners.panels.map((panel) => {
              const Icon = contributionIconComponent(panel.icon, Laptop);
              return (
                <Button
                  key={panel.plugin.id}
                  variant="outline"
                  size="sm"
                  className="h-8"
                  aria-pressed={provisioners.openId === panel.plugin.id}
                  onClick={() => provisioners.open(panel)}
                >
                  <Icon className="mr-1 h-3.5 w-3.5" />
                  {panel.label}
                </Button>
              );
            })}
            <Popover open={manualOpen} onOpenChange={setManualOpen}>
              <PopoverTrigger asChild>
                <Button variant="outline" size="sm" className="h-8">
                  <Laptop className="mr-1 h-3.5 w-3.5" />
                  {t('webService.manualTitle')}
                </Button>
              </PopoverTrigger>
              <PopoverContent
                align="end"
                className="settings-manual-connect w-80"
              >
                <form
                  className="flex flex-col gap-3"
                  onSubmit={(event) => {
                    event.preventDefault();
                    void connectManual();
                  }}
                >
                  <div>
                    <Label htmlFor="manual-connect-origin">
                      {t('webService.manualOriginLabel')}
                    </Label>
                    <TextInput
                      id="manual-connect-origin"
                      label={t('webService.manualOriginLabel')}
                      isLabelHidden
                      value={manualOrigin}
                      onChange={setManualOrigin}
                      placeholder={t('webService.manualOriginPlaceholder')}
                      width="100%"
                      className="mt-1 [&_input]:font-mono [&_input]:text-sm"
                    />
                  </div>
                  <div>
                    <Label htmlFor="manual-connect-code">
                      {t('webService.clientCodeLabel')}
                    </Label>
                    <TextInput
                      id="manual-connect-code"
                      label={t('webService.clientCodeLabel')}
                      isLabelHidden
                      value={manualCode}
                      onChange={setManualCode}
                      placeholder={t('webService.clientCodePlaceholder')}
                      width="100%"
                      className="mt-1 [&_input]:font-mono [&_input]:text-sm"
                    />
                    {parsePairingInvitation(manualCode.trim()) ||
                    parsePairingInvitation(manualOrigin.trim()) ? (
                      <p className="mt-1 text-xs text-success">
                        {t('webService.pairingDetected')}
                      </p>
                    ) : null}
                  </div>
                  {hasRelayPermission ? (
                    <div
                      data-testid="manual-connect-cloud-relay-row"
                      className="flex items-center justify-between gap-2 rounded-md border border-border/70 bg-muted/30 px-2.5 py-1.5"
                    >
                      <Label
                        htmlFor="manual-connect-use-cloud-relay"
                        className="text-xs font-medium"
                      >
                        {t('webService.useCloudRelayService')}
                      </Label>
                      <Switch
                        id="manual-connect-use-cloud-relay"
                        aria-label={t('webService.useCloudRelayService')}
                        checked={manualUseRelay}
                        onCheckedChange={(checked: boolean) =>
                          setManualUseRelay(checked)
                        }
                      />
                    </div>
                  ) : null}
                  <Button
                    type="submit"
                    size="sm"
                    className="h-8 self-end"
                    disabled={connectingKey === 'manual'}
                  >
                    {connectingKey === 'manual' ? (
                      <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
                    ) : null}
                    {t('webService.clientConnect')}
                  </Button>
                </form>
              </PopoverContent>
            </Popover>
            <Button
              variant="outline"
              size="sm"
              className="h-8"
              onClick={() => void scan()}
              disabled={scanning}
            >
              {scanning ? (
                <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
              ) : (
                <RefreshCw className="mr-1 h-3.5 w-3.5" />
              )}
              {t('webService.discoverRefresh')}
            </Button>
          </div>
        }
      >
        <div
          className="settings-bounded-list-container min-w-0 overflow-hidden rounded-lg border border-border bg-background/50"
          data-testid="discovered-hosts-list-container"
        >
          <div
            className="settings-bounded-list max-h-56 divide-y divide-border/60 overflow-y-auto"
            data-testid="discovered-hosts-scroll-box"
          >
            {discoveredVisible.length === 0 ? (
              <p className="settings-pairing-devices__empty">
                {t('webService.discoverEmpty')}
              </p>
            ) : (
              discoveredVisible.map((host) => {
                const key = hostKey(host);
                const asking = tokenFor === key;
                const busy = connectingKey === key;
                return (
                  <div className="settings-host-row" key={key}>
                    <div className="settings-host-row__summary flex min-h-11 min-w-0 items-center justify-between gap-3 px-3 py-2">
                      <div className="flex min-w-0 flex-1 items-center gap-2 overflow-hidden">
                        <span className="max-w-[14rem] shrink-0 truncate text-xs font-medium text-foreground">
                          {host.name || host.origin}
                        </span>
                        <span className="shrink-0 truncate rounded bg-muted px-1.5 py-0.5 font-mono text-xs text-muted-foreground">
                          {host.origin}
                        </span>
                      </div>
                      <Button
                        size="sm"
                        className="h-7 shrink-0 px-2.5 text-xs"
                        onClick={() => void connectDiscovered(host)}
                        disabled={busy}
                      >
                        {busy ? (
                          <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
                        ) : null}
                        {t('webService.clientConnect')}
                      </Button>
                    </div>
                    {asking ? (
                      <div className="settings-host-row__detail">
                        <Label htmlFor={`lan-token-${key}`}>
                          {t('webService.clientCodeLabel')}
                        </Label>
                        <div className="flex gap-2">
                          <TextInput
                            label={t('webService.clientCodeLabel')}
                            isLabelHidden
                            value={token}
                            onChange={setToken}
                            placeholder={t('webService.clientCodePlaceholder')}
                            width="100%"
                            className="[&_input]:font-mono [&_input]:text-sm"
                          />
                          <Button
                            size="sm"
                            className="h-7 shrink-0 px-2.5 text-xs"
                            onClick={() => void connectDiscovered(host)}
                            disabled={busy}
                          >
                            {t('webService.clientConnect')}
                          </Button>
                        </div>
                      </div>
                    ) : null}
                  </div>
                );
              })
            )}
          </div>
        </div>
      </SettingsSection>

      {isSignedIn ? (
        <SettingsSection
          icon={Cloud}
          title={t('webService.accountHostsTitle')}
          action={
            <Button
              variant="outline"
              size="sm"
              className="h-8"
              onClick={() => void loadAccountHosts()}
              disabled={loadingAccountHosts}
            >
              {loadingAccountHosts ? (
                <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
              ) : (
                <RefreshCw className="mr-1 h-3.5 w-3.5" />
              )}
              {t('webService.accountHostsRefresh')}
            </Button>
          }
        >
          <div
            className="settings-bounded-list-container min-w-0 overflow-hidden rounded-lg border border-border bg-background/50"
            data-testid="account-hosts-list-container"
          >
            <div
              className="settings-bounded-list max-h-56 divide-y divide-border/60 overflow-y-auto"
              data-testid="account-hosts-scroll-box"
            >
              {accountHostsVisible.length === 0 ? (
                <p className="settings-pairing-devices__empty">
                  {t('webService.accountHostsEmpty')}
                </p>
              ) : (
                accountHostsVisible.map((host) => {
                  const key = `account:${host.hostId}`;
                  const busy = connectingKey === key;
                  const canConnect = host.online && host.endpoints.length > 0;
                  const primaryOrigin = host.endpoints[0]?.origin;
                  return (
                    <div
                      className="settings-host-row"
                      key={host.hostId}
                      data-testid={`account-host-row-${host.hostId}`}
                    >
                      <div className="settings-host-row__summary flex min-h-11 min-w-0 items-center justify-between gap-3 px-3 py-2">
                        <div className="flex min-w-0 flex-1 items-center gap-2 overflow-hidden">
                          <span
                            className={cn(
                              'h-2 w-2 shrink-0 rounded-full',
                              host.online
                                ? 'bg-success'
                                : 'bg-muted-foreground/40'
                            )}
                          />
                          <span className="max-w-[14rem] shrink-0 truncate text-xs font-medium text-foreground">
                            {host.hostName || host.hostId}
                          </span>
                          {primaryOrigin ? (
                            <span className="truncate rounded bg-muted px-1.5 py-0.5 font-mono text-xs text-muted-foreground">
                              {primaryOrigin}
                            </span>
                          ) : (
                            <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">
                              {host.online
                                ? t('webService.accountHostNoEndpoints')
                                : t('webService.accountHostOffline')}
                            </span>
                          )}
                        </div>
                        <Button
                          size="sm"
                          className="h-7 shrink-0 px-2.5 text-xs"
                          onClick={() => void connectAccountHost(host)}
                          disabled={!canConnect || connectingKey !== null}
                        >
                          {busy ? (
                            <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
                          ) : null}
                          {host.online
                            ? t('webService.clientConnect')
                            : t('webService.accountHostOffline')}
                        </Button>
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          </div>
        </SettingsSection>
      ) : null}

      {openProvisioner?.plugin.enabled ? (
        <SettingsSection icon={Laptop} title={openProvisioner.label}>
          {openProvisioner.surfaces.map((surface) => (
            <AppSurfaceHost
              key={`${surface.surfaceId}:${surface.generation}:${provisioners.surfaceReloadKey}`}
              descriptor={surface}
              enabled
              transport={provisioners.surfaceTransport}
            />
          ))}
        </SettingsSection>
      ) : null}

      <SettingsSection icon={Server} title={t('webService.savedTitle')}>
        <div
          className="settings-bounded-list-container min-w-0 overflow-hidden rounded-lg border border-border bg-background/50"
          data-testid="saved-hosts-list-container"
        >
          <div
            className="settings-bounded-list max-h-56 divide-y divide-border/60 overflow-y-auto"
            data-testid="saved-hosts-scroll-box"
          >
            {profiles.length === 0 ? (
              <p className="settings-pairing-devices__empty">
                {t('webService.savedEmpty')}
              </p>
            ) : (
              profiles.map((profile) => {
                const expanded = expandedId === profile.id;
                const asking = tokenFor === profile.id;
                const busy = connectingKey === profile.id;
                const isSsh = savedHostSource(profile.provision_kind) === 'ssh';
                const update = hostUpdates.find(
                  (item) =>
                    item.profile_id === profile.id && item.update_available
                );
                return (
                  <div
                    className={cn(
                      'settings-host-row',
                      profile.connected && 'is-connected',
                      expanded && 'is-expanded'
                    )}
                    key={profile.id}
                  >
                    <div className="settings-host-row__header">
                      <button
                        type="button"
                        className="settings-host-row__summary min-h-11 px-3 py-2"
                        aria-expanded={expanded}
                        onClick={() =>
                          setExpandedId((current) =>
                            current === profile.id ? null : profile.id
                          )
                        }
                      >
                        <div className="flex min-w-0 flex-1 items-center gap-2 overflow-hidden">
                          <span className="max-w-[14rem] shrink-0 truncate text-xs font-medium text-foreground">
                            {profile.name}
                          </span>
                          {profile.connected ? (
                            <span className="settings-status-success shrink-0 rounded px-1.5 py-0.5 text-xs font-medium">
                              {t('webService.connectedBadge')}
                            </span>
                          ) : null}
                          {provisionKindLabel(
                            profile.provision_kind,
                            provisioners.panels
                          ) ? (
                            <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">
                              {provisionKindLabel(
                                profile.provision_kind,
                                provisioners.panels
                              )}
                            </span>
                          ) : null}
                        </div>
                        <ChevronDown
                          className={cn(
                            'h-4 w-4 shrink-0 text-muted-foreground transition-transform duration-150 ease-out',
                            expanded && 'rotate-180'
                          )}
                          aria-hidden="true"
                        />
                      </button>
                      {update ? (
                        <button
                          type="button"
                          className="settings-host-row__update settings-status-pill-warning text-xs font-medium"
                          disabled={updatingId === profile.id}
                          onClick={() => {
                            void confirmHostUpdate(profile, update);
                          }}
                        >
                          {updatingId === profile.id ? (
                            <Loader2 className="h-3 w-3 animate-spin" />
                          ) : (
                            t('webService.hostUpdateAvailable')
                          )}
                        </button>
                      ) : null}
                    </div>
                    {expanded ? (
                      <div className="settings-host-row__detail">
                        <SavedHostFacts profile={profile} />
                        {hasRelayPermission && !isSsh && !profile.connected ? (
                          <div
                            data-testid={`saved-host-cloud-relay-row-${profile.id}`}
                            className="flex items-center justify-between gap-2 rounded-md border border-border/70 bg-muted/30 px-2.5 py-1.5"
                          >
                            <Label
                              htmlFor={`saved-host-use-cloud-relay-${profile.id}`}
                              className="text-xs font-medium"
                            >
                              {t('webService.useCloudRelayService')}
                            </Label>
                            <Switch
                              id={`saved-host-use-cloud-relay-${profile.id}`}
                              aria-label={t('webService.useCloudRelayService')}
                              checked={Boolean(
                                savedUseRelayById[profile.id] ??
                                  profile.origin.includes('/t/')
                              )}
                              onCheckedChange={(checked: boolean) =>
                                setSavedUseRelayById((prev) => ({
                                  ...prev,
                                  [profile.id]: checked,
                                }))
                              }
                            />
                          </div>
                        ) : null}
                        {asking ? (
                          <TextInput
                            label={t('webService.clientCodeLabel')}
                            isLabelHidden
                            value={token}
                            onChange={setToken}
                            placeholder={t('webService.clientCodePlaceholder')}
                            width="100%"
                            className="[&_input]:font-mono [&_input]:text-sm"
                          />
                        ) : null}
                        <div className="flex flex-wrap justify-end gap-1.5">
                          {profile.connected ? (
                            <Button
                              size="sm"
                              className="h-7 px-2.5 text-xs"
                              onClick={() => void disconnectHost()}
                            >
                              {t('webService.clientDisconnect')}
                            </Button>
                          ) : (
                            <Button
                              size="sm"
                              className="h-7 px-2.5 text-xs"
                              onClick={() => void connectSaved(profile)}
                              disabled={busy}
                            >
                              {busy ? (
                                <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
                              ) : null}
                              {connected
                                ? t('webService.switchHost')
                                : t('webService.clientConnect')}
                            </Button>
                          )}
                          <Button
                            variant="outline"
                            size="sm"
                            className="h-7 px-2.5 text-xs"
                            onClick={() => void deleteHost(profile)}
                          >
                            {t('webService.deleteHost')}
                          </Button>
                        </div>
                      </div>
                    ) : null}
                  </div>
                );
              })
            )}
          </div>
        </div>
      </SettingsSection>
    </div>
  );
}
