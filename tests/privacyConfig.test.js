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

test('setMode 拒绝非法值', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cut-privacy-'));
  privacyConfig.init(dir);
  privacyConfig.setMode('bogus');
  assert.strictEqual(privacyConfig.getMode(), 'mask'); // 未被污染
  fs.rmSync(dir, { recursive: true, force: true });
});

test('init 前 setMode 仅更新内存不写盘', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cut-privacy-'));
  // 不调用 init，configPath 为上一次测试残留或 null；只验证内存生效且不抛错
  privacyConfig.setMode('skip');
  assert.strictEqual(privacyConfig.getMode(), 'skip');
  privacyConfig.setMode('mask'); // 还原，避免污染后续
  fs.rmSync(dir, { recursive: true, force: true });
});

test('getPet：无 pet 字段时返回懒默认值', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cut-privacy-'));
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ privacyMode: 'mask' }));
  privacyConfig.init(dir);
  const pet = privacyConfig.getPet();
  assert.strictEqual(pet.enabled, true);
  assert.strictEqual(pet.x, null);
  assert.strictEqual(pet.y, null);
  assert.strictEqual(pet.emoji, '📦');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('getPet：pet 字段部分缺失时深合并默认', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cut-privacy-'));
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ privacyMode: 'skip', pet: { emoji: '🐱' } }));
  privacyConfig.init(dir);
  const pet = privacyConfig.getPet();
  assert.strictEqual(pet.emoji, '🐱');
  assert.strictEqual(pet.enabled, true); // 默认回填
  assert.strictEqual(privacyConfig.getMode(), 'skip'); // 原字段不受影响
  fs.rmSync(dir, { recursive: true, force: true });
});

test('setPet：深合并写盘且原子文件包含 privacyMode', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cut-privacy-'));
  privacyConfig.init(dir);
  privacyConfig.setMode('skip');
  privacyConfig.setPet({ x: 100, y: 200 });
  const saved = JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'));
  assert.strictEqual(saved.privacyMode, 'skip');
  assert.strictEqual(saved.pet.x, 100);
  assert.strictEqual(saved.pet.y, 200);
  assert.strictEqual(saved.pet.enabled, true);
  assert.strictEqual(privacyConfig.getPet().y, 200);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('setPet：emoji 白名单、坐标含负数（多屏合法）、非法值保留原值、null 重置', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cut-privacy-'));
  privacyConfig.init(dir);
  privacyConfig.setPet({ emoji: '💣', enabled: 'yes', x: 'abc' });
  let pet = privacyConfig.getPet();
  assert.strictEqual(pet.emoji, '📦');   // 白名单外 → 默认
  assert.strictEqual(pet.enabled, true); // 非布尔 → 默认
  assert.strictEqual(pet.x, null);       // 字符串 → 默认（首次无原值）
  privacyConfig.setPet({ x: 100, y: -450 }); // 左侧副屏合法坐标
  pet = privacyConfig.getPet();
  assert.strictEqual(pet.x, 100);
  assert.strictEqual(pet.y, -450);
  privacyConfig.setPet({ x: 'bad' });    // 非法 → 保留原值 100
  assert.strictEqual(privacyConfig.getPet().x, 100);
  privacyConfig.setPet({ x: null });     // null = 重置默认角
  assert.strictEqual(privacyConfig.getPet().x, null);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('setMode 与 setPet 独立不互相覆盖', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cut-privacy-'));
  privacyConfig.init(dir);
  privacyConfig.setPet({ emoji: '🐤', x: 10 });
  privacyConfig.setMode('skip');
  const saved = JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'));
  assert.strictEqual(saved.pet.emoji, '🐤');
  assert.strictEqual(saved.privacyMode, 'skip');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('init：换目录后 pet 状态重置为默认', () => {
  const dirA = fs.mkdtempSync(path.join(os.tmpdir(), 'cut-privacy-'));
  fs.writeFileSync(path.join(dirA, 'config.json'), JSON.stringify({ privacyMode: 'mask', pet: { emoji: '🐱' } }));
  privacyConfig.init(dirA);
  assert.strictEqual(privacyConfig.getPet().emoji, '🐱');
  const dirB = fs.mkdtempSync(path.join(os.tmpdir(), 'cut-privacy-'));
  privacyConfig.init(dirB);
  assert.strictEqual(privacyConfig.getPet().emoji, '📦');
  fs.rmSync(dirA, { recursive: true, force: true });
  fs.rmSync(dirB, { recursive: true, force: true });
});
