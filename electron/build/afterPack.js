const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { resolvePowerShellExecutable } = require('./signWindows');

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

function parsePublisherNameEnv(rawValue) {
  if (typeof rawValue !== 'string') {
    return null;
  }
  const trimmed = rawValue.trim();
  if (!trimmed) {
    return null;
  }
  if (trimmed.startsWith('[')) {
    const parsed = JSON.parse(trimmed);
    if (
      !Array.isArray(parsed) ||
      parsed.length === 0 ||
      parsed.some((entry) => typeof entry !== 'string' || !entry.trim())
    ) {
      throw new Error(
        'EVSIGN_PUBLISHER_NAME JSON array must contain non-empty strings.'
      );
    }
    return parsed.map((entry) => entry.trim());
  }
  return [trimmed];
}

function findSignedWindowsSidecar(appOutDir) {
  const binDir = path.join(appOutDir, 'resources', 'bin');
  if (!fs.existsSync(binDir)) {
    return null;
  }
  const preferred = path.join(binDir, 'dimo-server.exe');
  if (fs.existsSync(preferred)) {
    return preferred;
  }
  const entries = fs.readdirSync(binDir).sort();
  for (const entry of entries) {
    if (entry.toLowerCase().endsWith('.exe')) {
      return path.join(binDir, entry);
    }
  }
  return null;
}

function readAuthenticodeSubject(filePath, env = process.env) {
  const escaped = filePath.replace(/'/g, "''");
  const psExe = resolvePowerShellExecutable(env);
  const command =
    "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); " +
    `$sig = Get-AuthenticodeSignature -LiteralPath '${escaped}'; ` +
    "[PSCustomObject]@{ Status = [int]$sig.Status; StatusText = [string]$sig.Status; Subject = if ($sig.SignerCertificate) { $sig.SignerCertificate.Subject } else { $null } } | ConvertTo-Json -Compress";
  const stdout = execFileSync(
    psExe,
    ['-NoProfile', '-NonInteractive', '-Command', command],
    { encoding: 'utf8', env }
  ).trim();
  const parsed = JSON.parse(stdout);
  if (parsed.Status !== 0 && parsed.StatusText !== 'Valid') {
    throw new Error(
      `Expected valid Authenticode signature on ${filePath}, got ${parsed.StatusText || parsed.Status}`
    );
  }
  const subject = typeof parsed.Subject === 'string' ? parsed.Subject.trim() : '';
  if (!subject) {
    throw new Error(
      `Authenticode signature on ${filePath} is missing SignerCertificate.Subject`
    );
  }
  return subject;
}

function appendPublisherNameToUpdateConfig(yamlContent, publisherNames) {
  if (/^\s*publisherName\s*:/m.test(yamlContent)) {
    return yamlContent;
  }
  const normalized = yamlContent.replace(/\r?\n*$/, '\n');
  const lines = [
    'publisherName:',
    ...publisherNames.map((name) => `  - ${JSON.stringify(name)}`),
  ];
  return `${normalized}${lines.join('\n')}\n`;
}

// PublishManager writes resources/app-update.yml in its system afterPack
// listener (which always runs before user afterPack hooks), after extraResources
// sidecars have already been signed by win.signtoolOptions.sign. Because EVSign
// has no local PFX certificate for electron-builder to inspect, inject the
// signer DN here so NsisUpdater.verifySignature() enforces Authenticode checks.
function ensureWindowsEvsignPublisherName(
  context,
  {
    env = process.env,
    readSubject = (filePath) => readAuthenticodeSubject(filePath, env),
  } = {}
) {
  if (context.electronPlatformName !== 'win32') {
    return false;
  }
  if (!env.EVSIGN_LICENSE_KEY || !env.EVSIGN_LICENSE_KEY.trim()) {
    return false;
  }

  const appUpdatePath = path.join(
    context.appOutDir,
    'resources',
    'app-update.yml'
  );
  if (!fs.existsSync(appUpdatePath)) {
    return false;
  }

  const existingYaml = fs.readFileSync(appUpdatePath, 'utf8');
  if (/^\s*publisherName\s*:/m.test(existingYaml)) {
    return false;
  }

  let publisherNames = parsePublisherNameEnv(env.EVSIGN_PUBLISHER_NAME);
  if (!publisherNames) {
    const signedSidecar = findSignedWindowsSidecar(context.appOutDir);
    if (!signedSidecar) {
      throw new Error(
        `Cannot derive EVSign publisherName: no signed sidecar found under ${path.join(context.appOutDir, 'resources', 'bin')}`
      );
    }
    publisherNames = [readSubject(signedSidecar)];
  }

  const updatedYaml = appendPublisherNameToUpdateConfig(
    existingYaml,
    publisherNames
  );
  fs.writeFileSync(appUpdatePath, updatedYaml, 'utf8');
  console.log(
    `[afterPack] wrote Windows EVSign publisherName to app-update.yml (${publisherNames.join(' | ')})`
  );
  return true;
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

async function afterPack(context) {
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
  ensureWindowsEvsignPublisherName(context);
}

exports.default = afterPack;
exports.afterPack = afterPack;
exports.parsePublisherNameEnv = parsePublisherNameEnv;
exports.appendPublisherNameToUpdateConfig = appendPublisherNameToUpdateConfig;
exports.ensureWindowsEvsignPublisherName = ensureWindowsEvsignPublisherName;
exports.readAuthenticodeSubject = readAuthenticodeSubject;
