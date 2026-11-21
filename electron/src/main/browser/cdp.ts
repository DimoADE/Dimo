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

export function buildInjectedScriptWithPickerShim(script: string): string {
  const shim = [
    'globalThis.__dimoPickQueue = globalThis.__dimoPickQueue || [];',
    'if (typeof globalThis.__codegSend !== "function") {',
    '  globalThis.__codegSend = function (msg) {',
    '    try { globalThis.__dimoPickQueue.push(msg); } catch (e) {}',
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

async function ensureDebuggerAttached(wc: WebContents): Promise<boolean> {
  if (wc.isDestroyed()) {
    return false;
  }
  try {
    if (!wc.debugger.isAttached()) {
      wc.debugger.attach('1.3');
    }
    return wc.debugger.isAttached();
  } catch {
    return false;
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
  try {
    return await Promise.race([
      wc.debugger.sendCommand(method, params) as Promise<T>,
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function capturePngBase64(wc: WebContents): Promise<string> {
  if (wc.isDestroyed()) {
    throw new Error('tab webContents is destroyed');
  }

  if (await ensureDebuggerAttached(wc)) {
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
    } catch {
      // Fall back to Electron's native capturePage below.
    }
  }

  const image = await wc.capturePage();
  const png = image.toPNG();
  if (png.length === 0) {
    throw new Error('capturePage returned an empty PNG');
  }
  return png.toString('base64');
}

export async function captureFreezeFrame(
  wc: WebContents
): Promise<FrozenFramePayload | null> {
  if (wc.isDestroyed()) {
    return null;
  }

  if (await ensureDebuggerAttached(wc)) {
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
      // Fall back to Electron's capturePage below.
    }
  }

  try {
    const image = await wc.capturePage();
    const jpeg = image.toJPEG(82);
    if (jpeg.length === 0) {
      return null;
    }
    return { mime: 'image/jpeg', data: jpeg.toString('base64') };
  } catch {
    return null;
  }
}

export async function applyDevicePreset(
  wc: WebContents,
  device: string
): Promise<void> {
  if (wc.isDestroyed()) {
    return;
  }
  const metrics = deviceMetricsForPreset(device);
  if (!(await ensureDebuggerAttached(wc))) {
    return;
  }
  if (!metrics) {
    await wc.debugger
      .sendCommand('Emulation.clearDeviceMetricsOverride')
      .catch(() => undefined);
    await wc.debugger
      .sendCommand('Emulation.setUserAgentOverride', { userAgent: '' })
      .catch(() => undefined);
    return;
  }

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
