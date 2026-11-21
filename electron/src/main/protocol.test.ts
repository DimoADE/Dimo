import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';

import { afterEach, describe, expect, it } from 'vitest';

import {
  convertFileSrcToAssetUrl,
  decodeAssetUrlPath,
} from '../shared/ipcContract';
import {
  APP_CONTENT_SECURITY_POLICY,
  PreviewAssetScope,
  handleAppProtocolRequest,
  handleAssetProtocolRequest,
  mimeTypeForPath,
  parseByteRange,
  resolveAppDistFile,
  toSafeWebStream,
} from './protocol';

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('asset URL encoding & decoding', () => {
  it('round-trips Windows drive paths with spaces, CJK, #, ?, and % while keeping relative URL resolution', () => {
    const winPath = 'C:\\Users\\Alice\\My Folder\\测试 #1?v=100%\\index.html';
    const url = convertFileSrcToAssetUrl(winPath);
    expect(url.startsWith('dimo-asset://localhost/')).toBe(true);
    expect(decodeAssetUrlPath(url, 'win32')).toBe(winPath);

    // Relative links inside previewed HTML must resolve within the same folder.
    const relativeScript = new URL('./assets/app.js', url).toString();
    expect(decodeAssetUrlPath(relativeScript, 'win32')).toBe(
      'C:\\Users\\Alice\\My Folder\\测试 #1?v=100%\\assets\\app.js'
    );
  });

  it('round-trips POSIX and Windows UNC paths', () => {
    const posixPath = '/Users/alice/my project/chart #2.svg';
    const posixUrl = convertFileSrcToAssetUrl(posixPath);
    expect(decodeAssetUrlPath(posixUrl, 'darwin')).toBe(posixPath);

    const uncPath = '\\\\fileserver\\share\\reports\\summary 2026.html';
    const uncUrl = convertFileSrcToAssetUrl(uncPath);
    expect(uncUrl.startsWith('dimo-asset://localhost/__unc__/')).toBe(true);
    expect(decodeAssetUrlPath(uncUrl, 'win32')).toBe(uncPath);
  });

  it('rejects non-localhost hosts and null bytes', () => {
    expect(decodeAssetUrlPath('dimo-asset://evil.com/etc/passwd', 'linux')).toBeNull();
    expect(decodeAssetUrlPath('dimo-asset://localhost/foo%00bar', 'linux')).toBeNull();
  });
});

describe('PreviewAssetScope', () => {
  it('allows explicitly granted files and directories while rejecting siblings and unallowed paths', () => {
    const root = makeTempDir('dimo-scope-');
    const allowedDir = path.join(root, 'preview');
    const siblingDir = path.join(root, 'preview-evil');
    fs.mkdirSync(allowedDir, { recursive: true });
    fs.mkdirSync(siblingDir, { recursive: true });

    const insideFile = path.join(allowedDir, 'index.html');
    const siblingFile = path.join(siblingDir, 'secret.txt');
    const singleFile = path.join(root, 'single.png');
    fs.writeFileSync(insideFile, '<h1>ok</h1>');
    fs.writeFileSync(siblingFile, 'secret');
    fs.writeFileSync(singleFile, 'png');

    const scope = new PreviewAssetScope();
    expect(scope.isAllowed(insideFile)).toBe(false);
    expect(scope.isAllowed(singleFile)).toBe(false);

    scope.allow({ directories: [allowedDir] });
    expect(scope.isAllowed(insideFile)).toBe(true);
    expect(scope.isAllowed(siblingFile)).toBe(false);
    expect(scope.isAllowed(path.join(allowedDir, '..', 'preview-evil', 'secret.txt'))).toBe(
      false
    );
    expect(scope.isAllowed(singleFile)).toBe(false);

    scope.allow({ path: singleFile });
    expect(scope.isAllowed(singleFile)).toBe(true);
  });
});

