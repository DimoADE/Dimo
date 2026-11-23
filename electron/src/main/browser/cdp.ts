import type { WebContents } from 'electron';

export interface DeviceEmulationPreset {
  width: number;
  height: number;
  deviceScaleFactor: number;
  mobile: boolean;
  userAgent: string;
}

export interface FrozenFramePayload {
  mime: string;
  data: string;
}

export const DIMO_PICK_CONSOLE_PREFIX = '__dimo_ipc__:';

const PHONE_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';
const TABLET_UA =
  'Mozilla/5.0 (iPad; CPU OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';

export function deviceMetricsForPreset(
  preset: string
): DeviceEmulationPreset | null {
  switch (preset) {
    case 'phone':
      return {
        width: 390,
        height: 844,
        deviceScaleFactor: 3,
        mobile: true,
        userAgent: PHONE_UA,
      };
    case 'tablet':
      return {
        width: 820,
        height: 1180,
        deviceScaleFactor: 2,
        mobile: true,
        userAgent: TABLET_UA,
      };
    default:
      return null;
  }
}

export const MAX_DIMO_PICK_QUEUE_LENGTH = 200;

export function buildInjectedScriptWithPickerShim(script: string): string {
  const shim = [
    'globalThis.__dimoPickQueue = globalThis.__dimoPickQueue || [];',
    'if (typeof globalThis.__codegSend !== "function") {',
    '  globalThis.__codegSend = function (msg) {',
    '    try {',
    '      var q = globalThis.__dimoPickQueue;',
    '      if (!Array.isArray(q)) { q = globalThis.__dimoPickQueue = []; }',
    '      q.push(msg);',
    `      if (q.length > ${MAX_DIMO_PICK_QUEUE_LENGTH}) { q.splice(0, q.length - ${MAX_DIMO_PICK_QUEUE_LENGTH}); }`,
    '    } catch (e) {}',
    `    try { console.debug(${JSON.stringify(DIMO_PICK_CONSOLE_PREFIX)} + String(msg)); } catch (e) {}`,
    '  };',
    '}',
  ].join('\n');
  return `${shim}\n${script}`;
}

export function serializeEvalResult(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }
  if (value === undefined) {
    return 'null';
  }
  try {
    return JSON.stringify(value) ?? 'null';
  } catch {
    return String(value);
  }
}

const debuggerRefCounts = new WeakMap<WebContents, number>();
const debuggerAttachedByUs = new WeakSet<WebContents>();
const deviceEmulationActive = new WeakSet<WebContents>();
const debuggerDetachHooked = new WeakSet<WebContents>();

function ensureDebuggerDetachHook(wc: WebContents): void {
  if (debuggerDetachHooked.has(wc)) {
    return;
  }
  if (typeof wc.debugger?.on !== 'function') {
    return;
  }
  debuggerDetachHooked.add(wc);
  wc.debugger.on('detach', () => {
    debuggerAttachedByUs.delete(wc);
    deviceEmulationActive.delete(wc);
    debuggerRefCounts.delete(wc);
  });
}

function acquireDebugger(wc: WebContents): boolean {
  if (wc.isDestroyed()) {
    return false;
  }
  try {
    ensureDebuggerDetachHook(wc);
    const currentCount = debuggerRefCounts.get(wc) ?? 0;
    const alreadyAttached = wc.debugger.isAttached();
    if (!alreadyAttached) {
      wc.debugger.attach('1.3');
      if (wc.debugger.isAttached()) {
        debuggerAttachedByUs.add(wc);
      }
    }
    if (!wc.debugger.isAttached()) {
      return false;
    }
    debuggerRefCounts.set(wc, currentCount + 1);
    return true;
  } catch {
    return false;
  }
}

function releaseDebugger(wc: WebContents): void {
  const currentCount = debuggerRefCounts.get(wc) ?? 0;
  const nextCount = Math.max(0, currentCount - 1);
  if (nextCount > 0) {
    debuggerRefCounts.set(wc, nextCount);
    return;
  }
  debuggerRefCounts.delete(wc);

  if (deviceEmulationActive.has(wc)) {
    return;
  }
  if (!debuggerAttachedByUs.has(wc)) {
    return;
  }
  debuggerAttachedByUs.delete(wc);
  if (wc.isDestroyed()) {
    return;
  }
  try {
    if (wc.debugger.isAttached()) {
      wc.debugger.detach();
    }
  } catch {
    // Best-effort cleanup; debugger may already be detached.
  }
}

const CDP_SCREENSHOT_TIMEOUT_MS = 4_000;

