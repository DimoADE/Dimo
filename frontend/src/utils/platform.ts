import { hasElectronDesktopRuntime } from '@/lib/desktopShell/electronShellBridge';

export type HostPlatform = 'windows' | 'macos' | 'linux' | 'unknown';

export function hostPlatformFromOsType(
  osType: string | null | undefined
): HostPlatform | null {
  if (!osType) return null;
  const value = osType.toLowerCase();
  if (value.includes('win')) return 'windows';
  if (
    value.includes('mac') ||
    value.includes('darwin') ||
    value.includes('ios')
  ) {
    return 'macos';
  }
  if (
    value.includes('linux') ||
    value.includes('ubuntu') ||
    value.includes('debian') ||
    value.includes('fedora') ||
    value.includes('alpine') ||
    value.includes('arch') ||
    value.includes('centos') ||
    value.includes('red hat') ||
    value.includes('suse') ||
    value.includes('gentoo')
  ) {
    return 'linux';
  }
  return null;
}

export function getHostPlatform(): HostPlatform {
  const desktopPlatform =
    typeof window !== 'undefined'
      ? window.dimoDesktop?.platform?.toLowerCase()
      : undefined;
  if (desktopPlatform === 'win32') return 'windows';
  if (desktopPlatform === 'darwin') return 'macos';
  if (desktopPlatform === 'linux') return 'linux';

  const nav = navigator as Navigator & {
    userAgentData?: { platform?: string };
  };
  const platform =
    nav.userAgentData?.platform ||
    navigator.platform ||
    navigator.userAgent ||
    '';
  const normalized = platform.toLowerCase();

  if (normalized.includes('win')) return 'windows';
  if (
    normalized.includes('mac') ||
    normalized.includes('iphone') ||
    normalized.includes('ipad') ||
    normalized.includes('ipod')
  ) {
    return 'macos';
  }
  if (normalized.includes('linux') || normalized.includes('x11')) {
    return 'linux';
  }

  return 'unknown';
}

export function terminalHostPlatform(osType?: string | null): HostPlatform {
  return hostPlatformFromOsType(osType) ?? getHostPlatform();
}

export function isMac(): boolean {
  return getHostPlatform() === 'macos';
}

export function isWindows(): boolean {
  return getHostPlatform() === 'windows';
}

export function isLinux(): boolean {
  return getHostPlatform() === 'linux';
}

export function logoLeadsWindowChrome(): boolean {
  return isWindows() || isLinux();
}

export function usesSolidHostChrome(): boolean {
  if (isWindows() || isLinux()) {
    return true;
  }
  if (typeof document === 'undefined') {
    return false;
  }
  return (
    document.documentElement.classList.contains('host-windows') ||
    document.documentElement.classList.contains('host-linux')
  );
}

export function isElectronDesktopShell(): boolean {
  return hasElectronDesktopRuntime();
}

export function isDesktopShell(): boolean {
  return hasElectronDesktopRuntime();
}

export function applyHostPlatformToDocument(): void {
  if (typeof document === 'undefined') {
    return;
  }
  const electron = isElectronDesktopShell();
  document.documentElement.dataset.hostPlatform = getHostPlatform();
  document.documentElement.classList.toggle('host-windows', isWindows());
  document.documentElement.classList.toggle('host-linux', isLinux());
  document.documentElement.classList.toggle('electron-desktop', electron);
  document.documentElement.classList.toggle('desktop-shell', electron);
}

export function getModifierKey(): string {
  return isMac() ? '⌘' : 'Ctrl';
}