describe('resolveAppDistFile', () => {
  it('serves dist files, falls back to index.html for extensionless and dotted SPA routes, and blocks missing static assets and traversal', () => {
    const distDir = makeTempDir('dimo-dist-');
    const assetsDir = path.join(distDir, 'assets');
    fs.mkdirSync(assetsDir, { recursive: true });
    const indexHtml = path.join(distDir, 'index.html');
    const mainJs = path.join(assetsDir, 'main.js');
    fs.writeFileSync(indexHtml, '<!doctype html>');
    fs.writeFileSync(mainJs, 'console.log(1);');

    const realDist = fs.realpathSync(distDir);
    const expectedIndex = path.join(realDist, 'index.html');
    expect(resolveAppDistFile(distDir, 'dimo-app://localhost/')).toBe(expectedIndex);
    expect(resolveAppDistFile(distDir, 'dimo-app://localhost/assets/main.js')).toBe(
      path.join(realDist, 'assets', 'main.js')
    );
    // Extensionless SPA deep link falls back to index.html
    expect(resolveAppDistFile(distDir, 'dimo-app://localhost/settings/general')).toBe(
      expectedIndex
    );
    // Dotted SPA routes (e.g. reverse-DNS plugin IDs) also fall back to index.html
    expect(resolveAppDistFile(distDir, 'dimo-app://localhost/plugins/com.dimo.foo')).toBe(
      expectedIndex
    );
    expect(
      resolveAppDistFile(distDir, 'dimo-app://localhost/settings/plugin/com.dimo.foo')
    ).toBe(expectedIndex);
    // Explicit missing static asset extensions return null instead of HTML
    expect(resolveAppDistFile(distDir, 'dimo-app://localhost/assets/missing.js')).toBeNull();
    expect(resolveAppDistFile(distDir, 'dimo-app://localhost/assets/missing.css')).toBeNull();
    expect(resolveAppDistFile(distDir, 'dimo-app://localhost/assets/missing.png')).toBeNull();
    expect(resolveAppDistFile(distDir, 'dimo-app://localhost/assets/missing.json')).toBeNull();
    // Directory traversal outside dist root is blocked
    expect(resolveAppDistFile(distDir, 'dimo-app://localhost/..%2F..%2Fetc/passwd')).toBeNull();
    expect(resolveAppDistFile(distDir, 'dimo-app://other-host/index.html')).toBeNull();
  });
});

describe('dimo-app:// CSP & dimo-asset:// CORS/OPTIONS protocol handlers', () => {
  it('attaches Content-Security-Policy on dimo-app:// HTML responses but not on JS bundles', async () => {
    const distDir = makeTempDir('dimo-app-csp-');
    const assetsDir = path.join(distDir, 'assets');
    fs.mkdirSync(assetsDir, { recursive: true });
    fs.writeFileSync(path.join(distDir, 'index.html'), '<!doctype html><html></html>');
    fs.writeFileSync(path.join(assetsDir, 'main.js'), 'export const ok = true;');

    const rootRes = handleAppProtocolRequest(
      distDir,
      new Request('dimo-app://localhost/')
    );
    expect(rootRes.status).toBe(200);
    expect(rootRes.headers.get('content-security-policy')).toBe(
      APP_CONTENT_SECURITY_POLICY
    );
    expect(APP_CONTENT_SECURITY_POLICY).toContain("script-src 'self' dimo-app://localhost");
    expect(APP_CONTENT_SECURITY_POLICY).not.toContain('unsafe-eval');
    expect(await rootRes.text()).toContain('<!doctype html>');

    // Dotted SPA fallback also receives HTML + CSP
    const spaRes = handleAppProtocolRequest(
      distDir,
      new Request('dimo-app://localhost/plugins/com.dimo.foo')
    );
    expect(spaRes.status).toBe(200);
    expect(spaRes.headers.get('content-security-policy')).toBe(
      APP_CONTENT_SECURITY_POLICY
    );
    await spaRes.body?.cancel();

    // Static JS asset has no HTML CSP header
    const jsRes = handleAppProtocolRequest(
      distDir,
      new Request('dimo-app://localhost/assets/main.js')
    );
    expect(jsRes.status).toBe(200);
    expect(jsRes.headers.get('content-security-policy')).toBeNull();
    expect(await jsRes.text()).toBe('export const ok = true;');

    // Missing JS returns 404
    const missingRes = handleAppProtocolRequest(
      distDir,
      new Request('dimo-app://localhost/assets/missing.js')
    );
    expect(missingRes.status).toBe(404);
  });

  it('handles OPTIONS preflight and sets CORS headers on GET/HEAD/Range responses for dimo-asset://', async () => {
    const root = makeTempDir('dimo-asset-cors-');
    const moduleFile = path.join(root, 'app.mjs');
    fs.writeFileSync(moduleFile, 'export const answer = 42;\n');

    const scope = new PreviewAssetScope();
    scope.allow({ directories: [root] });
    const assetUrl = convertFileSrcToAssetUrl(moduleFile);

    const optionsRes = handleAssetProtocolRequest(
      scope,
      new Request(assetUrl, { method: 'OPTIONS' })
    );
    expect(optionsRes.status).toBe(204);
    expect(optionsRes.headers.get('access-control-allow-origin')).toBe('*');
    expect(optionsRes.headers.get('access-control-allow-methods')).toBe(
      'GET, HEAD, OPTIONS'
    );
    expect(optionsRes.headers.get('access-control-allow-headers')).toBe(
      'Range, Content-Type'
    );
    expect(optionsRes.headers.get('access-control-expose-headers')).toBe(
      'Content-Length, Content-Range, Accept-Ranges'
    );

    const getRes = handleAssetProtocolRequest(scope, new Request(assetUrl));
    expect(getRes.status).toBe(200);
    expect(getRes.headers.get('access-control-allow-origin')).toBe('*');
    expect(getRes.headers.get('access-control-expose-headers')).toBe(
      'Content-Length, Content-Range, Accept-Ranges'
    );
    expect(await getRes.text()).toBe('export const answer = 42;\n');

    const rangeRes = handleAssetProtocolRequest(
      scope,
      new Request(assetUrl, { headers: { Range: 'bytes=0-5' } })
    );
    expect(rangeRes.status).toBe(206);
    expect(rangeRes.headers.get('access-control-allow-origin')).toBe('*');
    expect(rangeRes.headers.get('access-control-expose-headers')).toBe(
      'Content-Length, Content-Range, Accept-Ranges'
    );
    expect(await rangeRes.text()).toBe('export');

    const headRes = handleAssetProtocolRequest(
      scope,
      new Request(assetUrl, { method: 'HEAD' })
    );
    expect(headRes.status).toBe(200);
    expect(headRes.headers.get('access-control-allow-origin')).toBe('*');
    expect(headRes.headers.get('access-control-expose-headers')).toBe(
      'Content-Length, Content-Range, Accept-Ranges'
    );
  });
});

