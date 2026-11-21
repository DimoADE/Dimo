import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const frontendRoot = path.resolve(__dirname, '..');
const repoRoot = path.resolve(frontendRoot, '..');

function readRepoFile(relativePath) {
  return fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');
}

test('Electron 壳承载唯一桌面开发链路', () => {
  const electronPkg = readRepoFile('electron/package.json');
  const devScript = readRepoFile('scripts/run-electron-dev.js');
  const serverSidecar = readRepoFile('electron/src/main/sidecar.ts');

  assert.match(electronPkg, /"electron"/);
  assert.match(devScript, /dimo-server/);
  assert.match(devScript, /DIMO_SERVER_BIN/);
  assert.match(serverSidecar, /--desktop/);
});

test('根脚本暴露桌面端开发命令', () => {
  const source = readRepoFile('package.json');

  assert.match(source, /"dev"\s*:\s*"pnpm run dev:desktop"/);
  assert.match(source, /"dev:desktop"\s*:\s*"pnpm run electron:dev"/);
  assert.match(source, /"electron:dev"\s*:\s*"node scripts\/run-electron-dev\.js"/);
  assert.doesNotMatch(source, /"tauri:dev"\s*:/);
  assert.doesNotMatch(source, /"frontend:build:watch"\s*:/);
  assert.doesNotMatch(source, /"dev:legacy"\s*:/);
  assert.doesNotMatch(source, /"frontend:dev:legacy"\s*:/);
  assert.doesNotMatch(source, /"dev:qa:legacy"\s*:/);
  assert.doesNotMatch(source, /"tauri:dev:legacy"\s*:/);
  assert.doesNotMatch(source, /"frontend:dev"\s*:/);
});

test('旧的 Tauri 与 legacy Web dev 文件已删除', () => {
  assert.equal(
    fs.existsSync(path.join(repoRoot, 'scripts', 'dev.js')),
    false
  );
  assert.equal(
    fs.existsSync(path.join(repoRoot, 'scripts', 'run-frontend-dev.js')),
    false
  );
  assert.equal(
    fs.existsSync(path.join(repoRoot, 'src-tauri')),
    false
  );
});

test('前端包不再保留 build:watch 旧链路脚本', () => {
  const source = readRepoFile('frontend/package.json');

  assert.doesNotMatch(source, /"build:watch"\s*:/);
});

test('README 暴露桌面端开发命令', () => {
  const source = readRepoFile('README.md');

  assert.match(source, /pnpm run dev\b/i);
  assert.doesNotMatch(source, /dev:legacy/);
  assert.doesNotMatch(source, /tauri:dev:legacy/);
  assert.doesNotMatch(source, /frontend:dev:legacy/);
});
