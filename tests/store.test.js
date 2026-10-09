const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');
const { ClipStore, openStore } = require('../src/main/store');

// 2026年10月8日 默认中午12点（本地时间）
const at = (y, m, d, h = 12) => new Date(y, m - 1, d, h, 0, 0).getTime();

test('insert 存储 trim 后的文本', () => {
  const s = new ClipStore();
  const id = s.insert('  hello  ', at(2026, 10, 8));
  assert.ok(id > 0);
  const rows = s.listByDay('2026-10-08');
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].text, 'hello');
});

test('同一天相同文本去重', () => {
  const s = new ClipStore();
  s.insert('dup', at(2026, 10, 8, 9));
  const again = s.insert('dup', at(2026, 10, 8, 10));
  assert.strictEqual(again, null);
  assert.strictEqual(s.listByDay('2026-10-08').length, 1);
});

test('不同天的相同文本各自存储', () => {
  const s = new ClipStore();
  s.insert('dup', at(2026, 10, 8));
  const id2 = s.insert('dup', at(2026, 10, 7));
  assert.ok(id2 > 0);
  assert.strictEqual(s.listByDay('2026-10-08').length, 1);
  assert.strictEqual(s.listByDay('2026-10-07').length, 1);
});

test('空白文本拒绝插入', () => {
  const s = new ClipStore();
  assert.strictEqual(s.insert('   ', at(2026, 10, 8)), null);
});

test('listByDay 只返回当天且按时间倒序', () => {
  const s = new ClipStore();
  s.insert('early', at(2026, 10, 8, 9));
  s.insert('late', at(2026, 10, 8, 18));
  s.insert('other-day', at(2026, 10, 7));
  const rows = s.listByDay('2026-10-08');
  assert.deepStrictEqual(rows.map((r) => r.text), ['late', 'early']);
});

test('search 跨天匹配并按时间倒序', () => {
  const s = new ClipStore();
  s.insert('apple pie', at(2026, 10, 8));
  s.insert('banana', at(2026, 10, 7));
  s.insert('pineapple juice', at(2026, 10, 6));
  const rows = s.search('apple');
  assert.deepStrictEqual(rows.map((r) => r.text), ['apple pie', 'pineapple juice']);
});

test('search 转义 LIKE 通配符', () => {
  const s = new ClipStore();
  s.insert('100% sure', at(2026, 10, 8));
  const rows = s.search('100%');
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].text, '100% sure');
});

test('get 按 id 返回单条', () => {
  const s = new ClipStore();
  const id = s.insert('find me', at(2026, 10, 8));
  assert.strictEqual(s.get(id).text, 'find me');
  assert.strictEqual(s.get(9999), undefined);
});

test('delete 删除单条', () => {
  const s = new ClipStore();
  const id = s.insert('bye', at(2026, 10, 8));
  s.delete(id);
  assert.strictEqual(s.listByDay('2026-10-08').length, 0);
});

test('clearDay 只清空当天', () => {
  const s = new ClipStore();
  s.insert('a', at(2026, 10, 8));
  s.insert('b', at(2026, 10, 7));
  s.clearDay('2026-10-08');
  assert.strictEqual(s.listByDay('2026-10-08').length, 0);
  assert.strictEqual(s.listByDay('2026-10-07').length, 1);
});

test('countByDay 返回当天条数', () => {
  const s = new ClipStore();
  s.insert('a', at(2026, 10, 8, 9));
  s.insert('b', at(2026, 10, 8, 10));
  assert.strictEqual(s.countByDay('2026-10-08'), 2);
  assert.strictEqual(s.countByDay('2026-10-07'), 0);
});

test('openStore 遇到损坏数据库时备份并重建', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clipstore-'));
  const dbPath = path.join(dir, 'clipboard.db');
  fs.writeFileSync(dbPath, 'this is not a sqlite database');
  const store = openStore(dbPath);
  const id = store.insert('recovered', at(2026, 10, 8));
  assert.ok(id > 0);
  assert.ok(fs.existsSync(dbPath + '.bak'));
});

test('search 空字符串关键词返回空数组', () => {
  const s = new ClipStore();
  s.insert('something', at(2026, 10, 8));
  assert.deepStrictEqual(s.search(''), []);
});

