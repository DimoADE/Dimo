const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { resolveSigningMode } = require("../electron/build/signWindows");
const {
  appendPublisherNameToUpdateConfig,
  ensureWindowsEvsignPublisherName,
  parsePublisherNameEnv,
} = require("../electron/build/afterPack");

const ROOT = path.join(__dirname, "..");
const ELECTRON_DIR = path.join(ROOT, "electron");
const BUILD_DIR = path.join(ELECTRON_DIR, "build");
const ICONS_DIR = path.join(BUILD_DIR, "icons");

test("Electron builder config wires icons, DMG background, NSIS hook, Windows EVSign hook, macOS microphone description, and notarization scripts", () => {
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
});

test("Windows NSIS custom hook stops staged companion processes and omits stale dimo-computer-helper.exe", () => {
  const nsh = fs.readFileSync(path.join(BUILD_DIR, "installer.nsh"), "utf8");
  assert.match(nsh, /dimo-server\.exe/);
  assert.match(nsh, /dimo-mcp\.exe/);
  assert.match(nsh, /dimo-workflow-mcp\.exe/);
  assert.doesNotMatch(nsh, /dimo-computer-helper\.exe/);
  assert.match(nsh, /customInit/);
  assert.match(nsh, /customUnInit/);
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

test("afterPack injects Windows EVSign publisherName into app-update.yml", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "dimo-afterpack-"));
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
});
