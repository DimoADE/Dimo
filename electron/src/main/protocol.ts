import fs from 'node:fs';
import path from 'node:path';
import type { Readable } from 'node:stream';

import {
  DESKTOP_APP_SCHEME,
  DESKTOP_ASSET_SCHEME,
  decodeAssetUrlPath,
} from '../shared/ipcContract';

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.cjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.avif': 'image/avif',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.wasm': 'application/wasm',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.m4a': 'audio/mp4',
  '.flac': 'audio/flac',
  '.pdf': 'application/pdf',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
};

/**
 * Known static asset extensions that must return 404 when missing instead of
 * falling back to `index.html`. Non-asset dotted client routes such as
 * `/plugins/com.dimo.foo` or `/settings/plugin/com.dimo.foo` fall back to
 * `index.html`.
 */
const STATIC_ASSET_EXTENSIONS = new Set([
  '.js',
  '.mjs',
  '.cjs',
  '.css',
  '.map',
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.svg',
  '.ico',
  '.avif',
  '.woff',
  '.woff2',
  '.ttf',
  '.otf',
  '.json',
  '.wasm',
  '.mp3',
  '.mp4',
  '.wav',
  '.webm',
  '.txt',
  '.xml',
]);

/**
 * Content-Security-Policy served on `dimo-app://localhost` HTML documents.
 * Applied via HTTP response header rather than `index.html` `<meta>` so Vite
 * dev-mode HMR remains unaffected.
 */
export const APP_CONTENT_SECURITY_POLICY = [
  "default-src 'self' dimo-app://localhost",
  "script-src 'self' dimo-app://localhost dimo-asset://localhost http://127.0.0.1:* http://localhost:* blob: 'wasm-unsafe-eval'",
  "style-src 'self' dimo-app://localhost http://127.0.0.1:* http://localhost:* 'unsafe-inline'",
  "img-src 'self' dimo-app://localhost dimo-asset://localhost http://127.0.0.1:* http://localhost:* https: http: data: blob:",
  "media-src 'self' dimo-app://localhost dimo-asset://localhost http://127.0.0.1:* http://localhost:* https: data: blob:",
  "font-src 'self' dimo-app://localhost dimo-asset://localhost http://127.0.0.1:* http://localhost:* data:",
  "connect-src 'self' dimo-app://localhost dimo-asset://localhost http://127.0.0.1:* ws://127.0.0.1:* http://localhost:* ws://localhost:* https: wss: http: ws: blob: data:",
  "worker-src 'self' dimo-app://localhost http://127.0.0.1:* http://localhost:* blob:",
  "frame-src 'self' dimo-app://localhost dimo-asset://localhost http://127.0.0.1:* http://localhost:* https: http: blob: data:",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

export const ASSET_CORS_HEADERS: Readonly<Record<string, string>> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Expose-Headers':
    'Content-Length, Content-Range, Accept-Ranges',
};

export const ASSET_PREFLIGHT_HEADERS: Readonly<Record<string, string>> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
  'Access-Control-Allow-Headers': 'Range, Content-Type',
  'Access-Control-Expose-Headers':
    'Content-Length, Content-Range, Accept-Ranges',
};

export function mimeTypeForPath(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  return MIME_TYPES[ext] ?? 'application/octet-stream';
}

export function stripWindowsVerbatimPrefix(
  targetPath: string,
  platform: NodeJS.Platform = process.platform
): string {
  if (platform !== 'win32') {
    return targetPath;
  }
  if (/^\\\\\?\\unc\\/i.test(targetPath)) {
    return `\\\\${targetPath.slice(8)}`;
  }
  if (targetPath.startsWith('\\\\?\\')) {
    return targetPath.slice(4);
  }
  return targetPath;
}

