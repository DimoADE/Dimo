#!/usr/bin/env node

const { execSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

function rustcHost() {
  const output = execSync("rustc -vV", { encoding: "utf8" });
  const match = output.match(/^host: (\S+)$/m);
  if (!match) {
    throw new Error("could not read rustc host triple");
  }
  return match[1];
}

function resolveTargetTriple(env = process.env, hostTriple = rustcHost()) {
  return env.DIMO_BUILD_TARGET || env.TAURI_ENV_TARGET_TRIPLE || hostTriple;
}

function resolveSidecarProfile(env = process.env) {
  if (env.CARGO_PROFILE) {
    return env.CARGO_PROFILE;
  }
  return env.TAURI_ENV_DEBUG === "true" ? "debug" : "release";
}

function resolveSidecarBinDir({
  repo,
  env = process.env,
  hostTriple,
} = {}) {
  const resolvedRepo = repo || path.resolve(__dirname, "..");
  const triple = resolveTargetTriple(env, hostTriple);
  const profile = resolveSidecarProfile(env);
  const targetDir = env.CARGO_TARGET_DIR || path.join(resolvedRepo, "target");
  return {
    triple,
    profile,
    binDir: path.join(targetDir, triple, profile),
    nativeBinDir: path.join(targetDir, profile),
  };
}

function sidecarFileName(name, platform = process.platform) {
  return platform === "win32" ? `${name}.exe` : name;
}

function isBuiltSidecar(filePath) {
  try {
    const stat = fs.statSync(filePath);
    return stat.isFile() && stat.size > 0;
  } catch {
    return false;
  }
}

function sidecarBinsExist({
  repo,
  env = process.env,
  hostTriple,
  platform = process.platform,
} = {}) {
  const { binDir, nativeBinDir } = resolveSidecarBinDir({
    repo,
    env,
    hostTriple,
  });
  return ["dimo-mcp", "dimo-workflow-mcp"].every((name) => {
    const file = sidecarFileName(name, platform);
    return (
      isBuiltSidecar(path.join(binDir, file)) ||
      isBuiltSidecar(path.join(nativeBinDir, file))
    );
  });
}

function resolveSidecarSource(name, binDir, nativeBinDir, platform = process.platform) {
  const file = sidecarFileName(name, platform);
  const triplePath = path.join(binDir, file);
  if (isBuiltSidecar(triplePath)) {
    return triplePath;
  }
  const nativePath = path.join(nativeBinDir, file);
  if (isBuiltSidecar(nativePath)) {
    return nativePath;
  }
  throw new Error(`missing or empty sidecar ${triplePath}`);
}

function sweepRetiredStagedSidecars(destinationDir, baseFileName) {
  let entries;
  try {
    entries = fs.readdirSync(destinationDir);
  } catch {
    return;
  }
  const oldPrefix = `${baseFileName}.old-`;
  const tmpPrefix = `${baseFileName}.tmp-`;
  for (const entry of entries) {
    if (entry.startsWith(oldPrefix) || entry.startsWith(tmpPrefix)) {
      try {
        fs.unlinkSync(path.join(destinationDir, entry));
      } catch {
        // Still mapped on Windows; leave for a later sweep.
      }
    }
  }
}

const ELECTRON_SIDECAR_BINS = [
  "dimo-server",
  "dimo-mcp",
  "dimo-workflow-mcp",
];

function copyBinaryAtomic(sourcePath, destinationDir, baseFileName) {
  if (!isBuiltSidecar(sourcePath)) {
    throw new Error(`missing or empty sidecar ${sourcePath}`);
  }
  fs.mkdirSync(destinationDir, { recursive: true });
  sweepRetiredStagedSidecars(destinationDir, baseFileName);

  const to = path.join(destinationDir, baseFileName);
  const tmp = path.join(
    destinationDir,
    `${baseFileName}.tmp-${process.pid}-${Date.now()}`
  );
  fs.copyFileSync(sourcePath, tmp);
  if (process.platform !== "win32") {
    fs.chmodSync(tmp, 0o755);
  }

  try {
    fs.renameSync(tmp, to);
  } catch (error) {
    if (fs.existsSync(to)) {
      try {
        fs.renameSync(
          to,
          path.join(
            destinationDir,
            `${baseFileName}.old-${process.pid}-${Date.now()}`
          )
        );
        fs.renameSync(tmp, to);
      } catch (retryError) {
        fs.rmSync(tmp, { force: true });
        throw retryError;
      }
    } else {
      fs.rmSync(tmp, { force: true });
      throw error;
    }
  }

  if (!isBuiltSidecar(to)) {
    throw new Error(`staged sidecar is empty: ${to}`);
  }
  return to;
}

function copySidecar(name, sourcePath, destinationDir, triple, platform = process.platform) {
  const ext = platform === "win32" ? ".exe" : "";
  const baseFileName = `${name}-${triple}${ext}`;
  return copyBinaryAtomic(sourcePath, destinationDir, baseFileName);
}

function copyPlainSidecar(name, sourcePath, destinationDir, platform = process.platform) {
  const baseFileName = sidecarFileName(name, platform);
  return copyBinaryAtomic(sourcePath, destinationDir, baseFileName);
}

function stageElectronSidecars({
  repo,
  env = process.env,
  hostTriple,
  platform = process.platform,
  destinationDir,
} = {}) {
  const resolvedRepo = repo || path.resolve(__dirname, "..");
  const { binDir, nativeBinDir } = resolveSidecarBinDir({
    repo: resolvedRepo,
    env,
    hostTriple,
  });
  const targetDir =
    destinationDir || path.join(resolvedRepo, "electron", "resources", "bin");
  const staged = [];
  for (const name of ELECTRON_SIDECAR_BINS) {
    const src = resolveSidecarSource(name, binDir, nativeBinDir, platform);
    staged.push(copyPlainSidecar(name, src, targetDir, platform));
  }
  return staged;
}

function parseCliArgs(argv) {
  let target = null;
  let profile = null;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--electron") {
      // Accepted for backwards compatibility; Electron staging is the default.
    } else if (arg === "--target" && argv[i + 1]) {
      target = argv[i + 1];
      i += 1;
    } else if (arg.startsWith("--target=")) {
      target = arg.slice("--target=".length);
    } else if (arg === "--profile" && argv[i + 1]) {
      profile = argv[i + 1];
      i += 1;
    } else if (arg.startsWith("--profile=")) {
      profile = arg.slice("--profile=".length);
    }
  }
  return { target, profile };
}

function main(env = process.env, argv = process.argv.slice(2)) {
  const parsed = parseCliArgs(argv);
  const effectiveEnv = {
    ...env,
    ...(parsed.target ? { DIMO_BUILD_TARGET: parsed.target } : {}),
    ...(parsed.profile ? { CARGO_PROFILE: parsed.profile } : {}),
  };
  const repo = path.resolve(__dirname, "..");
  const staged = stageElectronSidecars({ repo, env: effectiveEnv });
  for (const file of staged) {
    console.log(`[stage-electron-sidecars] staged ${file}`);
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  ELECTRON_SIDECAR_BINS,
  main,
  copySidecar,
  copyPlainSidecar,
  stageElectronSidecars,
  isBuiltSidecar,
  resolveSidecarBinDir,
  resolveSidecarSource,
  resolveTargetTriple,
  sidecarBinsExist,
};
