import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';

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

  // SPA fallback to index.html for extensionless client routes.
  if (!path.extname(relative)) {
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

function createStreamingFileResponse(
  filePath: string,
  request: Request
): Response {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(filePath);
  } catch {
    return new Response('Not Found', { status: 404 });
  }
  if (!stat.isFile()) {
    return new Response('Not Found', { status: 404 });
  }

  const contentType = mimeTypeForPath(filePath);
  const totalSize = stat.size;
  const rangeResult = parseByteRange(request.headers.get('range'), totalSize);

  if (rangeResult === 'invalid') {
    return new Response('Range Not Satisfiable', {
      status: 416,
      headers: {
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
    return new Response(Readable.toWeb(stream) as ReadableStream, {
      status: 206,
      headers: {
        'Content-Type': contentType,
        'Content-Length': String(length),
        'Content-Range': `bytes ${rangeResult.start}-${rangeResult.end}/${totalSize}`,
        'Accept-Ranges': 'bytes',
      },
    });
  }

  const stream = fs.createReadStream(filePath);
  return new Response(Readable.toWeb(stream) as ReadableStream, {
    status: 200,
    headers: {
      'Content-Type': contentType,
      'Content-Length': String(totalSize),
      'Accept-Ranges': 'bytes',
    },
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

  protocol.handle(DESKTOP_APP_SCHEME, (request) => {
    const resolved = resolveAppDistFile(frontendDistDir, request.url);
    if (!resolved) {
      return new Response('Not Found', { status: 404 });
    }
    return createStreamingFileResponse(resolved, request);
  });

  protocol.handle(DESKTOP_ASSET_SCHEME, (request) => {
    const targetPath = decodeAssetUrlPath(request.url);
    if (!targetPath) {
      return new Response('Bad Request', { status: 400 });
    }
    if (!assetScope.isAllowed(targetPath)) {
      return new Response('Forbidden', { status: 403 });
    }
    return createStreamingFileResponse(targetPath, request);
  });
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