export function isValidAbsolutePath(
  rawPath: string,
  platform: NodeJS.Platform = process.platform
): boolean {
  if (typeof rawPath !== 'string' || rawPath.length === 0 || rawPath.includes('\0')) {
    return false;
  }
  if (platform === 'win32') {
    const stripped = stripWindowsVerbatimPrefix(rawPath, platform);
    if (/^[A-Za-z]:[\\/]/.test(stripped)) {
      return true;
    }
    if (/^(?:\\\\|\/\/)[^\\/]+[\\/][^\\/]+/.test(stripped)) {
      return true;
    }
    return false;
  }
  return path.posix.isAbsolute(rawPath);
}

function normalizeForCompare(
  targetPath: string,
  platform: NodeJS.Platform = process.platform
): string {
  const stripped = stripWindowsVerbatimPrefix(targetPath, platform);
  const pathMod = platform === 'win32' ? path.win32 : path.posix;
  const resolved = stripWindowsVerbatimPrefix(pathMod.resolve(stripped), platform);
  return platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function canonicalizeExisting(
  targetPath: string,
  platform: NodeJS.Platform = process.platform
): string | null {
  const cleaned = stripWindowsVerbatimPrefix(targetPath, platform);
  try {
    return stripWindowsVerbatimPrefix(fs.realpathSync(cleaned), platform);
  } catch {
    return null;
  }
}

function isWithinDirectory(
  candidate: string,
  directory: string,
  platform: NodeJS.Platform = process.platform
): boolean {
  const normCandidate = normalizeForCompare(candidate, platform);
  const normDir = normalizeForCompare(directory, platform);
  if (normCandidate === normDir) {
    return true;
  }
  const sep = platform === 'win32' ? '\\' : '/';
  const dirWithSep = normDir.endsWith(sep) ? normDir : `${normDir}${sep}`;
  return normCandidate.startsWith(dirWithSep);
}

/**
 * Additive allow-list for `dimo-asset://` local file reads, mirroring Tauri's
 * `asset_protocol_scope()` populated by `allow_preview_asset_scope`.
 */
const MAX_PREVIEW_ASSET_DIRECTORIES = 256;
const MAX_PREVIEW_ASSET_FILES = 1024;

function addBoundedScopeEntry(set: Set<string>, value: string, maxSize: number): void {
  if (set.has(value)) {
    set.delete(value);
  }
  set.add(value);
  while (set.size > maxSize) {
    const oldest = set.values().next().value;
    if (oldest === undefined) {
      break;
    }
    set.delete(oldest);
  }
}

export class PreviewAssetScope {
  private readonly allowedDirectories = new Set<string>();
  private readonly allowedFiles = new Set<string>();
  private readonly platform: NodeJS.Platform;

  constructor(platform: NodeJS.Platform = process.platform) {
    this.platform = platform;
  }

  allow(options: { path?: string; directories?: string[] }): string {
    let lastCanonical = '';

    if (Array.isArray(options.directories)) {
      for (const rawDir of options.directories) {
        const canonical = this.grantRawPath(rawDir, false);
        if (canonical) {
          lastCanonical = canonical;
        }
      }
    }

    if (typeof options.path === 'string' && options.path.trim().length > 0) {
      const canonical = this.grantRawPath(options.path, true);
      if (canonical) {
        lastCanonical = canonical;
      }
    }

    return lastCanonical;
  }

  private grantRawPath(rawPath: string, requireExists: boolean): string | null {
    const trimmed = rawPath.trim();
    if (!isValidAbsolutePath(trimmed, this.platform)) {
      throw new Error(`Invalid preview asset path: ${rawPath}`);
    }
    const cleaned = stripWindowsVerbatimPrefix(trimmed, this.platform);
    if (!fs.existsSync(cleaned)) {
      if (requireExists) {
        throw new Error(`Preview asset does not exist: ${trimmed}`);
      }
      return null;
    }
    const canonical = canonicalizeExisting(cleaned, this.platform);
    if (!canonical) {
      throw new Error(`Invalid preview asset path: ${trimmed}`);
    }
    const stat = fs.statSync(canonical);
    if (stat.isDirectory()) {
      addBoundedScopeEntry(
        this.allowedDirectories,
        canonical,
        MAX_PREVIEW_ASSET_DIRECTORIES
      );
    } else {
      addBoundedScopeEntry(
        this.allowedFiles,
        normalizeForCompare(canonical, this.platform),
        MAX_PREVIEW_ASSET_FILES
      );
    }
    return canonical;
  }

  isAllowed(targetPath: string): boolean {
    const trimmed = typeof targetPath === 'string' ? targetPath.trim() : '';
    if (!isValidAbsolutePath(trimmed, this.platform)) {
      return false;
    }
    const canonical = canonicalizeExisting(trimmed, this.platform);
    if (!canonical) {
      return false;
    }
    return this.isCanonicalAllowed(canonical);
  }

  async isAllowedAsync(targetPath: string): Promise<boolean> {
    const trimmed = typeof targetPath === 'string' ? targetPath.trim() : '';
    if (!isValidAbsolutePath(trimmed, this.platform)) {
      return false;
    }
    const cleaned = stripWindowsVerbatimPrefix(trimmed, this.platform);
    let canonical: string;
    try {
      canonical = stripWindowsVerbatimPrefix(
        await fs.promises.realpath(cleaned),
        this.platform
      );
    } catch {
      return false;
    }
    return this.isCanonicalAllowed(canonical);
  }

  private isCanonicalAllowed(canonical: string): boolean {
    const normalized = normalizeForCompare(canonical, this.platform);
    if (this.allowedFiles.has(normalized)) {
      return true;
    }
    for (const dir of this.allowedDirectories) {
      if (isWithinDirectory(canonical, dir, this.platform)) {
        return true;
      }
    }
    return false;
  }
}

export interface ByteRange {
  start: number;
  end: number;
}

export function parseByteRange(
  rangeHeader: string | null,
  totalSize: number
): ByteRange | 'invalid' | null {
  if (!rangeHeader) {
    return null;
  }
  const match = /^bytes=(\d*)-(\d*)$/i.exec(rangeHeader.trim());
  if (!match) {
    return 'invalid';
  }
  const [, rawStart, rawEnd] = match;
  if (totalSize <= 0) {
    return 'invalid';
  }

  let start: number;
  let end: number;

  if (rawStart === '' && rawEnd === '') {
    return 'invalid';
  } else if (rawStart === '') {
    // Suffix byte range: last N bytes
    const suffixLength = Number(rawEnd);
    if (!Number.isInteger(suffixLength) || suffixLength <= 0) {
      return 'invalid';
    }
    start = Math.max(0, totalSize - suffixLength);
    end = totalSize - 1;
  } else {
    start = Number(rawStart);
    end = rawEnd === '' ? totalSize - 1 : Number(rawEnd);
    if (
      !Number.isInteger(start) ||
      !Number.isInteger(end) ||
      start < 0 ||
      start >= totalSize ||
      end < start
    ) {
      return 'invalid';
    }
    end = Math.min(end, totalSize - 1);
  }

  return { start, end };
}

/**
 * Bridges a Node `Readable` into a Web `ReadableStream<Uint8Array>` with an
 * eager `'error'` listener and clean `destroy()` on cancel/abort so mid-read
 * I/O errors or aborted range seeks never emit unhandled Node stream errors.
 */
export function toSafeWebStream(
  stream: Readable,
  signal?: AbortSignal
): ReadableStream<Uint8Array> {
  let settled = false;
  let hasPendingError = false;
  let pendingError: unknown = null;
  let dataAttached = false;
  let controllerRef: ReadableStreamDefaultController<Uint8Array> | null = null;

  const cleanupAbort = () => {
    if (signal) {
      signal.removeEventListener('abort', onAbort);
    }
  };

  const onAbort = () => {
    if (settled) {
      return;
    }
    settled = true;
    cleanupAbort();
    if (!stream.destroyed) {
      stream.destroy();
    }
    try {
      controllerRef?.close();
    } catch {
      // Ignore if controller is already closed or errored.
    }
  };

  // Capture streams that already errored prior to wrapping.
  if (stream.errored) {
    settled = true;
    hasPendingError = true;
    pendingError = stream.errored;
  }

  // Attach immediately so early or post-cancel I/O errors are never uncaught.
  stream.on('error', (error) => {
    if (settled) {
      return;
    }
    settled = true;
    cleanupAbort();
    if (controllerRef) {
      try {
        controllerRef.error(error);
      } catch {
        // Ignore if controller is already closed or errored.
      }
    } else {
      hasPendingError = true;
      pendingError = error;
    }
  });

  // Pause before any 'data' listener is attached so chunks do not flow ahead of pull().
  if (!settled && !stream.destroyed) {
    stream.pause();
  }

  if (signal) {
    if (signal.aborted) {
      if (!settled) {
        settled = true;
      }
      if (!stream.destroyed) {
        stream.destroy();
      }
    } else if (!settled) {
      signal.addEventListener('abort', onAbort, { once: true });
    }
  }

  const onData = (chunk: Buffer | string) => {
    if (settled || !controllerRef) {
      return;
    }
    const bytes =
      typeof chunk === 'string'
        ? Buffer.from(chunk)
        : new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    try {
      controllerRef.enqueue(bytes);
      if (
        controllerRef.desiredSize !== null &&
        controllerRef.desiredSize <= 0
      ) {
        stream.pause();
      }
    } catch {
      settled = true;
      cleanupAbort();
      if (!stream.destroyed) {
        stream.destroy();
      }
    }
  };

  return new ReadableStream<Uint8Array>({
    start(controller) {
      controllerRef = controller;
      if (hasPendingError) {
        try {
          controller.error(pendingError);
        } catch {
          // Ignore.
        }
        return;
      }
      if (settled || stream.readableEnded || stream.destroyed) {
        settled = true;
        cleanupAbort();
        try {
          controller.close();
        } catch {
          // Ignore.
        }
        return;
      }

      stream.on('end', () => {
        if (settled) {
          return;
        }
        settled = true;
        cleanupAbort();
        try {
          controller.close();
        } catch {
          // Ignore.
        }
      });

      stream.on('close', () => {
        if (settled) {
          return;
        }
        settled = true;
        cleanupAbort();
        try {
          controller.close();
        } catch {
          // Ignore.
        }
      });
    },
    pull() {
      if (settled || stream.destroyed) {
        return;
      }
      if (!dataAttached) {
        dataAttached = true;
        stream.on('data', onData);
      }
      stream.resume();
    },
    cancel() {
      settled = true;
      cleanupAbort();
      if (dataAttached) {
        stream.removeListener('data', onData);
      }
      if (!stream.destroyed) {
        stream.destroy();
      }
    },
  });
}

function buildStreamingFileResponse(
  filePath: string,
  stat: fs.Stats,
  request: Request,
  options?: { extraHeaders?: Readonly<Record<string, string>> }
): Response {
  const extraHeaders = options?.extraHeaders;
  if (!stat.isFile()) {
    return new Response('Not Found', {
      status: 404,
      ...(extraHeaders ? { headers: { ...extraHeaders } } : {}),
    });
  }

  const contentType = mimeTypeForPath(filePath);
  const totalSize = stat.size;
  const rangeResult = parseByteRange(request.headers.get('range'), totalSize);

  if (rangeResult === 'invalid') {
    return new Response('Range Not Satisfiable', {
      status: 416,
      headers: {
        ...extraHeaders,
        'Content-Range': `bytes */${totalSize}`,
        'Accept-Ranges': 'bytes',
      },
    });
  }

  if (request.method === 'HEAD') {
    if (rangeResult) {
      const length = rangeResult.end - rangeResult.start + 1;
      return new Response(null, {
        status: 206,
        headers: {
          ...extraHeaders,
          'Content-Type': contentType,
          'Content-Length': String(length),
          'Content-Range': `bytes ${rangeResult.start}-${rangeResult.end}/${totalSize}`,
          'Accept-Ranges': 'bytes',
        },
      });
    }
    return new Response(null, {
      status: 200,
      headers: {
        ...extraHeaders,
        'Content-Type': contentType,
        'Content-Length': String(totalSize),
        'Accept-Ranges': 'bytes',
      },
    });
  }

  if (rangeResult) {
    const length = rangeResult.end - rangeResult.start + 1;
    const stream = fs.createReadStream(filePath, {
      start: rangeResult.start,
      end: rangeResult.end,
    });
    return new Response(toSafeWebStream(stream, request.signal), {
      status: 206,
      headers: {
        ...extraHeaders,
        'Content-Type': contentType,
        'Content-Length': String(length),
        'Content-Range': `bytes ${rangeResult.start}-${rangeResult.end}/${totalSize}`,
        'Accept-Ranges': 'bytes',
      },
    });
  }

  const stream = fs.createReadStream(filePath);
  return new Response(toSafeWebStream(stream, request.signal), {
    status: 200,
    headers: {
      ...extraHeaders,
      'Content-Type': contentType,
      'Content-Length': String(totalSize),
      'Accept-Ranges': 'bytes',
    },
  });
}

async function createStreamingFileResponseAsync(
  filePath: string,
  request: Request,
  options?: { extraHeaders?: Readonly<Record<string, string>> }
): Promise<Response> {
  const extraHeaders = options?.extraHeaders;
  let stat: fs.Stats;
  try {
    stat = await fs.promises.stat(filePath);
  } catch {
    return new Response('Not Found', {
      status: 404,
      ...(extraHeaders ? { headers: { ...extraHeaders } } : {}),
    });
  }
  return buildStreamingFileResponse(filePath, stat, request, options);
}

const MAX_DIST_ROOT_CACHE_ENTRIES = 16;
const distRootRealpathCache = new Map<string, string>();

async function resolveCanonicalDistRootAsync(
  distRoot: string,
  platform: NodeJS.Platform = process.platform
): Promise<string | null> {
  const cacheKey = `${platform}\0${distRoot}`;
  const cached = distRootRealpathCache.get(cacheKey);
  if (cached !== undefined) {
    return cached;
  }
  try {
    const cleaned = stripWindowsVerbatimPrefix(distRoot, platform);
    const canonical = stripWindowsVerbatimPrefix(
      await fs.promises.realpath(cleaned),
      platform
    );
    if (distRootRealpathCache.has(cacheKey)) {
      distRootRealpathCache.delete(cacheKey);
    }
    distRootRealpathCache.set(cacheKey, canonical);
    while (distRootRealpathCache.size > MAX_DIST_ROOT_CACHE_ENTRIES) {
      const oldest = distRootRealpathCache.keys().next().value;
      if (oldest === undefined) {
        break;
      }
      distRootRealpathCache.delete(oldest);
    }
    return canonical;
  } catch {
    return null;
  }
}

export async function resolveAppDistFileAsync(
  distRoot: string,
  requestUrl: string,
  platform: NodeJS.Platform = process.platform
): Promise<string | null> {
  let parsed: URL;
  try {
    parsed = new URL(requestUrl);
  } catch {
    return null;
  }

  if (parsed.hostname.toLowerCase() !== 'localhost') {
    return null;
  }

  const canonicalRoot = await resolveCanonicalDistRootAsync(distRoot, platform);
  if (!canonicalRoot) {
    return null;
  }

  let pathname: string;
  try {
    pathname = decodeURIComponent(parsed.pathname);
  } catch {
    return null;
  }

  if (pathname.includes('\0')) {
    return null;
  }

  const relative = pathname.replace(/^\/+/, '');
  const candidate = path.resolve(
    canonicalRoot,
    relative.length === 0 ? 'index.html' : relative
  );

  if (!isWithinDirectory(candidate, canonicalRoot, platform)) {
    return null;
  }

  try {
    const canonicalCandidate = stripWindowsVerbatimPrefix(
      await fs.promises.realpath(candidate),
      platform
    );
    if (
      isWithinDirectory(canonicalCandidate, canonicalRoot, platform) &&
      (await fs.promises.stat(canonicalCandidate)).isFile()
    ) {
      return canonicalCandidate;
    }
  } catch {
    // Fall through to SPA index fallback below.
  }

  const ext = path.extname(relative).toLowerCase();
  if (!STATIC_ASSET_EXTENSIONS.has(ext)) {
    try {
      const indexPath = stripWindowsVerbatimPrefix(
        await fs.promises.realpath(path.join(canonicalRoot, 'index.html')),
        platform
      );
      if (
        isWithinDirectory(indexPath, canonicalRoot, platform) &&
        (await fs.promises.stat(indexPath)).isFile()
      ) {
        return indexPath;
      }
    } catch {
      return null;
    }
  }

  return null;
}

export async function handleAppProtocolRequestAsync(
  frontendDistDir: string,
  request: Request
): Promise<Response> {
  const resolved = await resolveAppDistFileAsync(frontendDistDir, request.url);
  if (!resolved) {
    return new Response('Not Found', { status: 404 });
  }
  const extraHeaders = mimeTypeForPath(resolved).startsWith('text/html')
    ? { 'Content-Security-Policy': APP_CONTENT_SECURITY_POLICY }
    : undefined;
  return createStreamingFileResponseAsync(resolved, request, { extraHeaders });
}

export async function handleAssetProtocolRequestAsync(
  assetScope: PreviewAssetScope,
  request: Request
): Promise<Response> {
  if (request.method.toUpperCase() === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: ASSET_PREFLIGHT_HEADERS,
    });
  }

  const targetPath = decodeAssetUrlPath(request.url);
  if (!targetPath) {
    return new Response('Bad Request', {
      status: 400,
      headers: ASSET_CORS_HEADERS,
    });
  }
  if (!(await assetScope.isAllowedAsync(targetPath))) {
    return new Response('Forbidden', {
      status: 403,
      headers: ASSET_CORS_HEADERS,
    });
  }
  return createStreamingFileResponseAsync(targetPath, request, {
    extraHeaders: ASSET_CORS_HEADERS,
  });
}

