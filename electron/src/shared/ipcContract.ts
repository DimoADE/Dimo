export const DESKTOP_APP_SCHEME = 'dimo-app';
export const DESKTOP_ASSET_SCHEME = 'dimo-asset';
export const DESKTOP_APP_ORIGIN = `${DESKTOP_APP_SCHEME}://localhost`;
export const DEFAULT_APP_USER_MODEL_ID = 'com.dimo.app';
export const SIDECAR_EXITED_EVENT = 'sidecar-exited';
export const SIDECAR_RESTARTED_EVENT = 'sidecar-restarted';
export const GPU_MODE_CHANGED_EVENT = 'gpu-mode-changed';
export const DEVELOPER_MODE_CHANGED_EVENT = 'developer-mode-changed';
export const SYSTEM_POWER_RESUMED_EVENT = 'system-power-resumed';

export type SidecarRuntimeStatus = 'running' | 'restarting' | 'stopped';
export type DesktopGpuMode = 'hardware' | 'software';

export interface ElectronBackendConnectionInfo {
  baseUrl: string;
  token: string;
  dataDir?: string;
}

export interface SidecarRestartedPayload {
  backend: ElectronBackendConnectionInfo;
  attempt?: number;
}

export interface BootstrapPayload {
  windowLabel: string;
  platform: NodeJS.Platform;
  appVersion: string;
  backend: ElectronBackendConnectionInfo | null;
  sidecarStatus?: SidecarRuntimeStatus;
  gpuMode?: DesktopGpuMode;
  developerMode?: boolean;
  isDev?: boolean;
}

export const IPC_CHANNELS = {
  BOOTSTRAP_SYNC: 'dimo:bootstrap:sync',
  APP_VERSION: 'dimo:app:version',
  WINDOW_MINIMIZE: 'dimo:window:minimize',
  WINDOW_TOGGLE_MAXIMIZE: 'dimo:window:toggleMaximize',
  WINDOW_IS_MAXIMIZED: 'dimo:window:isMaximized',
  WINDOW_CLOSE: 'dimo:window:close',
  WINDOW_SHOW: 'dimo:window:show',
  WINDOW_HIDE: 'dimo:window:hide',
  WINDOW_SET_FOCUS: 'dimo:window:setFocus',
  WINDOW_SET_TITLE: 'dimo:window:setTitle',
  WINDOW_START_DRAGGING: 'dimo:window:startDragging',
  WINDOW_SET_ZOOM: 'dimo:window:setZoom',
  WINDOW_RESIZED: 'dimo:window:resized',
  DESKTOP_TOAST_SET_IGNORE_MOUSE_EVENTS: 'dimo:desktopToast:setIgnoreMouseEvents',
  DESKTOP_TOAST_SET_CONTENT_HEIGHT: 'dimo:desktopToast:setContentHeight',
  DIALOG_OPEN: 'dimo:dialog:open',
  DIALOG_SAVE: 'dimo:dialog:save',
  FS_READ_FILE: 'dimo:fs:readFile',
  FS_WRITE_FILE: 'dimo:fs:writeFile',
  FS_WRITE_TEXT_FILE: 'dimo:fs:writeTextFile',
  PATH_JOIN: 'dimo:path:join',
  SHELL_OPEN_EXTERNAL: 'dimo:shell:openExternal',
  EVENTS_EMIT: 'dimo:events:emit',
  EVENTS_MESSAGE: 'dimo:events:message',
  UPDATER_CHECK: 'dimo:updater:check',
  UPDATER_DOWNLOAD: 'dimo:updater:download',
  UPDATER_INSTALL: 'dimo:updater:install',
  UPDATER_CLOSE: 'dimo:updater:close',
  UPDATER_DOWNLOAD_EVENT: 'dimo:updater:downloadEvent',
  UPDATER_RELAUNCH: 'dimo:updater:relaunch',
  SHELL_INVOKE: 'dimo:shell:invoke',
} as const;

