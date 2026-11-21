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
  "script-src 'self' dimo-app://localhost blob: 'wasm-unsafe-eval'",
  "style-src 'self' dimo-app://localhost 'unsafe-inline'",
  "img-src 'self' dimo-app://localhost dimo-asset://localhost http://127.0.0.1:* http://localhost:* https: http: data: blob:",
  "media-src 'self' dimo-app://localhost dimo-asset://localhost http://127.0.0.1:* http://localhost:* https: data: blob:",
  "font-src 'self' dimo-app://localhost dimo-asset://localhost data:",
  "connect-src 'self' dimo-app://localhost dimo-asset://localhost http://127.0.0.1:* ws://127.0.0.1:* http://localhost:* ws://localhost:* https: wss: http: ws: blob: data:",
  "worker-src 'self' dimo-app://localhost blob:",
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

function normalizeForCompare(
  targetPath: string,
  platform: NodeJS.Platform = process.platform
): string {
  const resolved = path.resolve(targetPath);
  return platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function canonicalizeExisting(targetPath: string): string | null {
  try {
    return fs.realpathSync(targetPath);
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
    if (!trimmed || trimmed.includes('\0') || !path.isAbsolute(trimmed)) {
      throw new Error(`Invalid preview asset path: ${rawPath}`);
    }
    if (!fs.existsSync(trimmed)) {
      if (requireExists) {
        throw new Error(`Preview asset does not exist: ${trimmed}`);
      }
      return null;
    }
    const canonical = canonicalizeExisting(trimmed);
    if (!canonical) {
      throw new Error(`Invalid preview asset path: ${trimmed}`);
    }
    const stat = fs.statSync(canonical);
    if (stat.isDirectory()) {
      this.allowedDirectories.add(canonical);
    } else {
      this.allowedFiles.add(normalizeForCompare(canonical, this.platform));
    }
    return canonical;
  }

  isAllowed(targetPath: string): boolean {
    const canonical = canonicalizeExisting(targetPath);
    if (!canonical) {
      return false;
    }
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

export function resolveAppDistFile(
  distRoot: string,
  requestUrl: string,
  platform: NodeJS.Platform = process.platform
): string | null {
  let parsed: URL;
  try {
    parsed = new URL(requestUrl);
  } catch {
    return null;
  }

  if (parsed.hostname.toLowerCase() !== 'localhost') {
    return null;
  }

  const canonicalRoot = canonicalizeExisting(distRoot);
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

  const canonicalCandidate = canonicalizeExisting(candidate);
  if (
    canonicalCandidate &&
    isWithinDirectory(canonicalCandidate, canonicalRoot, platform) &&
    fs.statSync(canonicalCandidate).isFile()
  ) {
    return canonicalCandidate;
  }

  // SPA fallback to index.html for client routes (including dotted routes like
  // `/plugins/com.dimo.foo`), while returning 404 for missing static assets.
  const ext = path.extname(relative).toLowerCase();
  if (!STATIC_ASSET_EXTENSIONS.has(ext)) {
    const indexPath = canonicalizeExisting(
      path.join(canonicalRoot, 'index.html')
    );
    if (
      indexPath &&
      isWithinDirectory(indexPath, canonicalRoot, platform) &&
      fs.statSync(indexPath).isFile()
    ) {
      return indexPath;
    }
  }

  return null;
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

  // Attach immediately so early or post-cancel I/O errors are never uncaught.
  stream.on('error', (error) => {
    if (settled) {
      return;
    }
    settled = true;
    cleanupAbort();
    try {
      controllerRef?.error(error);
    } catch {
      // Ignore if controller is already closed or errored.
    }
  });

  if (signal) {
    if (signal.aborted) {
      settled = true;
      if (!stream.destroyed) {
        stream.destroy();
      }
    } else {
      signal.addEventListener('abort', onAbort, { once: true });
    }
  }

  return new ReadableStream<Uint8Array>({
    start(controller) {
      controllerRef = controller;
      if (settled) {
        try {
          controller.close();
        } catch {
          // Ignore.
        }
        return;
      }

      stream.pause();

      stream.on('data', (chunk: Buffer | string) => {
        if (settled) {
          return;
        }
        const bytes =
          typeof chunk === 'string'
            ? Buffer.from(chunk)
            : new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength);
        try {
          controller.enqueue(bytes);
          if (controller.desiredSize !== null && controller.desiredSize <= 0) {
            stream.pause();
          }
        } catch {
          settled = true;
          cleanupAbort();
          if (!stream.destroyed) {
            stream.destroy();
          }
        }
      });

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
      if (!settled && !stream.destroyed) {
        stream.resume();
      }
    },
    cancel() {
      settled = true;
      cleanupAbort();
      if (!stream.destroyed) {
        stream.destroy();
      }
    },
  });
}

export function createStreamingFileResponse(
  filePath: string,
  request: Request,
  options?: { extraHeaders?: Readonly<Record<string, string>> }
): Response {
  const extraHeaders = options?.extraHeaders;
  let stat: fs.Stats;
  try {
    stat = fs.statSync(filePath);
  } catch {
    return new Response('Not Found', {
      status: 404,
      ...(extraHeaders ? { headers: { ...extraHeaders } } : {}),
    });
  }
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

export function handleAppProtocolRequest(
  frontendDistDir: string,
  request: Request
): Response {
  const resolved = resolveAppDistFile(frontendDistDir, request.url);
  if (!resolved) {
    return new Response('Not Found', { status: 404 });
  }
  const extraHeaders = mimeTypeForPath(resolved).startsWith('text/html')
    ? { 'Content-Security-Policy': APP_CONTENT_SECURITY_POLICY }
    : undefined;
  return createStreamingFileResponse(resolved, request, { extraHeaders });
}

export function handleAssetProtocolRequest(
  assetScope: PreviewAssetScope,
  request: Request
): Response {
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
  if (!assetScope.isAllowed(targetPath)) {
    return new Response('Forbidden', {
      status: 403,
      headers: ASSET_CORS_HEADERS,
    });
  }
  return createStreamingFileResponse(targetPath, request, {
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
    handleAppProtocolRequest(frontendDistDir, request)
  );

  protocol.handle(DESKTOP_ASSET_SCHEME, (request) =>
    handleAssetProtocolRequest(assetScope, request)
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
