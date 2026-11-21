import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  convertFileSrcToAssetUrl,
  decodeAssetUrlPath,
} from '../shared/ipcContract';
import {
  PreviewAssetScope,
  mimeTypeForPath,
  parseByteRange,
  resolveAppDistFile,
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
  it('serves dist files, falls back to index.html for SPA routes, and blocks path traversal', () => {
    const distDir = makeTempDir('dimo-dist-');
    const assetsDir = path.join(distDir, 'assets');
    fs.mkdirSync(assetsDir, { recursive: true });
    const indexHtml = path.join(distDir, 'index.html');
    const mainJs = path.join(assetsDir, 'main.js');
    fs.writeFileSync(indexHtml, '<!doctype html>');
    fs.writeFileSync(mainJs, 'console.log(1);');

    const realDist = fs.realpathSync(distDir);
    expect(resolveAppDistFile(distDir, 'dimo-app://localhost/')).toBe(
      path.join(realDist, 'index.html')
    );
    expect(resolveAppDistFile(distDir, 'dimo-app://localhost/assets/main.js')).toBe(
      path.join(realDist, 'assets', 'main.js')
    );
    // SPA deep link falls back to index.html
    expect(resolveAppDistFile(distDir, 'dimo-app://localhost/settings/general')).toBe(
      path.join(realDist, 'index.html')
    );
    // Explicit missing asset extension returns null instead of HTML
    expect(resolveAppDistFile(distDir, 'dimo-app://localhost/assets/missing.js')).toBeNull();
    // Directory traversal outside dist root is blocked
    expect(resolveAppDistFile(distDir, 'dimo-app://localhost/..%2F..%2Fetc/passwd')).toBeNull();
    expect(resolveAppDistFile(distDir, 'dimo-app://other-host/index.html')).toBeNull();
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