export interface DesktopUpdateCheckResult {
  token: string;
  version: string;
  currentVersion: string;
  body?: string | null;
  date?: string | null;
}

export interface DesktopUpdateDownloadEventPayload {
  token: string;
  event: 'Started' | 'Progress' | 'Finished';
  data?: {
    contentLength?: number;
    chunkLength?: number;
  };
}

/**
 * Desktop business commands migrated to `crates/server/src/desktop/routes.rs`
 * and served via `POST /api/v1/desktop/invoke/{command}`.
 */
export const SERVER_DESKTOP_COMMANDS = new Set<string>([
  'plugin_dev_connection',
  'evacuate_user_data_before_update',
  'record_shell_crash',
  // Backup
  'backup_create',
  'backup_inspect',
  'backup_restore_stage',
  'backup_cancel',
  // Web service & device pairing
  'get_web_service_config',
  'update_web_service_config',
  'get_web_server_status',
  'start_web_server',
  'stop_web_server',
  'probe_web_service_port',
  'generate_web_service_token',
  'create_host_device_pairing',
  'list_host_devices',
  'list_host_connect_requests',
  'respond_host_connect_request',
  'revoke_host_device',
  'revoke_account_linked_devices',
  // Host tunnel
  'get_host_tunnel',
  'set_host_tunnel_enabled',
  'check_existing_host_tunnel',
  'select_saved_host_tunnel',
  'start_create_host_tunnel',
  'confirm_create_host_tunnel',
  'cancel_create_host_tunnel',
  'remove_saved_host_tunnel',
  'set_account_relay_lease',
  'reconnect_host_tunnel',
  // Remote desktop proxy
  'remote_desktop_connect',
  'remote_desktop_disconnect',
  'remote_desktop_call',
  'remote_desktop_capabilities',
  'remote_desktop_listen',
  'remote_desktop_subscribe',
  'remote_desktop_cancel_subscription',
  // Host client
  'host_client_status',
  'host_client_discover',
  'host_client_host_updates',
  'host_client_apply_host_update',
  'host_client_connect',
  'host_client_disconnect',
  'host_client_delete',
  'host_client_set_sync_account',
  'host_client_export_sync_profiles',
  'host_client_merge_sync_profiles',
  'host_client_mark_sync_pushed',
  'host_client_ack_sync_deletes',
  // Editor & external terminal launchers
  'open_project_in_editor',
  'open_repo_in_editor',
  'open_workspace_in_editor',
  'open_in_editor',
  'open_external_terminal',
]);

/**
 * Commands whose side effects mutate host client window bindings or saved
 * profiles and should broadcast `host-client-changed` across Electron windows.
 */
export const HOST_CLIENT_MUTATING_COMMANDS = new Set<string>([
  'host_client_connect',
  'host_client_disconnect',
  'host_client_delete',
  'host_client_set_sync_account',
  'host_client_merge_sync_profiles',
]);

export interface DesktopToastPayload {
  projectId: string;
  workspaceId: string;
  sessionId: string;
  title: string;
  description: string;
  kind: string;
  durationMs?: number | null;
}

export interface PendingModelRouterImport {
  id: number;
  ticket: string;
  agentId: string | null;
}

export interface HostClientProfileView {
  id: string;
  name: string;
}

export function hostWindowLabel(profileId: string): string {
  const safe = Array.from(profileId)
    .map((ch) => (/^[A-Za-z0-9_-]$/.test(ch) ? ch : '-'))
    .join('');
  return `host-${safe}`;
}

export function hostSettingsWindowLabel(profileId: string): string {
  return `settings-${hostWindowLabel(profileId)}`;
}

export function isHostWindowLabel(label: string): boolean {
  return label.startsWith('host-') && label.length > 'host-'.length;
}

export function isHostSettingsWindowLabel(label: string): boolean {
  return (
    label.startsWith('settings-') &&
    isHostWindowLabel(label.slice('settings-'.length))
  );
}

