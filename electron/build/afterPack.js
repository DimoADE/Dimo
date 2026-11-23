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

const MAC_IDENTITY_PREFIXES = [
  'Developer ID Application:',
  'Developer ID Installer:',
  'Apple Development:',
  'Apple Distribution:',
  'Mac Developer:',
  '3rd Party Mac Developer Application:',
  '3rd Party Mac Developer Installer:',
];

const NON_BINARY_EXTENSIONS = new Set([
  '.txt',
  '.md',
  '.json',
  '.yml',
  '.yaml',
  '.toml',
  '.sig',
  '.sha256',
  '.map',
  '.plist',
  '.xml',
  '.log',
]);

function resolveMacSigningIdentity(env = process.env) {
  const explicit = env.APPLE_SIGNING_IDENTITY?.trim();
  if (explicit) {
    return explicit;
  }
  const cscName = env.CSC_NAME?.trim();
  if (!cscName) {
    return null;
  }
  if (
    cscName === '-' ||
    /^[0-9a-fA-F]{40}$/.test(cscName) ||
    MAC_IDENTITY_PREFIXES.some((prefix) => cscName.startsWith(prefix))
  ) {
    return cscName;
  }
  return `Developer ID Application: ${cscName}`;
}

function isDynamicLibrary(filePath) {
  const name = path.basename(filePath).toLowerCase();
  return name.endsWith('.dylib') || name.endsWith('.so') || /\.so\.[0-9.]+$/.test(name);
}

function isSidecarTargetFile(filePath) {
  const name = path.basename(filePath);
  if (name.startsWith('.')) {
    return false;
  }
  const ext = path.extname(name).toLowerCase();
  if (NON_BINARY_EXTENSIONS.has(ext)) {
    return false;
  }
  return true;
}

function collectSidecarBinaries(binDir) {
  if (!fs.existsSync(binDir)) {
    return [];
  }
  const libraries = [];
  const executables = [];
  const walk = (dir) => {
    const entries = fs
      .readdirSync(dir, { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
      } else if (entry.isFile() && isSidecarTargetFile(fullPath)) {
        if (isDynamicLibrary(fullPath)) {
          libraries.push(fullPath);
        } else {
          executables.push(fullPath);
        }
      }
    }
  };
  walk(binDir);
  // Sign/chmod libraries before executables so nested references are already signed.
  return [...libraries, ...executables];
}

function resolveUnixSidecarBinDir(context) {
  if (context.electronPlatformName === 'darwin') {
    const appName = `${context.packager.appInfo.productFilename}.app`;
    return path.join(
      context.appOutDir,
      appName,
      'Contents',
      'Resources',
      'bin'
    );
  }
  return path.join(context.appOutDir, 'resources', 'bin');
}

function ensureUnixSidecarPermissions(context, { chmod = fs.chmodSync } = {}) {
  const binDir = resolveUnixSidecarBinDir(context);
  const targets = collectSidecarBinaries(binDir);
  for (const binPath of targets) {
    chmod(binPath, 0o755);
  }
  return targets;
}

function signMacSidecars(
  context,
  {
    env = process.env,
    chmod = fs.chmodSync,
    execFile = execFileSync,
  } = {}
) {
  const binDir = resolveUnixSidecarBinDir(context);
  const targets = collectSidecarBinaries(binDir);
  if (targets.length === 0) {
    return [];
  }

  for (const binPath of targets) {
    chmod(binPath, 0o755);
  }

  const identity = resolveMacSigningIdentity(env);
  if (!identity) {
    return targets;
  }

  const entitlements = path.resolve(__dirname, 'entitlements.mac.plist');
  for (const binPath of targets) {
    const relName = path.relative(binDir, binPath);
    const args = isDynamicLibrary(binPath)
      ? ['--force', '--timestamp', '--sign', identity, binPath]
      : [
          '--force',
          '--options',
          'runtime',
          '--timestamp',
          '--entitlements',
          entitlements,
          '--sign',
          identity,
          binPath,
        ];
    execFile('codesign', args, { stdio: 'inherit' });
    console.log(`[afterPack] codesigned macOS sidecar: ${relName}`);
  }
  return targets;
}

async function afterPack(context) {
  if (context.electronPlatformName === 'darwin') {
    signMacSidecars(context);
    return;
  }
  if (context.electronPlatformName === 'linux') {
    ensureUnixSidecarPermissions(context);
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
exports.resolveMacSigningIdentity = resolveMacSigningIdentity;
exports.collectSidecarBinaries = collectSidecarBinaries;
exports.ensureUnixSidecarPermissions = ensureUnixSidecarPermissions;
exports.signMacSidecars = signMacSidecars;