/**
 * Must be called synchronously before Electron `app.whenReady()`.
 */
export function registerPrivilegedSchemes(
  protocol: Electron.Protocol
): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: DESKTOP_APP_SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        corsEnabled: true,
        stream: true,
      },
    },
    {
      scheme: DESKTOP_ASSET_SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        corsEnabled: true,
        stream: true,
      },
    },
  ]);
}

const registeredProtocols = new WeakSet<Electron.Protocol>();

export function registerProtocolHandlers(options: {
  protocol: Electron.Protocol;
  frontendDistDir: string;
  assetScope: PreviewAssetScope;
}): void {
  const { protocol, frontendDistDir, assetScope } = options;
  if (registeredProtocols.has(protocol)) {
    return;
  }
  registeredProtocols.add(protocol);

  protocol.handle(DESKTOP_APP_SCHEME, (request) =>
    handleAppProtocolRequestAsync(frontendDistDir, request)
  );

  protocol.handle(DESKTOP_ASSET_SCHEME, (request) =>
    handleAssetProtocolRequestAsync(assetScope, request)
  );
}

export function registerProtocolHandlersForSession(
  targetSession: Electron.Session,
  options: {
    frontendDistDir: string;
    assetScope: PreviewAssetScope;
  }
): void {
  registerProtocolHandlers({
    protocol: targetSession.protocol,
    frontendDistDir: options.frontendDistDir,
    assetScope: options.assetScope,
  });
}