export function hostAppWindowLabel(windowLabel: string): string | null {
  if (isHostWindowLabel(windowLabel)) {
    return windowLabel;
  }
  if (isHostSettingsWindowLabel(windowLabel)) {
    return windowLabel.slice('settings-'.length);
  }
  return null;
}

export function hostSettingsWindowForApp(hostLabel: string): string | null {
  if (!isHostWindowLabel(hostLabel)) {
    return null;
  }
  return `settings-${hostLabel}`;
}

export function settingsWindowLabelForCaller(callerLabel: string): string {
  const host = hostAppWindowLabel(callerLabel);
  return host ? `settings-${host}` : 'settings';
}

export function isLocalDesktopWindowLabel(label: string): boolean {
  return label !== 'desktop-toast' && hostAppWindowLabel(label) === null;
}

export function hostWindowTitle(name: string): string {
  const trimmed = name.trim();
  return trimmed.length === 0 ? 'Dimo' : `Dimo — ${trimmed}`;
}

/**
 * Converts a local filesystem path into a `dimo-asset://localhost/...` URL
 * while preserving `/` path separators so relative URLs inside HTML previews
 * resolve naturally under Chromium's standard URL parser.
 */
export function convertFileSrcToAssetUrl(
  filePath: string,
  protocol = DESKTOP_ASSET_SCHEME
): string {
  const scheme = protocol === 'asset' ? DESKTOP_ASSET_SCHEME : protocol;
  let normalized = filePath.trim();
  if (/^\\\\\?\\unc\\/i.test(normalized)) {
    normalized = `\\\\${normalized.slice(8)}`;
  } else if (normalized.startsWith('\\\\?\\')) {
    normalized = normalized.slice(4);
  }

  // UNC path (\\server\share\...)
  if (normalized.startsWith('\\\\')) {
    const rest = normalized.slice(2).replace(/\\/g, '/');
    const segments = rest
      .split('/')
      .filter((segment) => segment.length > 0)
      .map((segment) => encodeURIComponent(segment));
    return `${scheme}://localhost/__unc__/${segments.join('/')}`;
  }

  const slashPath = normalized.replace(/\\/g, '/');
  const rawSegments = slashPath.split('/');
  const encodedSegments: string[] = [];

  for (let i = 0; i < rawSegments.length; i += 1) {
    const segment = rawSegments[i];
    if (segment === '') {
      continue;
    }
    // Preserve Windows drive colon (e.g. `C:`) on the first segment.
    if (encodedSegments.length === 0 && /^[A-Za-z]:$/.test(segment)) {
      encodedSegments.push(segment);
    } else {
      encodedSegments.push(encodeURIComponent(segment));
    }
  }

  return `${scheme}://localhost/${encodedSegments.join('/')}`;
}

/**
 * Reverses `convertFileSrcToAssetUrl` back to a native filesystem path.
 * Returns `null` if the URL does not target `localhost` or contains invalid encoding.
 */
export function decodeAssetUrlPath(
  rawUrl: string,
  platform: NodeJS.Platform = process.platform
): string | null {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return null;
  }

  if (parsed.hostname.toLowerCase() !== 'localhost') {
    return null;
  }

  const rawSegments = parsed.pathname
    .split('/')
    .filter((segment) => segment.length > 0);
  if (rawSegments.length === 0) {
    return null;
  }

  const decoded: string[] = [];
  for (const segment of rawSegments) {
    try {
      const value = decodeURIComponent(segment);
      if (value.includes('\0')) {
        return null;
      }
      decoded.push(value);
    } catch {
      return null;
    }
  }

  if (decoded[0] === '__unc__') {
    const uncParts = decoded.slice(1);
    if (uncParts.length < 2) {
      return null;
    }
    return `\\\\${uncParts.join('\\')}`;
  }

  if (/^[A-Za-z]:$/.test(decoded[0])) {
    const drive = decoded[0];
    const rest = decoded.slice(1);
    if (platform === 'win32') {
      return `${drive}\\${rest.join('\\')}`;
    }
    return `${drive}/${rest.join('/')}`;
  }

  return `/${decoded.join('/')}`;
}
