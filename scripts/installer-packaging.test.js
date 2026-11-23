const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { resolveSigningMode } = require("../electron/build/signWindows");
const {
  appendPublisherNameToUpdateConfig,
  collectSidecarBinaries,
  ensureUnixSidecarPermissions,
  ensureWindowsEvsignPublisherName,
  parsePublisherNameEnv,
  resolveMacSigningIdentity,
  signMacSidecars,
} = require("../electron/build/afterPack");

const ROOT = path.join(__dirname, "..");
const ELECTRON_DIR = path.join(ROOT, "electron");
const BUILD_DIR = path.join(ELECTRON_DIR, "build");
const ICONS_DIR = path.join(BUILD_DIR, "icons");

test("Electron builder config wires icons, DMG background, NSIS hook, Windows EVSign hook, macOS media descriptions, Linux executableName, and CLI-driven target arches", () => {
  const builderYml = fs.readFileSync(
    path.join(ELECTRON_DIR, "electron-builder.yml"),
    "utf8",
  );
  assert.match(builderYml, /from:\s+build\/icons/);
  assert.match(builderYml, /icon:\s+build\/icons\/icon\.ico/);
  assert.match(builderYml, /icon:\s+build\/icons\/icon\.icns/);
  assert.match(builderYml, /icon:\s+build\/icons\/128x128@2x\.png/);
  assert.match(builderYml, /include:\s+build\/installer\.nsh/);
  assert.match(builderYml, /background:\s+build\/dmg-background\.png/);
  assert.match(builderYml, /afterPack:\s+\.\/build\/afterPack\.js/);
  assert.match(builderYml, /afterSign:\s+\.\/build\/afterSign\.js/);
  assert.match(builderYml, /signtoolOptions:/);
  assert.match(builderYml, /sign:\s+\.\/build\/signWindows\.js/);
  assert.match(builderYml, /NSMicrophoneUsageDescription:/);
  assert.match(builderYml, /NSCameraUsageDescription:/);
  assert.match(
    builderYml,
    /mac:[\s\S]*?^\s+notarize:\s+false\s*$/m,
    "mac.notarize must be false so app-builder-lib delegates notarization to afterSign.js",
  );
  assert.match(
    builderYml,
    /linux:[\s\S]*?^\s+executableName:\s+dimo\s*$/m,
    "linux.executableName must be set to dimo",
  );
  assert.doesNotMatch(
    builderYml,
    /^\s+arch:/m,
    "electron-builder.yml targets must not hardcode arch arrays; CLI flags drive architecture",
  );
  assert.doesNotMatch(
    builderYml,
    /src-tauri/,
    "electron-builder.yml must not reference removed src-tauri assets",
  );
});