test('search 纯空白关键词返回空数组', () => {
  const s = new ClipStore();
  s.insert('something', at(2026, 10, 8));
  assert.deepStrictEqual(s.search('   '), []);
});

test('search 最多返回 50 条且为最新', () => {
  const s = new ClipStore();
  for (let i = 0; i < 210; i++) s.insert('bulk ' + i, at(2026, 10, 8) + i);
  const rows = s.search('bulk');
  assert.strictEqual(rows.length, 50);
  assert.ok(rows.some((r) => r.text === 'bulk 209'));
});

test('旧库自动迁移新增图片列', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clipstore-'));
  const dbPath = path.join(dir, 'old.db');
  const raw = new Database(dbPath);
  raw.exec(`CREATE TABLE clips (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    text TEXT NOT NULL,
    created_at INTEGER NOT NULL
  )`);
  raw.prepare('INSERT INTO clips (text, created_at) VALUES (?, ?)').run('old-row', at(2026, 10, 8));
  raw.close();

  const s = new ClipStore(dbPath);
  const rows = s.listByDay('2026-10-08');
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].text, 'old-row');
  assert.strictEqual(rows[0].type, 'text'); // 默认值回填
});

test('insertImage 写文件并入库', () => {
  const imgDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clipimg-'));
  const s = new ClipStore(':memory:', imgDir);
  const id = s.insertImage(Buffer.from('fake-png'), 100, 200, at(2026, 10, 8));
  assert.ok(id > 0);
  const rows = s.listByDay('2026-10-08');
  assert.strictEqual(rows[0].type, 'image');
  assert.strictEqual(rows[0].width, 100);
  assert.strictEqual(rows[0].height, 200);
  assert.ok(fs.existsSync(path.join(imgDir, rows[0].image_path)));
});

test('同一天同图去重，跨天各自入库且共用同一文件', () => {
  const imgDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clipimg-'));
  const s = new ClipStore(':memory:', imgDir);
  const buf = Buffer.from('same-image');
  const id1 = s.insertImage(buf, 10, 10, at(2026, 10, 8));
  assert.strictEqual(s.insertImage(buf, 10, 10, at(2026, 10, 8, 13)), null); // 同日去重
  const id2 = s.insertImage(buf, 10, 10, at(2026, 10, 7));
  assert.ok(id2 > 0 && id2 !== id1);
  const file1 = s.get(id1).image_path;
  assert.strictEqual(s.get(id2).image_path, file1); // 同哈希同文件
  assert.strictEqual(fs.readdirSync(imgDir).length, 1);
});

test('search 只匹配文本条目', () => {
  const imgDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clipimg-'));
  const s = new ClipStore(':memory:', imgDir);
  s.insert('keyword apple text', at(2026, 10, 8));
  s.insertImage(Buffer.from('img'), 1, 1, at(2026, 10, 8));
  const rows = s.search('apple');
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].type, 'text');
});

test('删除图片条目清理文件；仍有引用时保留', () => {
  const imgDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clipimg-'));
  const s = new ClipStore(':memory:', imgDir);
  const buf = Buffer.from('shared');
  const id1 = s.insertImage(buf, 5, 5, at(2026, 10, 8));
  const id2 = s.insertImage(buf, 5, 5, at(2026, 10, 7));
  const file = path.join(imgDir, s.get(id1).image_path);

  s.delete(id1);
  assert.ok(fs.existsSync(file)); // id2 仍引用
  s.delete(id2);
  assert.ok(!fs.existsSync(file)); // 引用归零后删除
});

test('clearDay 清理当天图片文件', () => {
  const imgDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clipimg-'));
  const s = new ClipStore(':memory:', imgDir);
  const id = s.insertImage(Buffer.from('day-img'), 5, 5, at(2026, 10, 8));
  s.insertImage(Buffer.from('other-img'), 5, 5, at(2026, 10, 7));
  const file = path.join(imgDir, s.get(id).image_path);
  s.clearDay('2026-10-08');
  assert.ok(!fs.existsSync(file));
  assert.strictEqual(s.listByDay('2026-10-07').length, 1);
});

test('无 imagesDir 时 insertImage 返回 null', () => {
  const s = new ClipStore();
  assert.strictEqual(s.insertImage(Buffer.from('x'), 1, 1, at(2026, 10, 8)), null);
});
