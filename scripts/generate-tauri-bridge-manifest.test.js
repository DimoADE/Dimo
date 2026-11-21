const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  generateTauriBridgeManifest,
  refreshElectronFeedHashes,
  sha512Base64,
} = require('./generate-tauri-bridge-manifest');

function writeArtifact(root, relPath, contents) {
  const fullPath = path.join(root, relPath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, contents);
  return fullPath;
}

test('generates Tauri bridge latest.json and refreshes all 5 Electron updater feeds', () => {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dimo-bridge-'));
  const artifactsDir = path.join(workDir, 'artifacts');
  const outputDir = path.join(workDir, 'release');
  const version = '0.6.0';

  const winX64Exe = writeArtifact(
    artifactsDir,
    `Dimo-windows-x64/Dimo-${version}-windows-x64-setup.exe`,
    'signed-win-x64-binary'
  );
  writeArtifact(
    artifactsDir,
    `Dimo-windows-x64/Dimo-${version}-windows-x64-setup.exe.sig`,
    'sig-win-x64\n'
  );
  writeArtifact(
    artifactsDir,
    `Dimo-windows-x64/Dimo-${version}-windows-x64-setup.exe.blockmap`,
    'blockmap-x64'
  );
  writeArtifact(
    artifactsDir,
    'Dimo-windows-x64/latest.yml',
    [
      `version: ${version}`,
      'files:',
      `  - url: Dimo-${version}-windows-x64-setup.exe`,
      '    sha512: STALE_PRE_EVSIGN_HASH',
      '    size: 1',
      `path: Dimo-${version}-windows-x64-setup.exe`,
      'sha512: STALE_PRE_EVSIGN_HASH',
      'releaseDate: "2026-11-20T00:00:00.000Z"',
    ].join('\n')
  );

  const winArm64Exe = writeArtifact(
    artifactsDir,
    `Dimo-windows-arm64/Dimo-${version}-windows-arm64-setup.exe`,
    'signed-win-arm64-binary'
  );
  writeArtifact(
    artifactsDir,
    `Dimo-windows-arm64/Dimo-${version}-windows-arm64-setup.exe.sig`,
    'sig-win-arm64\n'
  );
  writeArtifact(
    artifactsDir,
    `Dimo-windows-arm64/Dimo-${version}-windows-arm64-setup.exe.blockmap`,
    'blockmap-arm64'
  );
  writeArtifact(
    artifactsDir,
    'Dimo-windows-arm64/latest.yml',
    [
      `version: ${version}`,
      'files:',
      `  - url: Dimo-${version}-windows-arm64-setup.exe`,
      '    sha512: OLD_ARM64_HASH',
      '    size: 2',
      `path: Dimo-${version}-windows-arm64-setup.exe`,
      'sha512: OLD_ARM64_HASH',
    ].join('\n')
  );

  writeArtifact(
    artifactsDir,
    `Dimo-linux-x64/Dimo-${version}-linux-x64.AppImage`,
    'linux-x64-appimage'
  );
  writeArtifact(
    artifactsDir,
    `Dimo-linux-x64/Dimo-${version}-linux-x64.AppImage.sig`,
    'sig-linux-x64'
  );
  writeArtifact(
    artifactsDir,
    `Dimo-linux-x64/Dimo-${version}-linux-x64.deb`,
    'linux-x64-deb'
  );
  writeArtifact(
    artifactsDir,
    'Dimo-linux-x64/latest-linux.yml',
    `version: ${version}\npath: Dimo-${version}-linux-x64.AppImage\nsha512: old\n`
  );

  writeArtifact(
    artifactsDir,
    `Dimo-linux-arm64/Dimo-${version}-linux-arm64.AppImage`,
    'linux-arm64-appimage'
  );
  writeArtifact(
    artifactsDir,
    `Dimo-linux-arm64/Dimo-${version}-linux-arm64.AppImage.sig`,
    'sig-linux-arm64'
  );
  writeArtifact(
    artifactsDir,
    'Dimo-linux-arm64/latest-linux-arm64.yml',
    `version: ${version}\npath: Dimo-${version}-linux-arm64.AppImage\nsha512: old\n`
  );

  const macZip = writeArtifact(
    artifactsDir,
    `Dimo-macos-arm64/Dimo-${version}-darwin-arm64.zip`,
    'macos-arm64-zip'
  );
  writeArtifact(
    artifactsDir,
    `Dimo-macos-arm64/Dimo-${version}-darwin-arm64.dmg`,
    'macos-arm64-dmg'
  );
  writeArtifact(
    artifactsDir,
    `Dimo-macos-arm64/Dimo-${version}-darwin-arm64.app.tar.gz`,
    'macos-arm64-tauri-bridge-tarball'
  );
  writeArtifact(
    artifactsDir,
    `Dimo-macos-arm64/Dimo-${version}-darwin-arm64.app.tar.gz.sig`,
    'sig-darwin-arm64'
  );
  writeArtifact(
    artifactsDir,
    'Dimo-macos-arm64/latest-mac.yml',
    [
      `version: ${version}`,
      'files:',
      `  - url: Dimo-${version}-darwin-arm64.zip`,
      '    sha512: old-zip-hash',
      '    size: 1',
      `path: Dimo-${version}-darwin-arm64.zip`,
      'sha512: old-zip-hash',
    ].join('\n')
  );

  const { manifestPath, publishedFeeds } = generateTauriBridgeManifest({
    artifactsDir,
    outputDir,
    repository: 'DimoADE/Dimo',
    releaseTag: `v${version}`,
    version,
    notes: 'Electron transition release',
    pubDate: '2026-11-20T12:00:00Z',
  });

  assert.equal(publishedFeeds.length, 5);
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  assert.equal(manifest.version, version);
  assert.equal(manifest.notes, 'Electron transition release');
  assert.deepEqual(Object.keys(manifest.platforms).sort(), [
    'darwin-aarch64',
    'linux-aarch64',
    'linux-x86_64',
    'windows-aarch64',
    'windows-x86_64',
  ]);
  assert.equal(manifest.platforms['windows-x86_64'].signature, 'sig-win-x64');
  assert.equal(
    manifest.platforms['windows-x86_64'].url,
    `https://github.com/DimoADE/Dimo/releases/download/v${version}/Dimo-${version}-windows-x64-setup.exe`
  );
  assert.equal(
    manifest.platforms['darwin-aarch64'].url,
    `https://github.com/DimoADE/Dimo/releases/download/v${version}/Dimo-${version}-darwin-arm64.app.tar.gz`
  );

  // Verify latest.yml / latest-arm64.yml hashes, sizes, and .blockmap propagation
  const winX64Feed = fs.readFileSync(path.join(outputDir, 'latest.yml'), 'utf8');
  assert.ok(winX64Feed.includes(`sha512: ${sha512Base64(winX64Exe)}`));
  assert.ok(winX64Feed.includes(`size: ${fs.statSync(winX64Exe).size}`));
  assert.ok(!winX64Feed.includes('STALE_PRE_EVSIGN_HASH'));
  assert.equal(
    fs.existsSync(
      path.join(outputDir, `Dimo-${version}-windows-x64-setup.exe.blockmap`)
    ),
    true
  );

  const winArm64Feed = fs.readFileSync(
    path.join(outputDir, 'latest-arm64.yml'),
    'utf8'
  );
  assert.ok(winArm64Feed.includes(`sha512: ${sha512Base64(winArm64Exe)}`));
  assert.equal(
    fs.existsSync(
      path.join(outputDir, `Dimo-${version}-windows-arm64-setup.exe.blockmap`)
    ),
    true
  );

  const macFeed = fs.readFileSync(path.join(outputDir, 'latest-mac.yml'), 'utf8');
  assert.ok(macFeed.includes(`sha512: ${sha512Base64(macZip)}`));
  assert.equal(
    fs.existsSync(path.join(outputDir, `Dimo-${version}-darwin-arm64.dmg`)),
    true
  );
  assert.equal(
    fs.existsSync(path.join(outputDir, `Dimo-${version}-linux-x64.deb`)),
    true
  );
});

test('refreshElectronFeedHashes preserves already-signed feed hashes and sizes verbatim', () => {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dimo-signed-feed-'));
  const exePath = writeArtifact(
    workDir,
    'Dimo-0.6.0-windows-x64-setup.exe',
    'in-builder-evsigned-nsis-installer'
  );
  const sha = sha512Base64(exePath);
  const size = fs.statSync(exePath).size;
  const sample = [
    'version: 0.6.0',
    'files:',
    '  - url: Dimo-0.6.0-windows-x64-setup.exe',
    `    sha512: ${sha}`,
    `    size: ${size}`,
    'path: Dimo-0.6.0-windows-x64-setup.exe',
    `sha512: ${sha}`,
    'releaseDate: "2026-11-21T00:00:00.000Z"',
    '',
  ].join('\n');
  assert.equal(refreshElectronFeedHashes(sample, workDir), sample);
});

test('refreshElectronFeedHashes preserves unrelated lines when files are absent', () => {
  const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dimo-empty-feed-'));
  const sample = 'version: 0.6.0\npath: missing.exe\nsha512: original\n';
  assert.equal(refreshElectronFeedHashes(sample, emptyDir), sample);
});
