const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { ClipStore } = require('../src/main/store');

function makeStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'syncstore-'));
  return new ClipStore(':memory:', path.join(dir, 'images'));
}

test('insertRemoteText：入库并带 origin/seq 元数据', () => {
  const store = makeStore();
  const r = store.insertRemoteText({ text: '来自 B 机器', originDeviceId: 'dev-b', originId: 42, hostSeq: 7 });
  assert.ok(r.inserted);
  const row = store.get(r.id);
  assert.strictEqual(row.source, 'remote');
  assert.strictEqual(row.origin_device_id, 'dev-b');
  assert.strictEqual(row.origin_id, 42);
  assert.strictEqual(row.host_seq, 7);
});

test('insertRemoteText：同 origin 幂等——重复插入返回已有行不新建', () => {
  const store = makeStore();
  const r1 = store.insertRemoteText({ text: 'hello', originDeviceId: 'dev-b', originId: 1, hostSeq: 1 });
  const r2 = store.insertRemoteText({ text: 'hello', originDeviceId: 'dev-b', originId: 1, hostSeq: 1 });
  assert.strictEqual(r2.inserted, false);
  assert.strictEqual(r2.id, r1.id);
  assert.strictEqual(store.countByDay(new Date().toISOString().slice(0, 10)), 1);
});

test('insertRemoteText：当天同内容去重（跨 origin 也判重）', () => {
  const store = makeStore();
  store.insertRemoteText({ text: 'same', originDeviceId: 'dev-b', originId: 1, hostSeq: 1 });
  const r = store.insertRemoteText({ text: 'same', originDeviceId: 'dev-c', originId: 9, hostSeq: 2 });
  assert.strictEqual(r, null);
});

test('insertRemoteImage：二进制入库 + origin 元数据 + 哈希文件名', () => {
  const store = makeStore();
  const buf = Buffer.from('fake-png-bytes');
  const r = store.insertRemoteImage(buf, { width: 10, height: 20, originDeviceId: 'dev-b', originId: 5, hostSeq: 3 });
  assert.ok(r.inserted);
  const row = store.get(r.id);
  assert.strictEqual(row.type, 'image');
  assert.strictEqual(row.origin_device_id, 'dev-b');
  assert.ok(fs.existsSync(path.join(store.imagesDir, row.image_path)));
});

test('insertRemoteImage：同内容同 origin 幂等', () => {
  const store = makeStore();
  const buf = Buffer.from('fake-png-bytes-2');
  const r1 = store.insertRemoteImage(buf, { originDeviceId: 'dev-b', originId: 6, hostSeq: 4 });
  const r2 = store.insertRemoteImage(buf, { originDeviceId: 'dev-b', originId: 6, hostSeq: 4 });
  assert.strictEqual(r2.inserted, false);
  assert.strictEqual(r2.id, r1.id);
});

test('markOrigin + listUnsynced：本机条目待确认队列', () => {
  const store = makeStore();
  const id1 = store.insert('本机文本一');
  const id2 = store.insert('本机文本二');
  store.markOrigin(id1, 'dev-self');
  store.markOrigin(id2, 'dev-self');
  store.markSynced(id1, 100);
  const pending = store.listUnsynced('dev-self');
  assert.deepStrictEqual(pending, [id2]);
});

test('markSynced：更新 host_seq 后不再出现在待确认队列', () => {
  const store = makeStore();
  const id = store.insert('x');
  store.markOrigin(id, 'dev-self');
  store.markSynced(id, 55);
  const row = store.get(id);
  assert.strictEqual(row.host_seq, 55);
  assert.deepStrictEqual(store.listUnsynced('dev-self'), []);
});

test('listSince：按 id 游标补拉（含 origin 元数据，不含图片字节）', () => {
  const store = makeStore();
  const a = store.insertRemoteText({ text: 'a', originDeviceId: 'b', originId: 1, hostSeq: 1 });
  const b = store.insertRemoteText({ text: 'b', originDeviceId: 'b', originId: 2, hostSeq: 2 });
  store.insertRemoteText({ text: 'c', originDeviceId: 'b', originId: 3, hostSeq: 3 });
  const rows = store.listSince(a.id, 10);
  assert.strictEqual(rows.length, 2);
  assert.strictEqual(rows[0].id, b.id);
  assert.strictEqual(rows[0].origin_device_id, 'b');
  assert.strictEqual(rows[0].text, 'b');
  assert.strictEqual(rows[1].text, 'c');
});

test('旧库迁移：无新列的既有 db 打开后自动补列且旧数据可读', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'syncmig-'));
  const dbPath = path.join(dir, 'old.db');
  const Database = require('better-sqlite3');
  const db = new Database(dbPath);
  db.exec("CREATE TABLE clips (id INTEGER PRIMARY KEY AUTOINCREMENT, text TEXT NOT NULL, created_at INTEGER NOT NULL)");
  db.prepare('INSERT INTO clips (text, created_at) VALUES (?, ?)').run('旧数据', Date.now());
  db.close();
  const store = new ClipStore(dbPath, path.join(dir, 'images'));
  const row = store.listByDay(new Date().toISOString().slice(0, 10))[0];
  assert.strictEqual(row.text, '旧数据');
  assert.deepStrictEqual(store.listUnsynced('dev-x'), []); // 旧行无 origin，不进待传队列
});
