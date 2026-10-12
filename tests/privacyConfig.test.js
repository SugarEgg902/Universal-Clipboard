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

test('getDataDir/setDataDir：默认 null，写盘与读取一致', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cut-privacy-'));
  privacyConfig.init(dir);
  assert.strictEqual(privacyConfig.getDataDir(), null);
  privacyConfig.setDataDir('/Volumes/D/cut-data');
  assert.strictEqual(privacyConfig.getDataDir(), '/Volumes/D/cut-data');
  const saved = JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'));
  assert.strictEqual(saved.dataDir, '/Volumes/D/cut-data');
  assert.strictEqual(saved.privacyMode, 'mask'); // 其他字段不受影响
  fs.rmSync(dir, { recursive: true, force: true });
});

test('setDataDir：空串与 null 归一为 null（恢复默认）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cut-privacy-'));
  privacyConfig.init(dir);
  privacyConfig.setDataDir('/x');
  privacyConfig.setDataDir('');
  assert.strictEqual(privacyConfig.getDataDir(), null);
  privacyConfig.setDataDir('/x');
  privacyConfig.setDataDir(null);
  assert.strictEqual(privacyConfig.getDataDir(), null);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('setDataDir：空白字符串归一为 null；带空白的路径 trim 后写入', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cut-privacy-'));
  privacyConfig.init(dir);
  privacyConfig.setDataDir('/x');
  privacyConfig.setDataDir('   ');
  assert.strictEqual(privacyConfig.getDataDir(), null);
  let saved = JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'));
  assert.strictEqual(saved.dataDir, null);
  privacyConfig.setDataDir('  /ok  ');
  assert.strictEqual(privacyConfig.getDataDir(), '/ok');
  saved = JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'));
  assert.strictEqual(saved.dataDir, '/ok');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('setDataDir：非字符串忽略；与 setPet/setMode 互不覆盖', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cut-privacy-'));
  privacyConfig.init(dir);
  privacyConfig.setPet({ emoji: '🐱' });
  privacyConfig.setDataDir(123);
  assert.strictEqual(privacyConfig.getDataDir(), null);
  privacyConfig.setDataDir('/ok');
  privacyConfig.setMode('skip');
  privacyConfig.setPet({ x: 10 });
  const saved = JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'));
  assert.strictEqual(saved.dataDir, '/ok');
  assert.strictEqual(saved.privacyMode, 'skip');
  assert.strictEqual(saved.pet.emoji, '🐱');
  fs.rmSync(dir, { recursive: true, force: true });
});

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'pc-'));
}

test('getSync/setSync：默认与字段互不覆盖；deviceId 自动生成', () => {
  const dir = makeTmpDir();
  privacyConfig.init(dir);
  const s = privacyConfig.getSync();
  assert.strictEqual(s.role, null);
  assert.strictEqual(s.token, null);
  assert.strictEqual(s.lastSeq, 0);
  assert.ok(typeof s.deviceId === 'string' && s.deviceId.length >= 16);
  const dev = s.deviceId;
  privacyConfig.setSync({ role: 'host', token: 'tok123', hostPort: 43789 });
  privacyConfig.setSync({ hostIp: '192.168.1.5' });
  const s2 = privacyConfig.getSync();
  assert.strictEqual(s2.role, 'host');
  assert.strictEqual(s2.token, 'tok123');
  assert.strictEqual(s2.hostPort, 43789);
  assert.strictEqual(s2.hostIp, '192.168.1.5');
  assert.strictEqual(s2.deviceId, dev); // 未被覆盖
  assert.strictEqual(privacyConfig.getMode(), 'mask'); // 隐私字段不受影响
  fs.rmSync(dir, { recursive: true, force: true });
});

test('setSync：非法值忽略（role 白名单/port 范围/lastSeq 非负整数）', () => {
  const dir = makeTmpDir();
  privacyConfig.init(dir);
  privacyConfig.setSync({ role: 'host' });
  privacyConfig.setSync({ role: 'admin' });
  assert.strictEqual(privacyConfig.getSync().role, 'host');
  privacyConfig.setSync({ hostPort: 80 });
  assert.strictEqual(privacyConfig.getSync().hostPort, null);
  privacyConfig.setSync({ hostPort: 43789 });
  privacyConfig.setSync({ lastSeq: -5 });
  assert.strictEqual(privacyConfig.getSync().lastSeq, 0);
  privacyConfig.setSync({ lastSeq: 42 });
  assert.strictEqual(privacyConfig.getSync().lastSeq, 42);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('sync 持久化与 deviceId 重启稳定', () => {
  const dir = makeTmpDir();
  privacyConfig.init(dir);
  privacyConfig.setSync({ role: 'client', token: 't', hostIp: '10.0.0.2', hostPort: 43790, lastSeq: 7 });
  const dev = privacyConfig.getSync().deviceId;
  privacyConfig.init(dir); // 模拟重启
  const s = privacyConfig.getSync();
  assert.strictEqual(s.role, 'client');
  assert.strictEqual(s.hostIp, '10.0.0.2');
  assert.strictEqual(s.lastSeq, 7);
  assert.strictEqual(s.deviceId, dev);
  fs.rmSync(dir, { recursive: true, force: true });
});
