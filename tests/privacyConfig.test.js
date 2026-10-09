const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const privacyConfig = require('../src/main/privacyConfig');

test('默认 mask 模式；init 读取已有配置', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cut-privacy-'));
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ privacyMode: 'skip' }));
  privacyConfig.init(dir);
  assert.strictEqual(privacyConfig.getMode(), 'skip');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('setMode 持久化且 getMode 立即生效', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cut-privacy-'));
  privacyConfig.init(dir);
  privacyConfig.setMode('skip');
  assert.strictEqual(privacyConfig.getMode(), 'skip');
  const saved = JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'));
  assert.strictEqual(saved.privacyMode, 'skip');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('非法/损坏配置回退 mask', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cut-privacy-'));
  fs.writeFileSync(path.join(dir, 'config.json'), '{broken');
  privacyConfig.init(dir);
  assert.strictEqual(privacyConfig.getMode(), 'mask');
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ privacyMode: 'weird' }));
  privacyConfig.init(dir);
  assert.strictEqual(privacyConfig.getMode(), 'mask');
  fs.rmSync(dir, { recursive: true, force: true });
});