describe('toSafeWebStream', () => {
  it('propagates mid-read Node stream errors to the Web reader without uncaught EventEmitter errors', async () => {
    const nodeStream = new PassThrough();
    const webStream = toSafeWebStream(nodeStream);
    const reader = webStream.getReader();

    nodeStream.write(Buffer.from('hello'));
    const first = await reader.read();
    expect(first.done).toBe(false);
    expect(Buffer.from(first.value!).toString()).toBe('hello');

    const readNext = reader.read();
    nodeStream.destroy(new Error('simulated EIO'));

    await expect(readNext).rejects.toThrow('simulated EIO');
  });

  it('destroys the underlying Node stream on reader cancel and ignores late stream errors', async () => {
    const nodeStream = new PassThrough();
    const webStream = toSafeWebStream(nodeStream);
    const reader = webStream.getReader();

    await reader.cancel('seek aborted');
    expect(nodeStream.destroyed).toBe(true);

    // Emitting a late error must not throw an uncaught EventEmitter error.
    expect(() => nodeStream.emit('error', new Error('late error'))).not.toThrow();
  });

  it('destroys the underlying Node stream when the request AbortSignal aborts', async () => {
    const controller = new AbortController();
    const nodeStream = new PassThrough();
    const webStream = toSafeWebStream(nodeStream, controller.signal);
    const reader = webStream.getReader();

    controller.abort();
    expect(nodeStream.destroyed).toBe(true);

    const end = await reader.read();
    expect(end.done).toBe(true);
  });
});

describe('parseByteRange & mimeTypeForPath', () => {
  it('parses bounded, open-ended, suffix, and invalid byte ranges', () => {
    expect(parseByteRange(null, 100)).toBeNull();
    expect(parseByteRange('bytes=0-9', 100)).toEqual({ start: 0, end: 9 });
    expect(parseByteRange('bytes=50-', 100)).toEqual({ start: 50, end: 99 });
    expect(parseByteRange('bytes=-10', 100)).toEqual({ start: 90, end: 99 });
    expect(parseByteRange('bytes=90-500', 100)).toEqual({ start: 90, end: 99 });
    expect(parseByteRange('bytes=100-120', 100)).toBe('invalid');
    expect(parseByteRange('bytes=20-10', 100)).toBe('invalid');
    expect(parseByteRange('items=0-5', 100)).toBe('invalid');
  });

  it('resolves common MIME types', () => {
    expect(mimeTypeForPath('index.html')).toContain('text/html');
    expect(mimeTypeForPath('video.mp4')).toBe('video/mp4');
    expect(mimeTypeForPath('unknown.binxyz')).toBe('application/octet-stream');
  });
});
