import {
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import { UNSAFE_NavigationContext } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import {
  Check,
  ChevronDown,
  Laptop,
  Link2,
  Loader2,
  LogOut,
  RefreshCw,
  Server,
  Settings,
  Terminal,
} from 'lucide-react';
import { TextInput } from '@astryxdesign/core/TextInput';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import { Switch } from '@/components/ui/switch';
import { toast } from '@/components/ui/toast';
import { AppSurfaceHost } from '@/components/plugins/AppSurfaceHost';
import {
  readHostBoundAccounts,
  reconcileRemoteHostAccount,
  resolveProfileBoundAccount,
  subscribeHostBoundAccounts,
  useDimoAccount,
} from '@/features/model-router';
import {
  hostClientApi,
  openSettingsSurface,
  type DiscoveredHost,
  type HostClientProfile,
} from '@/lib/api';
import { createBackendAppSurfaceTransport } from '@/lib/api/appSurfaceTransport';
import { createPluginControlApi } from '@/lib/api/plugins';
import { backendListen } from '@/lib/backendTransport';
import {
  type AccountDirectoryHost,
  exchangeHostAccessGrantOverHttp,
  getLastActiveWebHostId,
  getWebClientPublicKeyEd25519,
  getWebRememberHosts,
  listAccountDirectoryHosts,
  listSavedWebHosts,
  parsePairingInvitation,
  type ReachabilityEndpoint,
  requestHostAccessGrant,
  type SavedWebHost,
  selectBestEndpoint,
  subscribeWebHostStore,
  upsertSavedWebHost,
} from '@/lib/connectivity';
import { DesktopCapabilityError, isTauriClient } from '@/lib/desktopShell';
import { getSiteUrl } from '@/lib/branding';
import { getErrorMessage } from '@/lib/modals';
import {
  getBackendTransport,
  getLocalDesktopTransport,
  useBackendTransport,
  WebTransport,
} from '@/lib/transport';
import { cn } from '@/lib/utils';
import { looksLikeDimoHost } from '@/pages/settings/hostEndpoints';
import {
  localProvisionerSurfaces,
  prefillProvisionerSettings,
  provisionedHostPayload,
  provisionerForKind,
  type LocalProvisionerSurface,
} from '@/pages/settings/localProvisionerSurfaces';
import {
  savedHostAddress,
  savedHostOrigin,
  savedHostSource,
} from '@/pages/settings/savedHostAddress';
import {
  disconnectWebSession,
  getCurrentWebSessionHostId,
  redeemWebPairingToken,
  switchWebHost,
  switchWebSession,
} from '@/WebTransportBootstrap';

const REMOTE_CLIENT_SETTINGS_PATH = '/settings/web-service?role=client';
const REMOTE_SSH_SETTINGS_PATH = '/settings/web-service?role=client&action=ssh';

type ConnectDialogSeed = {
  origin: string;
  profileId?: string;
};

function useSafeNavigate(): (path: string) => void {
  const navContext = useContext(UNSAFE_NavigationContext);
  return useCallback(
    (path: string) => {
      if (navContext?.navigator) {
        navContext.navigator.push(path);
      } else if (typeof window !== 'undefined') {
        window.location.assign(path);
      }
    },
    [navContext]
  );
}

function isNeedsToken(error: unknown): boolean {
  return getErrorMessage(error).includes('needs_token');
}

function formatConnectError(
  error: unknown,
  fallback: string,
  loginRejected: string
): string {
  const message = getErrorMessage(error);
  if (/permission denied/i.test(message)) return loginRejected;
  const cleaned = message
    .replace(/^(internal error:\s*)+/i, '')
    .replace(/^(worker_request_failed:\s*)+/i, '')
    .replace(/^(worker_failed:\s*)+/i, '')
    .trim();
  return cleaned || fallback;
}

export function resolveCloudRelayTargetOrigin(
  rawOrigin: string,
  relayPublicOrigin: string,
  hostId?: string | null
): string {
  const baseRelay = relayPublicOrigin.trim().replace(/\/+$/, '');
  const trimmed = rawOrigin.trim();
  if (!baseRelay) return trimmed;
  const tunnelMatch = trimmed.match(/\/t\/([^/?#]+)/i);
  if (tunnelMatch?.[1]) {
    return `${baseRelay}/t/${tunnelMatch[1]}`;
  }
  const normalizedHostId = hostId?.trim() || '';
  if (normalizedHostId) {
    return `${baseRelay}/t/${encodeURIComponent(normalizedHostId)}`;
  }
  if (
    trimmed &&
    !trimmed.includes('://') &&
    !trimmed.includes(':') &&
    !trimmed.includes('.')
  ) {
    return `${baseRelay}/t/${encodeURIComponent(trimmed.replace(/^\/+/, ''))}`;
  }
  return trimmed;
}

function defaultHostNameFromOrigin(origin: string): string {
  try {
    const parsed = new URL(origin);
    return parsed.host || origin;
  } catch {
    return origin;
  }
}

function ConnectHostDialog({
  seed,
  profiles,
  onClose,
  onConnected,
}: {
  seed: ConnectDialogSeed;
  profiles: HostClientProfile[];
  onClose: () => void;
  onConnected: () => Promise<void>;
}) {
  const { t } = useTranslation(['panels', 'settings', 'common', 'app']);
  const { isSignedIn, overview } = useDimoAccount();
  const isDesktop = isTauriClient();
  const [origin, setOrigin] = useState(seed.origin);
  const [code, setCode] = useState('');
  const [useCloudRelay, setUseCloudRelay] = useState(() =>
    seed.origin.includes('/t/')
  );
  const [submitting, setSubmitting] = useState(false);
  const originInputRef = useRef<HTMLInputElement>(null);
  const codeInputRef = useRef<HTMLInputElement>(null);

  const parsedFromCode = useMemo(() => parsePairingInvitation(code), [code]);
  const parsedFromOrigin = useMemo(
    () => parsePairingInvitation(origin),
    [origin]
  );
  const parsedInvitation = parsedFromCode ?? parsedFromOrigin;
  const hasEmbeddedEndpoints = Boolean(
    parsedInvitation && parsedInvitation.endpoints.length > 0
  );

  const matchedProfile =
    (seed.profileId
      ? profiles.find((item) => item.id === seed.profileId)
      : undefined) ??
    profiles.find(
      (item) =>
        item.origin === origin.trim() || savedHostOrigin(item) === origin.trim()
    );
  const isSshProfile =
    savedHostSource(matchedProfile?.provision_kind) === 'ssh';
  const relayPublicOrigin =
    overview?.assignedRelayServer?.publicOrigin?.trim() || getSiteUrl();
  const canUseCloudRelay = Boolean(
    isSignedIn && overview?.relayPermission !== false && !isSshProfile
  );

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      if (seed.origin) {
        codeInputRef.current?.focus();
      } else {
        originInputRef.current?.focus();
      }
    });
    return () => window.cancelAnimationFrame(frame);
  }, [seed.origin]);

  const handleSubmit = async (event?: React.FormEvent) => {
    event?.preventDefault();
    const effectiveCode = (
      code.trim() || (parsedFromOrigin ? origin.trim() : '')
    ).trim();
    const rawOrigin =
      (parsedFromOrigin ? '' : origin.trim()) ||
      parsedInvitation?.endpoints[0]?.origin ||
      '';
    const trimmedOrigin =
      canUseCloudRelay && useCloudRelay
        ? resolveCloudRelayTargetOrigin(
            rawOrigin,
            relayPublicOrigin,
            matchedProfile?.host_id
          )
        : rawOrigin;
    if (!trimmedOrigin) {
      toast.error(
        t('settings:webService.clientOriginRequired', '请输入 Host 地址')
      );
      return;
    }

    if (
      !effectiveCode &&
      (!isDesktop ||
        !matchedProfile?.has_credential ||
        matchedProfile.needs_token)
    ) {
      toast.error(t('settings:webService.clientNeedsCode', '请输入连接码'));
      return;
    }

    setSubmitting(true);
    try {
      if (!isDesktop) {
        const invitationEndpoints: ReachabilityEndpoint[] =
          parsedInvitation?.endpoints ?? [];
        let targetOrigin = trimmedOrigin.replace(/\/+$/, '');
        let discoveredHostId = parsedInvitation?.hostId;
        let discoveredHostName: string | undefined;

        if (invitationEndpoints.length > 0) {
          const candidates: ReachabilityEndpoint[] =
            !parsedFromOrigin && origin.trim()
              ? [{ origin: targetOrigin }, ...invitationEndpoints]
              : invitationEndpoints;
          const probed = await selectBestEndpoint(candidates, {
            expectedHostId: parsedInvitation?.hostId,
            lastGoodOrigin: targetOrigin || undefined,
          });
          if (!probed) {
            throw new Error(t('app:webConnect.notAHost'));
          }
          targetOrigin = probed.origin;
          discoveredHostId = probed.hostId ?? discoveredHostId;
          discoveredHostName = probed.name;
        } else if (!(await looksLikeDimoHost(targetOrigin))) {
          throw new Error(t('app:webConnect.notAHost'));
        }

        let accessToken = effectiveCode;
        let deviceId: string | undefined;
        if (parsedInvitation) {
          const redeemed = await redeemWebPairingToken(
            targetOrigin,
            parsedInvitation.pairingToken,
            t('app:webConnect.authFailed'),
            (reason) => t('app:webConnect.e2eeRequired', { reason })
          );
          accessToken = redeemed.accessToken;
          deviceId = redeemed.deviceId;
        }

        if (getWebRememberHosts()) {
          const saved = await upsertSavedWebHost({
            id: discoveredHostId || targetOrigin,
            hostId: discoveredHostId,
            name: discoveredHostName || defaultHostNameFromOrigin(targetOrigin),
            origin: targetOrigin,
            endpoints:
              invitationEndpoints.length > 0
                ? [{ origin: targetOrigin }, ...invitationEndpoints]
                : [{ origin: targetOrigin }],
            lastGoodOrigin: targetOrigin,
            accessToken,
            deviceId,
            trustSource: 'paired',
            lastConnectedAt: new Date().toISOString(),
          });
          switchWebHost(saved.id);
        } else {
          switchWebSession({
            baseUrl: targetOrigin,
            token: accessToken,
            hostId: discoveredHostId,
            name: discoveredHostName || defaultHostNameFromOrigin(targetOrigin),
            trustSource: 'paired',
          });
        }
        onClose();
        return;
      }

      const result = await hostClientApi.connect({
        origin: trimmedOrigin,
        token: effectiveCode || undefined,
        profile_id: matchedProfile?.id,
        ...(parsedInvitation && parsedInvitation.endpoints.length > 0
          ? { endpoints: parsedInvitation.endpoints }
          : {}),
      });
      if (result.profile?.connected) {
        void reconcileRemoteHostAccount(result.profile);
      }
      await onConnected();
      if (result.profile.connected) {
        toast.success(t('settings:webService.clientConnected', '已连接'));
      }
      if (result.stopped_host) {
        toast.success(
          t(
            'settings:webService.stoppedHostForClient',
            '已停止本机远程连接服务'
          )
        );
      }
      onClose();
    } catch (error) {
      if (error instanceof DesktopCapabilityError) {
        toast.error(
          t(
            'toolbar.desktopOnlyHostConnect',
            '请在桌面端应用中连接或切换远程 Host'
          )
        );
        return;
      }
      if (isNeedsToken(error)) {
        toast.error(t('settings:webService.clientNeedsCode', '请输入连接码'));
        codeInputRef.current?.focus();
        return;
      }
      toast.error(
        formatConnectError(
          error,
          t('settings:webService.clientConnectFailed', '连接失败'),
          t(
            'settings:webService.sshLoginRejected',
            'SSH 拒绝登录。核对用户名、密码或密钥。'
          )
        )
      );
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog
      open
      onOpenChange={(nextOpen) => {
        if (!nextOpen && !submitting) onClose();
      }}
    >
      <DialogContent
        data-testid="connect-host-dialog"
        className="sm:max-w-[420px]"
      >
        <DialogHeader>
          <DialogTitle>
            {t('toolbar.connectHostDialogTitle', '连接远程 Host')}
          </DialogTitle>
          <DialogDescription>
            {t(
              'toolbar.connectHostDialogDescription',
              '输入目标 Host 的服务地址与连接码以建立加密连接。'
            )}
          </DialogDescription>
        </DialogHeader>

        <form
          onSubmit={(event) => void handleSubmit(event)}
          className="space-y-3.5"
        >
          <div className="space-y-1.5">
            <Label htmlFor="connect-host-origin">
              {t('settings:webService.manualOriginLabel', 'Host 地址')}
            </Label>
            <TextInput
              id="connect-host-origin"
              ref={originInputRef}
              label={t('settings:webService.manualOriginLabel', 'Host 地址')}
              isLabelHidden
              value={origin}
              onChange={setOrigin}
              placeholder={t(
                'settings:webService.manualOriginPlaceholder',
                '192.168.1.10:17891'
              )}
              width="100%"
              className="[&_input]:font-mono [&_input]:text-sm"
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="connect-host-code">
              {t('settings:webService.clientCodeLabel', '连接码')}
            </Label>
            <TextInput
              id="connect-host-code"
              ref={codeInputRef}
              label={t('settings:webService.clientCodeLabel', '连接码')}
              isLabelHidden
              value={code}
              onChange={setCode}
              placeholder={t('toolbar.connectCodePlaceholder')}
              width="100%"
              className="[&_input]:font-mono [&_input]:text-sm"
            />
            {hasEmbeddedEndpoints ? (
              <p className="text-xs text-success">
                {t('toolbar.pairingDetected')}
              </p>
            ) : null}
          </div>

          {canUseCloudRelay ? (
            <div
              data-testid="connect-host-cloud-relay-row"
              className="flex items-center justify-between gap-3 rounded-md border border-border/70 bg-muted/30 px-3 py-2"
            >
              <div className="min-w-0">
                <Label
                  htmlFor="connect-host-use-cloud-relay"
                  className="text-xs font-medium"
                >
                  {t('toolbar.useCloudRelayService', '使用云中继服务')}
                </Label>
                {overview?.assignedRelayServer?.name ? (
                  <p className="truncate text-xs text-muted-foreground">
                    {overview.assignedRelayServer.name}
                  </p>
                ) : null}
              </div>
              <Switch
                id="connect-host-use-cloud-relay"
                aria-label={t('toolbar.useCloudRelayService', '使用云中继服务')}
                checked={useCloudRelay}
                onCheckedChange={(checked: boolean) => {
                  setUseCloudRelay(checked);
                  if (checked && matchedProfile?.host_id) {
                    setOrigin(
                      resolveCloudRelayTargetOrigin(
                        origin,
                        relayPublicOrigin,
                        matchedProfile.host_id
                      )
                    );
                  }
                }}
              />
            </div>
          ) : null}

          <DialogFooter className="pt-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={onClose}
              disabled={submitting}
            >
              {t('common:cancel', '取消')}
            </Button>
            <Button
              type="submit"
              size="sm"
              data-dialog-primary="true"
              disabled={submitting}
            >
              {submitting ? (
                <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
              ) : null}
              {t('settings:webService.clientConnect', '连接')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function NewSshHostDialog({
  onClose,
  onFallbackToSettings,
}: {
  onClose: () => void;
  onFallbackToSettings: () => void;
}) {
  const { t } = useTranslation(['panels', 'common']);
  const contextTransport = useBackendTransport();
  const activeTransport = isTauriClient()
    ? getLocalDesktopTransport()
    : contextTransport;
  const pluginApi = useMemo(
    () => createPluginControlApi(activeTransport),
    [activeTransport]
  );
  const surfaceTransport = useMemo(
    () => createBackendAppSurfaceTransport(activeTransport),
    [activeTransport]
  );
  const [sshPanel, setSshPanel] = useState<LocalProvisionerSurface | null>(
    null
  );
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const [catalog, contributions] = await Promise.all([
          pluginApi.catalog(),
          pluginApi.contributionCatalog(),
        ]);
        let panels = localProvisionerSurfaces(catalog, contributions);
        let target = panels.find((item) => item.kind === 'ssh') ?? null;
        if (target && !target.plugin.enabled) {
          await pluginApi.setEnabled(target.plugin.id, true);
          const [nextCatalog, nextContributions] = await Promise.all([
            pluginApi.catalog(),
            pluginApi.contributionCatalog(),
          ]);
          panels = localProvisionerSurfaces(nextCatalog, nextContributions);
          target = panels.find((item) => item.kind === 'ssh') ?? null;
        }
        if (cancelled) return;
        if (!target) {
          onClose();
          onFallbackToSettings();
          return;
        }
        setSshPanel(target);
      } catch {
        if (!cancelled) {
          onClose();
          onFallbackToSettings();
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [onClose, onFallbackToSettings, pluginApi]);

  return (
    <Dialog
      open
      onOpenChange={(nextOpen) => {
        if (!nextOpen) onClose();
      }}
    >
      <DialogContent data-testid="new-ssh-host-dialog" className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>
            {t('toolbar.newSshHostDialogTitle', '新建 SSH Host')}
          </DialogTitle>
          <DialogDescription>
            {t(
              'toolbar.newSshHostDialogDescription',
              '通过 SSH 自动部署并连接到远程主机上的服务。'
            )}
          </DialogDescription>
        </DialogHeader>

        {loading ? (
          <div className="flex min-h-[240px] items-center justify-center">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        ) : sshPanel ? (
          <div className="min-w-0">
            {sshPanel.surfaces.map((surface) => (
              <AppSurfaceHost
                key={`${surface.surfaceId}:${surface.generation}`}
                descriptor={surface}
                enabled
                transport={surfaceTransport}
              />
            ))}
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

export function HostSelector() {
  const { t } = useTranslation(['panels', 'settings', 'common', 'app']);
  const { isSignedIn, user } = useDimoAccount();
  const isDesktop = isTauriClient();
  const boundAccounts = useSyncExternalStore(
    subscribeHostBoundAccounts,
    readHostBoundAccounts,
    readHostBoundAccounts
  );
  const navigate = useSafeNavigate();
  const [open, setOpen] = useState(false);
  const [profiles, setProfiles] = useState<HostClientProfile[]>([]);
  const [localHostId, setLocalHostId] = useState<string | null>(null);
  const [webHosts, setWebHosts] = useState<SavedWebHost[]>([]);
  const [activeWebHostId, setActiveWebHostId] = useState<string | null>(null);
  const [accountHosts, setAccountHosts] = useState<AccountDirectoryHost[]>([]);
  const [discovered, setDiscovered] = useState<DiscoveredHost[]>([]);
  const [scanning, setScanning] = useState(false);
  const [switchingKey, setSwitchingKey] = useState<string | null>(null);
  const [connectDialogSeed, setConnectDialogSeed] =
    useState<ConnectDialogSeed | null>(null);
  const [sshDialogOpen, setSshDialogOpen] = useState(false);

  const connectedProfile =
    profiles.find((profile) => profile.connected) ?? null;

  useEffect(() => {
    if (!connectedProfile?.connected) return;
    void reconcileRemoteHostAccount(connectedProfile);
  }, [connectedProfile]);

  const loadStatus = useCallback(async () => {
    if (!isTauriClient()) {
      const [saved, activeId] = await Promise.all([
        listSavedWebHosts(),
        getLastActiveWebHostId(),
      ]);
      setWebHosts(saved);
      setActiveWebHostId(activeId);
      return;
    }
    try {
      const status = await hostClientApi.status();
      setProfiles(status.profiles ?? []);
      setLocalHostId(status.local_host_id ?? null);
    } catch {
      // Ignore in web / non-desktop contexts.
    }
  }, []);

  const loadAccountDirectory = useCallback(async () => {
    if (!isSignedIn) {
      setAccountHosts([]);
      return;
    }
    const hosts = await listAccountDirectoryHosts();
    setAccountHosts(hosts);
  }, [isSignedIn]);

  const scanHosts = useCallback(async () => {
    if (!isTauriClient()) return;
    setScanning(true);
    try {
      const list = await hostClientApi.discover();
      setDiscovered(list ?? []);
    } catch {
      // Ignore discovery errors in selector.
    } finally {
      setScanning(false);
    }
  }, []);

  useEffect(() => {
    void loadStatus();
    if (!isTauriClient()) {
      return subscribeWebHostStore(() => {
        void loadStatus();
      });
    }
    let stop: (() => void) | undefined;
    let cancelled = false;
    void backendListen('host-client-changed', () => {
      if (!cancelled) void loadStatus();
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

  useEffect(() => {
    if (!open) return;
    void loadStatus();
    void scanHosts();
    void loadAccountDirectory();
  }, [loadAccountDirectory, loadStatus, open, scanHosts]);

  const handleSelectLocal = async () => {
    if (!connectedProfile) {
      setOpen(false);
      return;
    }
    setSwitchingKey('local');
    try {
      await hostClientApi.disconnect();
      await loadStatus();
      setOpen(false);
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : t('settings:webService.clientStatusFailed', '切换主机失败')
      );
    } finally {
      setSwitchingKey(null);
    }
  };

  const resolveProvisionerForProfile = useCallback(
    async (profile: HostClientProfile) => {
      const pluginApi = createPluginControlApi(getLocalDesktopTransport());
      const [catalog, contributions] = await Promise.all([
        pluginApi.catalog(),
        pluginApi.contributionCatalog(),
      ]);
      const panels = localProvisionerSurfaces(catalog, contributions);
      const provisioner = provisionerForKind(panels, profile.provision_kind);
      return { pluginApi, provisioner };
    },
    []
  );

  const handleSelectProfile = async (profile: HostClientProfile) => {
    if (profile.connected) {
      setOpen(false);
      return;
    }

    const source = savedHostSource(profile.provision_kind);
    const durableOrigin = savedHostOrigin(profile) || profile.origin;

    if (source !== 'ssh' && source !== 'other') {
      const matchingOnlineAccountHost =
        isSignedIn && profile.host_id
          ? (accountHosts.find(
              (host) =>
                host.hostId === profile.host_id &&
                host.online &&
                host.endpoints.length > 0
            ) ?? null)
          : null;

      const tryReconnectWithAccountGrant = async (): Promise<boolean> => {
        if (
          !matchingOnlineAccountHost ||
          typeof hostClientApi.identity !== 'function' ||
          typeof hostClientApi.connectWithGrant !== 'function'
        ) {
          return false;
        }
        try {
          const identity = await hostClientApi.identity();
          const grant = await requestHostAccessGrant({
            hostId: matchingOnlineAccountHost.hostId,
            clientPublicKeyEd25519: identity.publicKeyEd25519,
            clientKind: 'desktop',
            preset: 'workstation',
          });
          const result = await hostClientApi.connectWithGrant({
            hostId: matchingOnlineAccountHost.hostId,
            name: matchingOnlineAccountHost.hostName || profile.name,
            endpoints: matchingOnlineAccountHost.endpoints,
            grantToken: grant.grantToken,
          });
          if (result.profile?.connected) {
            void reconcileRemoteHostAccount(result.profile);
          }
          await loadStatus();
          setOpen(false);
          return true;
        } catch {
          return false;
        }
      };

      if (profile.needs_token || !profile.has_credential) {
        if (matchingOnlineAccountHost) {
          setSwitchingKey(profile.id);
          try {
            if (await tryReconnectWithAccountGrant()) {
              return;
            }
          } finally {
            setSwitchingKey(null);
          }
        }
        setOpen(false);
        setConnectDialogSeed({
          origin: durableOrigin,
          profileId: profile.id,
        });
        return;
      }

      setSwitchingKey(profile.id);
      try {
        const result = await hostClientApi.connect({
          profile_id: profile.id,
          origin: durableOrigin || undefined,
        });
        if (result.profile?.connected) {
          void reconcileRemoteHostAccount(result.profile);
        }
        await loadStatus();
        setOpen(false);
      } catch (error) {
        if (isNeedsToken(error) && (await tryReconnectWithAccountGrant())) {
          return;
        }
        setOpen(false);
        if (isNeedsToken(error)) {
          setConnectDialogSeed({
            origin: durableOrigin,
            profileId: profile.id,
          });
        } else {
          toast.error(
            formatConnectError(
              error,
              t('settings:webService.clientConnectFailed', '连接失败'),
              t(
                'settings:webService.sshLoginRejected',
                'SSH 拒绝登录。核对用户名、密码或密钥。'
              )
            )
          );
          openSettingsSurface(navigate, REMOTE_CLIENT_SETTINGS_PATH);
        }
      } finally {
        setSwitchingKey(null);
      }
      return;
    }

    setSwitchingKey(profile.id);
    let resolvedPluginApi: ReturnType<typeof createPluginControlApi> | null =
      null;
    let resolvedProvisioner: LocalProvisionerSurface | null = null;
    try {
      const { pluginApi, provisioner } =
        await resolveProvisionerForProfile(profile);
      resolvedPluginApi = pluginApi;
      resolvedProvisioner = provisioner;

      let origin = durableOrigin;
      if (provisioner?.handler) {
        if (!provisioner.plugin.enabled) {
          await pluginApi.setEnabled(provisioner.plugin.id, true);
        }
        const ensured = (await pluginApi.invokeContribution(
          provisioner.plugin.id,
          provisioner.handler,
          { profile: provisionedHostPayload(profile) },
          provisioner.timeoutSeconds
        )) as { origin?: unknown };
        const ensuredOrigin =
          typeof ensured?.origin === 'string' ? ensured.origin.trim() : '';
        if (ensuredOrigin) {
          origin = ensuredOrigin;
        }
      }

      const result = await hostClientApi.connect({
        profile_id: profile.id,
        origin: origin || undefined,
      });
      if (result.profile?.connected) {
        void reconcileRemoteHostAccount(result.profile);
      }
      await loadStatus();
      setOpen(false);
    } catch (error) {
      setOpen(false);
      if (source === 'ssh') {
        if (resolvedPluginApi && resolvedProvisioner) {
          await prefillProvisionerSettings(
            resolvedPluginApi,
            resolvedProvisioner.plugin.id,
            profile
          );
        }
        if (!isNeedsToken(error)) {
          toast.error(
            formatConnectError(
              error,
              t('settings:webService.clientConnectFailed', '连接失败'),
              t(
                'settings:webService.sshLoginRejected',
                'SSH 拒绝登录。核对用户名、密码或密钥。'
              )
            )
          );
        }
        setSshDialogOpen(true);
      } else if (isNeedsToken(error)) {
        setConnectDialogSeed({
          origin: durableOrigin,
          profileId: profile.id,
        });
      } else {
        openSettingsSurface(navigate, REMOTE_CLIENT_SETTINGS_PATH);
      }
    } finally {
      setSwitchingKey(null);
    }
  };

  const handleSelectDiscovered = async (host: DiscoveredHost) => {
    const key = host.host_id || host.origin;
    setSwitchingKey(key);
    try {
      const result = await hostClientApi.connect({ origin: host.origin });
      if (result.profile?.connected) {
        void reconcileRemoteHostAccount(result.profile);
      }
      await loadStatus();
      setOpen(false);
    } catch (error) {
      setOpen(false);
      if (isNeedsToken(error)) {
        setConnectDialogSeed({ origin: host.origin });
      } else {
        openSettingsSurface(navigate, REMOTE_CLIENT_SETTINGS_PATH);
      }
    } finally {
      setSwitchingKey(null);
    }
  };

  const handleConnectAccountHost = async (host: AccountDirectoryHost) => {
    const key = `account:${host.hostId}`;
    setSwitchingKey(key);
    try {
      if (isDesktop) {
        if (
          typeof hostClientApi.identity !== 'function' ||
          typeof hostClientApi.connectWithGrant !== 'function'
        ) {
          throw new Error(t('toolbar.desktopOnlyHostConnect'));
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
        await loadStatus();
        toast.success(t('settings:webService.clientConnected', '已连接'));
        setOpen(false);
        return;
      }

      if (host.endpoints.length === 0) {
        throw new Error(t('app:webConnect.noReachableEndpoints'));
      }
      const probed = await selectBestEndpoint(host.endpoints, {
        expectedHostId: host.hostId,
      });
      if (!probed) {
        throw new Error(t('app:webConnect.endpointUnreachable'));
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
        deviceName: 'Dimo Web',
        clientKind: 'web',
        preset: 'workstation',
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
        switchWebHost(saved.id);
      } else {
        switchWebSession({
          baseUrl: probed.origin,
          token: credential.accessToken,
          hostId: host.hostId,
          name: host.hostName || probed.name || host.hostId,
          trustSource: 'account_linked',
        });
      }
      setOpen(false);
    } catch (error) {
      toast.error(
        formatConnectError(
          error,
          t('settings:webService.clientConnectFailed', '连接失败'),
          t(
            'settings:webService.sshLoginRejected',
            'SSH 拒绝登录。核对用户名、密码或密钥。'
          )
        )
      );
    } finally {
      setSwitchingKey(null);
    }
  };

  const handleOpenConnectHost = () => {
    setOpen(false);
    setConnectDialogSeed({ origin: '' });
  };

  const handleOpenNewSshHost = () => {
    setOpen(false);
    setSshDialogOpen(true);
  };

  const handleManageRemoteConnections = () => {
    setOpen(false);
    openSettingsSurface(
      navigate,
      isDesktop ? REMOTE_CLIENT_SETTINGS_PATH : '/settings/web-service'
    );
  };

  const unsavedDiscovered = discovered.filter(
    (host) =>
      !profiles.some(
        (profile) =>
          (host.host_id && profile.host_id === host.host_id) ||
          savedHostOrigin(profile) === host.origin ||
          profile.origin === host.origin
      )
  );

  const activeWebTransport = !isDesktop ? getBackendTransport() : null;
  const currentWebOrigin =
    activeWebTransport instanceof WebTransport ? activeWebTransport.origin : '';
  const currentWebSessionHostId = !isDesktop
    ? getCurrentWebSessionHostId()
    : null;

  const activeWebHost = useMemo(() => {
    if (isDesktop) return null;
    if (activeWebHostId) {
      const byId = webHosts.find((h) => h.id === activeWebHostId);
      if (byId) return byId;
    }
    if (currentWebOrigin) {
      const clean = currentWebOrigin.replace(/\/+$/, '');
      return (
        webHosts.find(
          (h) =>
            h.origin.replace(/\/+$/, '') === clean ||
            h.lastGoodOrigin?.replace(/\/+$/, '') === clean
        ) ?? null
      );
    }
    return null;
  }, [activeWebHostId, currentWebOrigin, isDesktop, webHosts]);

  const unconnectedAccountHosts = accountHosts.filter((host) =>
    isDesktop
      ? (!localHostId || host.hostId !== localHostId) &&
        !profiles.some((profile) => profile.host_id === host.hostId)
      : host.hostId !== currentWebSessionHostId &&
        host.hostId !== activeWebHost?.hostId &&
        host.hostId !== activeWebHost?.id &&
        !webHosts.some(
          (saved) => saved.hostId === host.hostId || saved.id === host.hostId
        )
  );

  const currentLabel = isDesktop
    ? connectedProfile
      ? connectedProfile.name || savedHostAddress(connectedProfile)
      : t('toolbar.localHost', 'Local Host')
    : activeWebHost?.name ||
      currentWebOrigin.replace(/^https?:\/\//, '') ||
      t('toolbar.webHost', 'Web Host');

  return (
    <>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button
            type="button"
            data-testid="toolbar-host-selector"
            data-basic-guide="toolbar-host-selector"
            aria-label={t('toolbar.selectHost', '切换运行主机')}
            aria-expanded={open}
            className={cn(
              'workspace-toolbar-button flex h-7 items-center gap-1.5 rounded-md px-2 text-xs font-medium transition-colors',
              'hover:bg-foreground/[0.06] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring'
            )}
          >
            <span className="relative flex h-3.5 w-3.5 shrink-0 items-center justify-center">
              {connectedProfile || !isDesktop ? (
                <Server className="h-3.5 w-3.5 text-primary" />
              ) : (
                <Laptop className="h-3.5 w-3.5 opacity-80" />
              )}
              <span className="-bottom-0.5 -right-0.5 absolute h-1.5 w-1.5 rounded-full bg-success" />
            </span>
            <span className="max-w-32 truncate">{currentLabel}</span>
            <ChevronDown className="h-3 w-3 shrink-0 opacity-60" />
          </button>
        </PopoverTrigger>

        <PopoverContent
          align="start"
          sideOffset={6}
          data-testid="host-selector-popover"
          className="w-[372px] max-w-[calc(100vw-1.5rem)] overflow-hidden rounded-lg border border-border/80 p-0 shadow-xl"
        >
          <div
            data-testid="host-selector-actions"
            className="flex items-center gap-1 border-b border-border/60 p-1.5"
          >
            <button
              type="button"
              data-testid="host-selector-connect-host"
              onClick={handleOpenConnectHost}
              className="flex h-7 min-w-0 flex-1 cursor-pointer items-center justify-center gap-1.5 whitespace-nowrap rounded-md px-2 text-xs font-medium text-foreground/80 transition-colors hover:bg-foreground/[0.06] hover:text-foreground active:bg-foreground/[0.1] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            >
              <Link2 className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
              <span className="truncate">
                {t('toolbar.connectHost', '连接 Host')}
              </span>
            </button>

            {isDesktop ? (
              <button
                type="button"
                data-testid="host-selector-new-ssh-host"
                onClick={handleOpenNewSshHost}
                className="flex h-7 min-w-0 flex-1 cursor-pointer items-center justify-center gap-1.5 whitespace-nowrap rounded-md px-2 text-xs font-medium text-foreground/80 transition-colors hover:bg-foreground/[0.06] hover:text-foreground active:bg-foreground/[0.1] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              >
                <Terminal className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                <span className="truncate">
                  {t('toolbar.newSshHost', '新建 SSH Host')}
                </span>
              </button>
            ) : (
              <button
                type="button"
                data-testid="host-selector-disconnect-web"
                onClick={() => {
                  setOpen(false);
                  disconnectWebSession();
                }}
                className="flex h-7 min-w-0 flex-1 cursor-pointer items-center justify-center gap-1.5 whitespace-nowrap rounded-md px-2 text-xs font-medium text-foreground/80 transition-colors hover:bg-destructive/10 hover:text-destructive active:bg-destructive/15 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              >
                <LogOut className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                <span className="truncate">
                  {t('toolbar.disconnectHost', '断开连接')}
                </span>
              </button>
            )}

            <button
              type="button"
              data-testid="host-selector-manage-remote"
              onClick={handleManageRemoteConnections}
              className="flex h-7 min-w-0 flex-1 cursor-pointer items-center justify-center gap-1.5 whitespace-nowrap rounded-md px-2 text-xs font-medium text-foreground/80 transition-colors hover:bg-foreground/[0.06] hover:text-foreground active:bg-foreground/[0.1] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            >
              <Settings className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
              <span className="truncate">
                {t('toolbar.manageRemoteConnections', '管理远程连接')}
              </span>
            </button>
          </div>

          <div className="max-h-[min(360px,calc(100vh-8rem))] space-y-0.5 overflow-y-auto p-1.5">
            <div className="flex items-center justify-between px-2 py-1 text-xs font-medium text-muted-foreground">
              <span>{t('toolbar.hostSectionTitle', '运行主机 (Host)')}</span>
              {isDesktop || isSignedIn ? (
                <button
                  type="button"
                  data-testid="host-selector-refresh"
                  onClick={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    void scanHosts();
                    void loadAccountDirectory();
                  }}
                  className="cursor-pointer rounded p-0.5 text-muted-foreground transition-colors hover:bg-foreground/[0.08] hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                  aria-label={t('toolbar.refreshHosts')}
                  title={t('toolbar.refreshHosts')}
                >
                  <RefreshCw
                    className={cn('h-3 w-3', scanning && 'animate-spin')}
                  />
                </button>
              ) : null}
            </div>

            {isDesktop ? (
              <>
                <button
                  type="button"
                  data-testid="host-selector-item-local"
                  onClick={() => void handleSelectLocal()}
                  className={cn(
                    'flex w-full cursor-pointer items-center justify-between gap-2 rounded-md px-2 py-1.5 text-left text-xs transition-colors',
                    !connectedProfile
                      ? 'bg-foreground/[0.05] text-foreground'
                      : 'text-foreground/90 hover:bg-foreground/[0.06]'
                  )}
                >
                  <div className="flex min-w-0 items-center gap-2.5">
                    <Laptop className="h-3.5 w-3.5 shrink-0 text-success" />
                    <div className="min-w-0">
                      <div className="flex min-w-0 items-center gap-1.5">
                        <span className="truncate font-medium">
                          {t('toolbar.localHost', 'Local Host')}
                        </span>
                        <span
                          data-testid="host-selector-local-badge"
                          className="inline-flex shrink-0 items-center rounded bg-foreground/[0.08] px-1.5 py-0.5 text-2xs font-medium leading-none text-muted-foreground"
                        >
                          {t('toolbar.localBadge', '本地')}
                        </span>
                      </div>
                      <div className="truncate font-mono text-2xs text-muted-foreground">
                        127.0.0.1
                      </div>
                    </div>
                  </div>
                  {switchingKey === 'local' ? (
                    <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-muted-foreground" />
                  ) : !connectedProfile ? (
                    <Check className="h-3.5 w-3.5 shrink-0 text-primary" />
                  ) : null}
                </button>

                {profiles.map((profile) => {
                  const boundAccount = resolveProfileBoundAccount(
                    profile,
                    boundAccounts
                  );
                  const isDifferentAccountOwner = Boolean(
                    boundAccount?.username &&
                      (!user?.username ||
                        boundAccount.username.toLowerCase() !==
                          user.username.toLowerCase())
                  );
                  return (
                    <button
                      key={profile.id}
                      type="button"
                      data-testid={`host-selector-item-${profile.id}`}
                      onClick={() => void handleSelectProfile(profile)}
                      className={cn(
                        'flex w-full cursor-pointer items-center justify-between gap-2 rounded-md px-2 py-1.5 text-left text-xs transition-colors',
                        profile.connected
                          ? 'bg-foreground/[0.05] text-foreground'
                          : 'text-foreground/90 hover:bg-foreground/[0.06]'
                      )}
                    >
                      <div className="flex min-w-0 items-center gap-2.5">
                        {savedHostSource(profile.provision_kind) === 'ssh' ? (
                          <Terminal className="h-3.5 w-3.5 shrink-0 text-primary" />
                        ) : (
                          <Server className="h-3.5 w-3.5 shrink-0 text-primary" />
                        )}
                        <div className="min-w-0">
                          <div className="flex min-w-0 items-center gap-1.5">
                            <span className="truncate font-medium">
                              {profile.name || savedHostAddress(profile)}
                            </span>
                            {isDifferentAccountOwner && boundAccount ? (
                              <span
                                data-testid={`host-selector-bound-account-${profile.id}`}
                                className="inline-flex shrink-0 items-center gap-1 rounded-full border border-border/80 bg-muted/70 px-1.5 py-0.5 text-2xs font-medium text-foreground/90"
                                title={`${boundAccount.displayName || boundAccount.username} (@${boundAccount.username})`}
                              >
                                {boundAccount.avatarUrl ? (
                                  <img
                                    src={boundAccount.avatarUrl}
                                    alt={
                                      boundAccount.displayName ||
                                      boundAccount.username
                                    }
                                    className="h-3.5 w-3.5 rounded-full object-cover"
                                  />
                                ) : (
                                  <span className="inline-flex h-3.5 w-3.5 items-center justify-center rounded-full bg-primary/15 text-2xs font-semibold text-primary">
                                    {(
                                      boundAccount.displayName ||
                                      boundAccount.username
                                    )
                                      .slice(0, 1)
                                      .toUpperCase()}
                                  </span>
                                )}
                                <span className="max-w-[5.5rem] truncate">
                                  {boundAccount.displayName ||
                                    boundAccount.username}
                                </span>
                              </span>
                            ) : null}
                          </div>
                          <div className="truncate font-mono text-2xs text-muted-foreground">
                            {savedHostAddress(profile)}
                          </div>
                        </div>
                      </div>
                      {switchingKey === profile.id ? (
                        <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-muted-foreground" />
                      ) : profile.connected ? (
                        <Check className="h-3.5 w-3.5 shrink-0 text-primary" />
                      ) : null}
                    </button>
                  );
                })}
              </>
            ) : (
              <>
                {!activeWebHost && currentWebOrigin ? (
                  <div
                    data-testid="host-selector-web-current-session"
                    className="flex w-full items-center justify-between gap-2 rounded-md bg-foreground/[0.05] px-2 py-1.5 text-left text-xs text-foreground"
                  >
                    <div className="flex min-w-0 items-center gap-2.5">
                      <Server className="h-3.5 w-3.5 shrink-0 text-primary" />
                      <div className="min-w-0">
                        <div className="flex min-w-0 items-center gap-1.5">
                          <span className="truncate font-medium">
                            {currentLabel}
                          </span>
                          <span className="inline-flex shrink-0 items-center rounded bg-foreground/[0.08] px-1.5 py-0.5 text-2xs font-medium leading-none text-muted-foreground">
                            {t('toolbar.currentSession')}
                          </span>
                        </div>
                        <div className="truncate font-mono text-2xs text-muted-foreground">
                          {currentWebOrigin}
                        </div>
                      </div>
                    </div>
                    <Check className="h-3.5 w-3.5 shrink-0 text-primary" />
                  </div>
                ) : null}
                {webHosts.map((host) => {
                  const isActive = activeWebHost?.id === host.id;
                  return (
                    <button
                      key={host.id}
                      type="button"
                      data-testid={`host-selector-web-item-${host.id}`}
                      onClick={() => {
                        setOpen(false);
                        if (!isActive) switchWebHost(host.id);
                      }}
                      className={cn(
                        'flex w-full cursor-pointer items-center justify-between gap-2 rounded-md px-2 py-1.5 text-left text-xs transition-colors',
                        isActive
                          ? 'bg-foreground/[0.05] text-foreground'
                          : 'text-foreground/90 hover:bg-foreground/[0.06]'
                      )}
                    >
                      <div className="flex min-w-0 items-center gap-2.5">
                        <Server className="h-3.5 w-3.5 shrink-0 text-primary" />
                        <div className="min-w-0">
                          <div className="truncate font-medium">
                            {host.name}
                          </div>
                          <div className="truncate font-mono text-2xs text-muted-foreground">
                            {host.lastGoodOrigin || host.origin}
                          </div>
                        </div>
                      </div>
                      {isActive ? (
                        <Check className="h-3.5 w-3.5 shrink-0 text-primary" />
                      ) : null}
                    </button>
                  );
                })}
              </>
            )}

            {unconnectedAccountHosts.length > 0 ? (
              <>
                <div className="my-1 h-px bg-border/60" />
                <div className="px-2 py-1 text-xs font-medium text-muted-foreground">
                  {t('toolbar.accountHosts', '我的账号主机')}
                </div>
                {unconnectedAccountHosts.map((host) => {
                  const key = `account:${host.hostId}`;
                  const canConnect = host.online && host.endpoints.length > 0;
                  return (
                    <button
                      key={host.hostId}
                      type="button"
                      data-testid={`host-selector-account-${host.hostId}`}
                      disabled={!canConnect || switchingKey !== null}
                      onClick={() => void handleConnectAccountHost(host)}
                      className="flex w-full cursor-pointer items-center justify-between gap-2 rounded-md px-2 py-1.5 text-left text-xs text-foreground/90 transition-colors hover:bg-foreground/[0.06] disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      <div className="flex min-w-0 items-center gap-2.5">
                        <span
                          className={cn(
                            'h-2 w-2 shrink-0 rounded-full',
                            host.online
                              ? 'bg-success'
                              : 'bg-muted-foreground/40'
                          )}
                        />
                        <div className="min-w-0">
                          <div className="truncate font-medium">
                            {host.hostName}
                          </div>
                          <div className="truncate font-mono text-2xs text-muted-foreground">
                            {host.endpoints[0]?.origin || host.hostId}
                          </div>
                        </div>
                      </div>
                      {switchingKey === key ? (
                        <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-muted-foreground" />
                      ) : canConnect ? (
                        <span className="shrink-0 text-2xs font-medium text-primary">
                          {t('toolbar.oneClickConnect', '连接')}
                        </span>
                      ) : (
                        <span className="shrink-0 text-2xs text-muted-foreground">
                          {t('toolbar.offline')}
                        </span>
                      )}
                    </button>
                  );
                })}
              </>
            ) : null}

            {isDesktop && unsavedDiscovered.length > 0 ? (
              <>
                <div className="my-1 h-px bg-border/60" />
                <div className="px-2 py-1 text-xs font-medium text-muted-foreground">
                  {t('toolbar.discoveredHosts', '局域网发现的主机')}
                </div>
                {unsavedDiscovered.map((host) => {
                  const key = host.host_id || host.origin;
                  return (
                    <button
                      key={key}
                      type="button"
                      data-testid={`host-selector-discovered-${key}`}
                      onClick={() => void handleSelectDiscovered(host)}
                      className="flex w-full cursor-pointer items-center justify-between gap-2 rounded-md px-2 py-1.5 text-left text-xs text-foreground/90 transition-colors hover:bg-foreground/[0.06]"
                    >
                      <div className="flex min-w-0 items-center gap-2.5">
                        <Server className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                        <div className="min-w-0">
                          <div className="truncate font-medium">
                            {host.name || host.origin}
                          </div>
                          <div className="truncate font-mono text-2xs text-muted-foreground">
                            {host.origin}
                          </div>
                        </div>
                      </div>
                      {switchingKey === key ? (
                        <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-muted-foreground" />
                      ) : null}
                    </button>
                  );
                })}
              </>
            ) : null}
          </div>
        </PopoverContent>
      </Popover>

      {connectDialogSeed ? (
        <ConnectHostDialog
          seed={connectDialogSeed}
          profiles={profiles}
          onClose={() => setConnectDialogSeed(null)}
          onConnected={loadStatus}
        />
      ) : null}

      {sshDialogOpen ? (
        <NewSshHostDialog
          onClose={() => setSshDialogOpen(false)}
          onFallbackToSettings={() =>
            openSettingsSurface(navigate, REMOTE_SSH_SETTINGS_PATH)
          }
        />
      ) : null}
    </>
  );
}