test("Electron packaging assets and hook scripts exist", () => {
  for (const rel of [
    "icons/icon.ico",
    "icons/icon.icns",
    "icons/128x128@2x.png",
    "icons/icon.png",
    "dmg-background.png",
    "installer.nsh",
    "entitlements.mac.plist",
    "afterPack.js",
    "afterSign.js",
    "signWindows.js",
  ]) {
    const filePath = path.join(BUILD_DIR, rel);
    assert.ok(fs.existsSync(filePath), `missing packaging asset ${rel}`);
    assert.ok(fs.statSync(filePath).size > 0, `empty packaging asset ${rel}`);
  }
  assert.ok(fs.existsSync(path.join(ICONS_DIR, "32x32.png")));

  const entitlements = fs.readFileSync(
    path.join(BUILD_DIR, "entitlements.mac.plist"),
    "utf8",
  );
  assert.match(entitlements, /com\.apple\.security\.device\.audio-input/);
  assert.match(entitlements, /com\.apple\.security\.device\.camera/);

  const afterSignSource = fs.readFileSync(
    path.join(BUILD_DIR, "afterSign.js"),
    "utf8",
  );
  assert.match(afterSignSource, /await\s+import\(['"]@electron\/notarize['"]\)/);
  assert.doesNotMatch(afterSignSource, /require\(['"]@electron\/notarize['"]\)/);
});

test("Windows NSIS custom hook scopes staged companion termination to $INSTDIR and guards HKLM cleanup", () => {
  const nsh = fs.readFileSync(path.join(BUILD_DIR, "installer.nsh"), "utf8");
  assert.match(nsh, /dimo-server\.exe/);
  assert.match(nsh, /dimo-mcp\.exe/);
  assert.match(nsh, /dimo-workflow-mcp\.exe/);
  assert.doesNotMatch(nsh, /dimo-computer-helper\.exe/);
  assert.doesNotMatch(
    nsh,
    /taskkill\s+\/F\s+\/IM\s+dimo-server\.exe/i,
    "installer.nsh must not unconditionally kill unrelated dimo-server.exe processes",
  );
  assert.match(nsh, /\$INSTDIR/);
  assert.match(nsh, /Win32_Process/);
  assert.match(nsh, /customCheckAppRunning/);
  assert.doesNotMatch(
    nsh,
    /!macro\s+customInit\b/,
    "installer.nsh must not kill sidecars in customInit before user confirmation",
  );
  assert.match(
    nsh,
    /SetEnvironmentVariable\(t\s+"DIMO_NSIS_INSTDIR",\s+i\s+0\)/,
    "installer.nsh must clear DIMO_NSIS_INSTDIR after use",
  );
  assert.match(nsh, /customUnInit/);
  assert.match(
    nsh,
    /\$\{if\}\s+\$installMode\s+==\s+"all"[\s\S]*?DeleteRegKey\s+HKLM/,
    "HKLM uninstall registry cleanup must be guarded by per-machine installMode",
  );
});

test("signWindows resolves evsign, signtool, and unsigned modes cleanly", () => {
  assert.equal(
    resolveSigningMode({ cscInfo: null }, { EVSIGN_LICENSE_KEY: "license-key" }),
    "evsign",
  );
  assert.equal(
    resolveSigningMode(
      { cscInfo: { file: "cert.pfx", password: "secret" } },
      {},
    ),
    "signtool",
  );
  assert.equal(resolveSigningMode({ cscInfo: null }, {}), "unsigned");
});

test("afterPack resolves macOS signing identity from APPLE_SIGNING_IDENTITY or CSC_NAME", () => {
  assert.equal(
    resolveMacSigningIdentity({
      APPLE_SIGNING_IDENTITY: "Developer ID Application: Dimo Inc (ABC123)",
      CSC_NAME: "Other (XYZ)",
    }),
    "Developer ID Application: Dimo Inc (ABC123)",
  );
  assert.equal(
    resolveMacSigningIdentity({ CSC_NAME: "Dimo Inc (ABC123)" }),
    "Developer ID Application: Dimo Inc (ABC123)",
  );
  assert.equal(
    resolveMacSigningIdentity({
      CSC_NAME: "Developer ID Application: Dimo Inc (ABC123)",
    }),
    "Developer ID Application: Dimo Inc (ABC123)",
  );
  assert.equal(
    resolveMacSigningIdentity({
      CSC_NAME: "0123456789abcdef0123456789abcdef01234567",
    }),
    "0123456789abcdef0123456789abcdef01234567",
  );
  assert.equal(resolveMacSigningIdentity({ CSC_NAME: "-" }), "-");
  assert.equal(resolveMacSigningIdentity({}), null);
});

test("afterPack recursively chmods macOS and Linux sidecars even when unsigned and signs dylibs before binaries on macOS", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "dimo-afterpack-unix-"));
  try {
    const macBinDir = path.join(
      tmpDir,
      "mac-out",
      "Dimo.app",
      "Contents",
      "Resources",
      "bin",
    );
    const macNestedDir = path.join(macBinDir, "nested");
    fs.mkdirSync(macNestedDir, { recursive: true });
    const serverBin = path.join(macBinDir, "dimo-server");
    const nestedHelper = path.join(macNestedDir, "helper-tool");
    const nestedDylib = path.join(macNestedDir, "libhelper.dylib");
    const readmeFile = path.join(macBinDir, "README.txt");
    fs.writeFileSync(serverBin, "stub-server");
    fs.writeFileSync(nestedHelper, "stub-helper");
    fs.writeFileSync(nestedDylib, "stub-dylib");
    fs.writeFileSync(readmeFile, "not-a-binary");

    assert.deepEqual(collectSidecarBinaries(macBinDir), [
      nestedDylib,
      serverBin,
      nestedHelper,
    ]);

    const macContext = {
      electronPlatformName: "darwin",
      appOutDir: path.join(tmpDir, "mac-out"),
      packager: { appInfo: { productFilename: "Dimo" } },
    };

    // Unsigned macOS build must still chmod all staged binaries/dylibs recursively
    const unsignedChmods = [];
    const unsignedCodesigns = [];
    signMacSidecars(macContext, {
      env: {},
      chmod: (filePath, mode) => unsignedChmods.push([filePath, mode]),
      execFile: (...args) => unsignedCodesigns.push(args),
    });
    assert.deepEqual(unsignedChmods, [
      [nestedDylib, 0o755],
      [serverBin, 0o755],
      [nestedHelper, 0o755],
    ]);
    assert.equal(unsignedCodesigns.length, 0);

    // Signed macOS build via CSC_NAME signs dylib first (without entitlements), then executables (with runtime + entitlements)
    const signedCalls = [];
    signMacSidecars(macContext, {
      env: { CSC_NAME: "Dimo Inc (TEAM123)" },
      chmod: () => {},
      execFile: (cmd, args) => signedCalls.push({ cmd, args }),
    });
    assert.equal(signedCalls.length, 3);
    assert.equal(signedCalls[0].cmd, "codesign");
    assert.equal(signedCalls[0].args.at(-1), nestedDylib);
    assert.ok(
      signedCalls[0].args.includes("Developer ID Application: Dimo Inc (TEAM123)"),
    );
    assert.ok(!signedCalls[0].args.includes("--entitlements"));
    assert.equal(signedCalls[1].args.at(-1), serverBin);
    assert.ok(signedCalls[1].args.includes("--entitlements"));
    assert.ok(signedCalls[1].args.includes("runtime"));
    assert.equal(signedCalls[2].args.at(-1), nestedHelper);
    assert.ok(signedCalls[2].args.includes("--entitlements"));

    // Linux build recursively chmods resources/bin sidecars
    const linuxBinDir = path.join(tmpDir, "linux-out", "resources", "bin");
    const linuxNestedDir = path.join(linuxBinDir, "sub");
    fs.mkdirSync(linuxNestedDir, { recursive: true });
    const linuxServer = path.join(linuxBinDir, "dimo-server");
    const linuxLib = path.join(linuxNestedDir, "libfoo.so.1");
    fs.writeFileSync(linuxServer, "stub-linux-server");
    fs.writeFileSync(linuxLib, "stub-linux-so");

    const linuxChmods = [];
    ensureUnixSidecarPermissions(
      {
        electronPlatformName: "linux",
        appOutDir: path.join(tmpDir, "linux-out"),
      },
      { chmod: (filePath, mode) => linuxChmods.push([filePath, mode]) },
    );
    assert.deepEqual(linuxChmods, [
      [linuxLib, 0o755],
      [linuxServer, 0o755],
    ]);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("afterPack injects Windows EVSign publisherName into app-update.yml", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "dimo-afterpack-"));
  try {
    const resourcesDir = path.join(tmpDir, "resources");
    const binDir = path.join(resourcesDir, "bin");
    fs.mkdirSync(binDir, { recursive: true });
    fs.writeFileSync(path.join(binDir, "dimo-server.exe"), "stub-signed-exe");
    const appUpdatePath = path.join(resourcesDir, "app-update.yml");
    fs.writeFileSync(
      appUpdatePath,
      "owner: DimoADE\nrepo: Dimo\nprovider: github\n",
      "utf8",
    );

    // Skips when EVSIGN_LICENSE_KEY is absent (unsigned or PFX build)
    assert.equal(
      ensureWindowsEvsignPublisherName(
        { electronPlatformName: "win32", appOutDir: tmpDir },
        { env: {} },
      ),
      false,
    );

    // Injects full DN read from signed sidecar when EVSIGN_LICENSE_KEY is set
    const subjectDn = 'CN="Dimo, Inc.", O="Dimo, Inc.", L=Shanghai, C=CN';
    assert.equal(
      ensureWindowsEvsignPublisherName(
        { electronPlatformName: "win32", appOutDir: tmpDir },
        {
          env: { EVSIGN_LICENSE_KEY: "ev-key" },
          readSubject: (filePath) => {
            assert.equal(filePath, path.join(binDir, "dimo-server.exe"));
            return subjectDn;
          },
        },
      ),
      true,
    );
    const updated = fs.readFileSync(appUpdatePath, "utf8");
    assert.ok(updated.includes("publisherName:\n"));
    assert.ok(updated.includes(`  - ${JSON.stringify(subjectDn)}\n`));

    // Does not duplicate publisherName if already present
    assert.equal(
      ensureWindowsEvsignPublisherName(
        { electronPlatformName: "win32", appOutDir: tmpDir },
        {
          env: { EVSIGN_LICENSE_KEY: "ev-key" },
          readSubject: () => {
            throw new Error("should not be called when publisherName exists");
          },
        },
      ),
      false,
    );

    assert.deepEqual(parsePublisherNameEnv("CN=Dimo"), ["CN=Dimo"]);
    assert.deepEqual(parsePublisherNameEnv('["CN=Dimo A","CN=Dimo B"]'), [
      "CN=Dimo A",
      "CN=Dimo B",
    ]);
    assert.equal(
      appendPublisherNameToUpdateConfig(
        "provider: github\npublisherName:\n  - Existing\n",
        ["Ignored"],
      ),
      "provider: github\npublisherName:\n  - Existing\n",
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
