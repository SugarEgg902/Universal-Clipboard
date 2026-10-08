const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
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

test('search 最多返回 200 条且为最新', () => {
  const s = new ClipStore();
  for (let i = 0; i < 210; i++) s.insert('bulk ' + i, at(2026, 10, 8) + i);
  const rows = s.search('bulk');
  assert.strictEqual(rows.length, 200);
  assert.ok(rows.some((r) => r.text === 'bulk 209'));
});
