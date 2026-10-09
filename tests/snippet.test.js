const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');
const { ClipStore } = require('../src/main/store');

const at = (y, m, d, h = 12) => new Date(y, m - 1, d, h, 0, 0).getTime();

test('pin 设置触发词与分组，行返回含 pinned/trigger_word/group_name', () => {
  const s = new ClipStore();
  const id = s.insert('my address', at(2026, 10, 9));
  assert.strictEqual(s.pin(id, 'addr', '私人'), true);
  const row = s.get(id);
  assert.strictEqual(row.pinned, 1);
  assert.strictEqual(row.trigger_word, 'addr');
  assert.strictEqual(row.group_name, '私人');
});

test('pin 幂等更新：同条目再 pin 修改触发词与分组', () => {
  const s = new ClipStore();
  const id = s.insert('hello snippet', at(2026, 10, 9));
  s.pin(id, 'hl', null);
  s.pin(id, 'hi', '工作');
  const row = s.get(id);
  assert.strictEqual(row.trigger_word, 'hi');
  assert.strictEqual(row.group_name, '工作');
});

test('触发词冲突抛错（不区分大小写，允许同条目自身）', () => {
  const s = new ClipStore();
  const a = s.insert('text a', at(2026, 10, 9));
  const b = s.insert('text b', at(2026, 10, 9));
  s.pin(a, 'Addr', null);
  assert.throws(() => s.pin(b, 'addr', null), /触发词已被占用/);
  assert.doesNotThrow(() => s.pin(a, 'ADDR', null)); // 自身大小写变体允许
});

test('空触发词可多次使用（仅分组收藏）', () => {
  const s = new ClipStore();
  const a = s.insert('text a', at(2026, 10, 9));
  const b = s.insert('text b', at(2026, 10, 9));
  assert.strictEqual(s.pin(a, '', null), true);
  assert.strictEqual(s.pin(b, null, '组1'), true);
});

test('unpin 清零并保留文本', () => {
  const s = new ClipStore();
  const id = s.insert('keep me', at(2026, 10, 9));
  s.pin(id, 'km', 'g');
  s.unpin(id);
  const row = s.get(id);
  assert.strictEqual(row.pinned, 0);
  assert.strictEqual(row.trigger_word, null);
  assert.strictEqual(row.group_name, null);
  assert.strictEqual(row.text, 'keep me');
});

test('listSnippets 只返回 pinned，按分组，组内时间倒序，null 归未分组', () => {
  const s = new ClipStore();
  const a = s.insert('a 旧', at(2026, 10, 9, 9));
  const b = s.insert('b 新', at(2026, 10, 9, 10));
  const c = s.insert('c 工作', at(2026, 10, 9, 11));
  s.pin(a, 'a', null);
  s.pin(b, 'b', null);
  s.pin(c, 'c', '工作');
  s.insert('not pinned', at(2026, 10, 9, 12));
  const groups = s.listSnippets();
  const names = groups.map((g) => g.name);
  assert.ok(names.includes('未分组') && names.includes('工作'));
  const un = groups.find((g) => g.name === '未分组');
  assert.deepStrictEqual(un.items.map((r) => r.text), ['b 新', 'a 旧']); // 倒序
  assert.ok(un.items.every((r) => r.pinned === 1));
  assert.ok(groups.flatMap((g) => g.items).every((r) => r.text !== 'not pinned'));
});

test('旧库迁移：无新列的 v2 库自动 ALTER 且存量行 pinned=0', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cut-v3-mig-'));
  const dbPath = path.join(dir, 'legacy.db');
  const legacy = new Database(dbPath);
  legacy.exec(`CREATE TABLE clips (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    text TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    type TEXT NOT NULL DEFAULT 'text',
    image_path TEXT, width INTEGER, height INTEGER
  );`);
  legacy.prepare('INSERT INTO clips (text, created_at) VALUES (?, ?)').run('old row', at(2026, 10, 8));
  legacy.close();
  const s = new ClipStore(dbPath);
  const row = s.get(1);
  assert.strictEqual(row.pinned, 0);
  assert.strictEqual(row.trigger_word, null);
  assert.strictEqual(row.group_name, null);
  assert.strictEqual(row.text, 'old row');
  fs.rmSync(dir, { recursive: true, force: true });
});
