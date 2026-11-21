const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const ROOT = path.join(__dirname, "..");
const ELECTRON_DIR = path.join(ROOT, "electron");
const BUILD_DIR = path.join(ELECTRON_DIR, "build");
const ICONS_DIR = path.join(BUILD_DIR, "icons");

test("Electron builder config wires icons, DMG background, NSIS hook, and notarization scripts", () => {
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
  ]) {
    const filePath = path.join(BUILD_DIR, rel);
    assert.ok(fs.existsSync(filePath), `missing packaging asset ${rel}`);
    assert.ok(fs.statSync(filePath).size > 0, `empty packaging asset ${rel}`);
  }
  assert.ok(fs.existsSync(path.join(ICONS_DIR, "32x32.png")));
});

test("Windows NSIS custom hook stops companion processes and preserves user data", () => {
  const nsh = fs.readFileSync(path.join(BUILD_DIR, "installer.nsh"), "utf8");
  assert.match(nsh, /dimo-server\.exe/);
  assert.match(nsh, /dimo-mcp\.exe/);
  assert.match(nsh, /dimo-workflow-mcp\.exe/);
  assert.match(nsh, /dimo-computer-helper\.exe/);
  assert.match(nsh, /customInit/);
  assert.match(nsh, /customUnInit/);
});
