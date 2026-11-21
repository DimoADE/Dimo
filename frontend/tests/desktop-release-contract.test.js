import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..', '..');

function read(relativePath) {
  return fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');
}

function readJson(relativePath) {
  return JSON.parse(read(relativePath));
}

test('desktop release version stays aligned across root, frontend, and electron', () => {
  const rootVersion = readJson('package.json').version;
  const frontendVersion = readJson('frontend/package.json').version;
  const electronVersion = readJson('electron/package.json').version;

  assert.equal(frontendVersion, rootVersion);
  assert.equal(electronVersion, rootVersion);
});

test('main Electron window stays hidden until ready to show', () => {
  const windowsTs = read('electron/src/main/windows.ts');
  assert.match(windowsTs, /show:\s*false/);
});

test('Electron packaging config declares Dimo identity, protocol, and 5-platform targets', () => {
  const builderYml = read('electron/electron-builder.yml');

  assert.match(builderYml, /^appId:\s*com\.dimo\.app$/m);
  assert.match(builderYml, /^productName:\s*Dimo$/m);
  assert.match(builderYml, /-\s*dimo\b/);
  assert.match(builderYml, /entitlements:\s*build\/entitlements\.mac\.plist/);
  assert.equal(
    fs.existsSync(path.join(repoRoot, 'electron/build/entitlements.mac.plist')),
    true
  );
  assert.equal(
    fs.existsSync(path.join(repoRoot, 'electron/build/installer.nsh')),
    true
  );
});

test('desktop release builds every supported OS and CPU architecture with D1 Tauri bridge', () => {
  const workflow = read('.github/workflows/desktop-release.yml');
  const bridge = read('scripts/generate-tauri-bridge-manifest.js');
  const targets = [
    'x86_64-pc-windows-msvc',
    'aarch64-pc-windows-msvc',
    'x86_64-unknown-linux-gnu',
    'aarch64-unknown-linux-gnu',
    'aarch64-apple-darwin',
  ];

  for (const target of targets) {
    assert.match(workflow, new RegExp(`target: ${target}`));
  }
  for (const platform of [
    'windows-x86_64',
    'windows-aarch64',
    'linux-x86_64',
    'linux-aarch64',
    'darwin-aarch64',
  ]) {
    assert.match(bridge, new RegExp(`['"]${platform}['"]`));
  }
  assert.doesNotMatch(workflow, /x86_64-apple-darwin/);
});

test('desktop release signs and verifies macOS and Windows artifacts', () => {
  const workflow = read('.github/workflows/desktop-release.yml');

  for (const requiredText of [
    'APPLE_CERTIFICATE',
    'APPLE_CERTIFICATE_PASSWORD',
    'APPLE_SIGNING_IDENTITY',
    'APPLE_API_ISSUER',
    'APPLE_API_KEY',
    'WINDOWS_CERTIFICATE',
    'WINDOWS_CERTIFICATE_PASSWORD',
    'EVSIGN_LICENSE_KEY',
    'scripts/sign-windows-evsign.ps1',
    'codesign --verify --deep --strict',
    'Get-AuthenticodeSignature',
  ]) {
    assert.match(workflow, new RegExp(requiredText));
  }
});

test('Windows EVSign signing refreshes D1 bridge signatures via dlx after Authenticode', () => {
  const script = read('scripts/sign-windows-evsign.ps1');

  assert.match(
    script,
    /releases\/download\/evsign-cli-1\.0\.1\/evsign-client-cli-win_v1\.0\.1\.exe/
  );
  assert.match(script, /Get-FileHash -Algorithm SHA256/);
  assert.match(script, /-cdn/);
  assert.match(script, /@tauri-apps\/cli@2\.10\.0/);
  assert.match(script, /TAURI_SIGNING_PRIVATE_KEY/);
});

test('desktop release runs platform-native startup smoke tests', () => {
  const workflow = read('.github/workflows/desktop-release.yml');

  for (const script of [
    'scripts/smoke-windows-desktop.ps1',
    'scripts/smoke-macos-desktop.sh',
    'scripts/smoke-linux-desktop.sh',
  ]) {
    assert.ok(
      fs.existsSync(path.join(repoRoot, script)),
      `${script} must exist`
    );
    assert.ok(
      workflow.includes(script),
      `${script} must run in desktop release CI`
    );
  }
});
