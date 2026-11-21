const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const KEEP_LOCALES = new Set([
  'en-US.pak',
  'zh-CN.pak',
  'zh-TW.pak',
  'ja.pak',
  'ko.pak',
]);

function pruneChromiumLocales(appOutDir) {
  const localesDir = path.join(appOutDir, 'locales');
  if (!fs.existsSync(localesDir)) {
    return 0;
  }
  let removed = 0;
  for (const entry of fs.readdirSync(localesDir)) {
    if (!entry.endsWith('.pak') || KEEP_LOCALES.has(entry)) {
      continue;
    }
    fs.rmSync(path.join(localesDir, entry), { force: true });
    removed += 1;
  }
  return removed;
}

function signMacSidecars(context) {
  const identity = process.env.APPLE_SIGNING_IDENTITY?.trim();
  if (!identity) {
    return;
  }
  const appName = `${context.packager.appInfo.productFilename}.app`;
  const binDir = path.join(
    context.appOutDir,
    appName,
    'Contents',
    'Resources',
    'bin'
  );
  if (!fs.existsSync(binDir)) {
    return;
  }
  const entitlements = path.resolve(__dirname, 'entitlements.mac.plist');
  for (const entry of fs.readdirSync(binDir, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const binPath = path.join(binDir, entry.name);
    fs.chmodSync(binPath, 0o755);
    execFileSync(
      'codesign',
      [
        '--force',
        '--options',
        'runtime',
        '--timestamp',
        '--entitlements',
        entitlements,
        '--sign',
        identity,
        binPath,
      ],
      { stdio: 'inherit' }
    );
    console.log(`[afterPack] codesigned macOS sidecar: ${entry.name}`);
  }
}

exports.default = async function afterPack(context) {
  if (context.electronPlatformName === 'darwin') {
    signMacSidecars(context);
    return;
  }
  const removed = pruneChromiumLocales(context.appOutDir);
  if (removed > 0) {
    console.log(
      `[afterPack] pruned ${removed} unused Chromium locale .pak files`
    );
  }
};