async function sendCdpCommandWithTimeout<T>(
  wc: WebContents,
  method: string,
  params: Record<string, unknown>,
  timeoutMs = CDP_SCREENSHOT_TIMEOUT_MS
): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let timedOut = false;
  const commandPromise = (
    wc.debugger.sendCommand(method, params) as Promise<T>
  ).catch((error: unknown) => {
    if (timedOut) {
      return null;
    }
    throw error;
  });
  // Attach a no-op rejection handler so late rejections after timeout never
  // surface as UnhandledPromiseRejection in Electron main.
  void commandPromise.catch(() => undefined);
  try {
    return await Promise.race([
      commandPromise,
      new Promise<null>((resolve) => {
        timer = setTimeout(() => {
          timedOut = true;
          resolve(null);
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function withUnthrottledCapture<T>(
  wc: WebContents,
  fn: () => Promise<T>
): Promise<T> {
  let restoreThrottling = false;
  try {
    if (
      typeof wc.getBackgroundThrottling === 'function' &&
      typeof wc.setBackgroundThrottling === 'function' &&
      wc.getBackgroundThrottling()
    ) {
      wc.setBackgroundThrottling(false);
      restoreThrottling = true;
    }
  } catch {
    // Some WebContents mocks/types do not expose throttling toggles.
  }
  try {
    return await fn();
  } finally {
    if (restoreThrottling && !wc.isDestroyed()) {
      try {
        wc.setBackgroundThrottling(true);
      } catch {
        // Best-effort restore.
      }
    }
  }
}

export async function capturePngBase64(wc: WebContents): Promise<string> {
  if (wc.isDestroyed()) {
    throw new Error('tab webContents is destroyed');
  }

  try {
    const png = await withUnthrottledCapture(wc, async () => {
      const image = await wc.capturePage();
      return image.toPNG();
    });
    if (png.length > 0) {
      return png.toString('base64');
    }
  } catch {
    // Fall back to CDP screenshot below (e.g. offscreen/unpainted surfaces).
  }

  if (acquireDebugger(wc)) {
    try {
      const response = await sendCdpCommandWithTimeout<{ data?: string }>(
        wc,
        'Page.captureScreenshot',
        {
          format: 'png',
          fromSurface: true,
        }
      );
      if (typeof response?.data === 'string' && response.data.length > 0) {
        return response.data;
      }
    } finally {
      releaseDebugger(wc);
    }
  }

  throw new Error('capturePage returned an empty PNG');
}

export async function captureFreezeFrame(
  wc: WebContents
): Promise<FrozenFramePayload | null> {
  if (wc.isDestroyed()) {
    return null;
  }

  try {
    const jpeg = await withUnthrottledCapture(wc, async () => {
      const image = await wc.capturePage();
      return image.toJPEG(82);
    });
    if (jpeg.length > 0) {
      return { mime: 'image/jpeg', data: jpeg.toString('base64') };
    }
  } catch {
    // Fall back to CDP screenshot below when native capturePage is unavailable.
  }

  if (acquireDebugger(wc)) {
    try {
      const response = await sendCdpCommandWithTimeout<{ data?: string }>(
        wc,
        'Page.captureScreenshot',
        {
          format: 'jpeg',
          quality: 82,
          fromSurface: true,
        }
      );
      if (typeof response?.data === 'string' && response.data.length > 0) {
        return { mime: 'image/jpeg', data: response.data };
      }
    } catch {
      return null;
    } finally {
      releaseDebugger(wc);
    }
  }

  return null;
}

export async function applyDevicePreset(
  wc: WebContents,
  device: string
): Promise<void> {
  if (wc.isDestroyed()) {
    return;
  }
  const metrics = deviceMetricsForPreset(device);
  if (!metrics) {
    deviceEmulationActive.delete(wc);
    if (!wc.debugger.isAttached()) {
      return;
    }
    if (!acquireDebugger(wc)) {
      return;
    }
    try {
      await wc.debugger
        .sendCommand('Emulation.clearDeviceMetricsOverride')
        .catch(() => undefined);
      await wc.debugger
        .sendCommand('Emulation.setUserAgentOverride', { userAgent: '' })
        .catch(() => undefined);
    } finally {
      releaseDebugger(wc);
    }
    return;
  }

  if (!acquireDebugger(wc)) {
    return;
  }

  try {
    deviceEmulationActive.add(wc);
    await wc.debugger.sendCommand('Emulation.setDeviceMetricsOverride', {
      width: metrics.width,
      height: metrics.height,
      deviceScaleFactor: metrics.deviceScaleFactor,
      mobile: metrics.mobile,
    });
    await wc.debugger
      .sendCommand('Emulation.setUserAgentOverride', {
        userAgent: metrics.userAgent,
      })
      .catch(() => undefined);
  } catch (error) {
    deviceEmulationActive.delete(wc);
    throw error;
  } finally {
    releaseDebugger(wc);
  }
}

export async function evaluateExpression(
  wc: WebContents,
  expression: string
): Promise<string> {
  if (wc.isDestroyed()) {
    throw new Error('tab webContents is destroyed');
  }
  const value = await wc.executeJavaScript(expression, true);
  return serializeEvalResult(value);
}

export async function injectScript(
  wc: WebContents,
  script: string
): Promise<void> {
  if (wc.isDestroyed()) {
    throw new Error('tab webContents is destroyed');
  }
  await wc.executeJavaScript(buildInjectedScriptWithPickerShim(script), true);
}
