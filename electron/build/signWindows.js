const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

let loggedUnsignedNotice = false;

function resolveSigningMode(configuration, env = process.env) {
  if (env.EVSIGN_LICENSE_KEY && env.EVSIGN_LICENSE_KEY.trim().length > 0) {
    return 'evsign';
  }
  if (configuration && configuration.cscInfo != null) {
    return 'signtool';
  }
  return 'unsigned';
}

function resolvePowerShellExecutable(env = process.env) {
  const pathEnv = env.PATH || env.Path || '';
  for (const dir of pathEnv.split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, 'pwsh.exe');
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return 'powershell.exe';
}

async function signWindows(configuration, packager) {
  const mode = resolveSigningMode(configuration, process.env);

  if (mode === 'evsign') {
    // EVSign performs a single SHA-256 Authenticode pass; ignore nested passes.
    if (configuration.isNest) {
      return;
    }
    if (process.platform !== 'win32') {
      throw new Error(
        'EVSign Windows code signing requires running on a Windows host.'
      );
    }

    const evsignScript = path.resolve(
      __dirname,
      '..',
      '..',
      'scripts',
      'sign-windows-evsign.ps1'
    );
    const psExe = resolvePowerShellExecutable(process.env);
    console.log(`[signWindows] EVSigning ${configuration.path}`);
    execFileSync(
      psExe,
      [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        evsignScript,
        '-FilePath',
        configuration.path,
        '-KeepCli',
      ],
      {
        stdio: 'inherit',
        env: process.env,
      }
    );
    return;
  }

  if (mode === 'signtool') {
    const signingManager = await packager.signingManager.value;
    await signingManager.doSign(configuration, packager);
    if (
      configuration.resultOutputPath != null &&
      fs.existsSync(configuration.resultOutputPath)
    ) {
      fs.renameSync(configuration.resultOutputPath, configuration.path);
    }
    return;
  }

  if (packager && packager.forceCodeSigning) {
    throw new Error(
      'forceCodeSigning is enabled but neither EVSIGN_LICENSE_KEY nor a Windows signing certificate is configured.'
    );
  }

  if (!loggedUnsignedNotice) {
    loggedUnsignedNotice = true;
    console.log(
      '[signWindows] no Windows signing credentials configured; skipping Authenticode signing'
    );
  }
}

module.exports = signWindows;
module.exports.default = signWindows;
module.exports.sign = signWindows;
module.exports.resolveSigningMode = resolveSigningMode;
module.exports.resolvePowerShellExecutable = resolvePowerShellExecutable;
