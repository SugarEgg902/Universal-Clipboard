# 局域网共享剪贴板 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 局域网多机共享剪贴板：主机模式内嵌常驻 HTTP+SSE 服务（其 clipboard.db 即共享源），客户端连接主机，复制内容实时同步到所有机器并各自本地入库（断网可看历史）。

**Architecture:** 主机-客户端拓扑。seq 复用 clips 行 id（自增天然单调）。幂等键 `(origin_device_id, origin_id)` 唯一索引防循环；客户端 `lastSeq` 断线补拉 + 未确认队列补传。is_secret 不上线（各端读取时用 looksLikeSecret 自行判定，v3 既有机制）。

**Tech Stack:** Electron 33（Node 20：http/crypto/fetch 流式 SSE，零新依赖）、better-sqlite3、复用 v6 qrserver 的 lanIp/端口探测。

**Spec:** `docs/superpowers/specs/2026-10-10-lan-clipboard-sync-design.md`

**分支:** 从 main（108/108）切 `feature/lan-clipboard-sync`。

---

## 背景：执行者需要知道的现有结构

- **测试**：`npm test` = `cross-env ELECTRON_RUN_AS_NODE=1 electron --test tests/`（绝不 plain node，better-sqlite3 是 Electron ABI）；单文件 `npx cross-env ELECTRON_RUN_AS_NODE=1 node_modules/.bin/electron --test tests/<file>`。基线 108/108。
- **store.js**：ClipStore 类。构造时 `CREATE TABLE IF NOT EXISTS clips` + `migrate()`（PRAGMA table_info 按需 ALTER TABLE 补列，v7 已用此模式）。`insert(text)` 当天内容去重返回 lastInsertRowid；`insertImage(buffer,w,h)` sha256 哈希命名写 imagesDir 再入库；`get(id)` 返回行（含 type/text/image_path/width/height）。`:memory:` 库可用于测试。
- **ipc.js:14-17**：打码标记是**读取时**用 `looksLikeSecret(row.text)` 计算的，不存库——所以同步协议不需要传 is_secret。
- **qrserver.js**：`lanIp()`（第一个非回环 IPv4）、`DEFAULT_PORT_RANGE = [43789, 43999]`、端口探测模式（EADDRINUSE 递增重试）、`closeAllConnections` + timer.unref 模式。可直接复用。
- **privacyConfig.js**：整体 config 原子写（tmp+rename）。`DEFAULTS = { privacyMode:'mask', dataDir:null }`，init 重置 `config = { ...DEFAULTS, pet: {...DEFAULT_PET} }` 后从文件读回。v7 刚加 getDataDir/setDataDir。
- **index.js**：whenReady 内 privacyConfig.init → resolveDataPaths → openStore（dataPaths 模块级）；`watcher = new ClipboardWatcher({...})`，`onClip(text)` 里 `store.insert(text)`、`onImage(img)` 里 `store.insertImage(...)`；托盘 createTray()。
- **SSE 客户端**：Node 20 全局 fetch 支持流式读取——`const res = await fetch(url); for await (const chunk of res.body)` 解析 SSE 帧，零依赖。

---

## Task 1: store.js 同步列 + 方法，privacyConfig.js sync 字段

**Files:**
- Modify: `src/main/store.js`
- Modify: `src/main/privacyConfig.js`
- Test: `tests/store-sync.test.js`（新建）；`tests/privacyConfig.test.js`（追加）

- [ ] **Step 1: 写失败测试（tests/store-sync.test.js）**

```js
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
  const rows = store.listSince(a, 10);
  assert.strictEqual(rows.length, 2);
  assert.strictEqual(rows[0].id, b);
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
  assert.strictEqual(store.listUnsynced('dev-x'), []); // 旧行无 origin，不进待传队列
});
```

Run: `npx cross-env ELECTRON_RUN_AS_NODE=1 node_modules/.bin/electron --test tests/store-sync.test.js`
Expected: FAIL（方法不存在）。

- [ ] **Step 2: store.js 扩展**

migrate() 末尾（backfillPinyin() 调用之后）加：

```js
    if (!cols.includes('source')) {
      this.db.exec("ALTER TABLE clips ADD COLUMN source TEXT NOT NULL DEFAULT 'local'");
    }
    if (!cols.includes('origin_device_id')) {
      this.db.exec('ALTER TABLE clips ADD COLUMN origin_device_id TEXT');
    }
    if (!cols.includes('origin_id')) {
      this.db.exec('ALTER TABLE clips ADD COLUMN origin_id INTEGER');
    }
    if (!cols.includes('host_seq')) {
      this.db.exec('ALTER TABLE clips ADD COLUMN host_seq INTEGER');
    }
    this.db.exec(
      'CREATE UNIQUE INDEX IF NOT EXISTS idx_origin ON clips(origin_device_id, origin_id)'
    );
```

构造器语句区（this.listSnippetsStmt 之后）加：

```js
    this.byOriginStmt = this.db.prepare(
      'SELECT id FROM clips WHERE origin_device_id = ? AND origin_id = ?'
    );
    this.insertRemoteTextStmt = this.db.prepare(
      "INSERT INTO clips (text, created_at, pinyin, source, origin_device_id, origin_id, host_seq) VALUES (?, ?, ?, 'remote', ?, ?, ?)"
    );
    this.insertRemoteImageStmt = this.db.prepare(
      "INSERT INTO clips (text, created_at, type, image_path, width, height, source, origin_device_id, origin_id, host_seq) VALUES ('', ?, 'image', ?, ?, ?, 'remote', ?, ?, ?)"
    );
    this.markOriginStmt = this.db.prepare(
      'UPDATE clips SET origin_device_id = ?, origin_id = id WHERE id = ?'
    );
    this.markSyncedStmt = this.db.prepare('UPDATE clips SET host_seq = ? WHERE id = ?');
    this.listUnsyncedStmt = this.db.prepare(
      'SELECT id FROM clips WHERE origin_device_id = ? AND host_seq IS NULL ORDER BY id'
    );
    this.listSinceStmt = this.db.prepare(
      'SELECT id, text, created_at, type, image_path, width, height, origin_device_id, origin_id FROM clips WHERE id > ? ORDER BY id LIMIT ?'
    );
```

方法区（unpin 之后）加：

```js
  // 远端文本入库：origin 幂等（同 device+originId 已存在→返回已有行 inserted:false）；
  // 当天同内容去重→null。返回 { id, inserted } 或 null。
  insertRemoteText({ text, originDeviceId, originId, hostSeq, now = Date.now() }) {
    const trimmed = String(text).trim();
    if (!trimmed || !originDeviceId || originId == null) return null;
    const hit = this.byOriginStmt.get(originDeviceId, originId);
    if (hit) return { id: hit.id, inserted: false };
    const [start, end] = dayRange(toDateKey(now));
    if (this.existsStmt.get(trimmed, start, end)) return null;
    const id = this.insertRemoteTextStmt.run(
      trimmed, now, hasCJK(trimmed) ? toPinyin(trimmed) : null, originDeviceId, originId, hostSeq ?? null
    ).lastInsertRowid;
    return { id, inserted: true };
  }

  // 远端图片入库：sha256 哈希命名（与 insertImage 同规则）。origin 幂等；当天同图去重→null。
  insertRemoteImage(buffer, { width, height, originDeviceId, originId, hostSeq, now = Date.now() }) {
    if (!this.imagesDir || !Buffer.isBuffer(buffer) || !buffer.length) return null;
    if (!originDeviceId || originId == null) return null;
    const hit = this.byOriginStmt.get(originDeviceId, originId);
    if (hit) return { id: hit.id, inserted: false };
    const hash = crypto.createHash('sha256').update(buffer).digest('hex');
    const fileName = hash.slice(0, 16) + '.png';
    const [start, end] = dayRange(toDateKey(now));
    if (this.imageExistsStmt.get(fileName, start, end)) return null;
    try {
      const filePath = path.join(this.imagesDir, fileName);
      if (!fs.existsSync(filePath)) fs.writeFileSync(filePath, buffer);
    } catch (err) {
      console.error('远端图片写盘失败:', err);
      return null;
    }
    const id = this.insertRemoteImageStmt.run(
      now, fileName, width ?? null, height ?? null, originDeviceId, originId, hostSeq ?? null
    ).lastInsertRowid;
    return { id, inserted: true };
  }

  // 本机条目标记来源（origin_id = 行 id，唯一索引天然去重）
  markOrigin(id, deviceId) {
    this.markOriginStmt.run(deviceId, id);
  }

  // 主机已确认（host_seq = 主机行 id）；客户端上传成功后调用
  markSynced(id, hostSeq) {
    this.markSyncedStmt.run(hostSeq, id);
  }

  // 本机产生但主机未确认的条目（补传队列）
  listUnsynced(deviceId) {
    return this.listUnsyncedStmt.all(deviceId).map((r) => r.id);
  }

  // 断线补拉：id > since 的条目元数据（seq 即行 id）
  listSince(seq, limit = 200) {
    return this.listSinceStmt.all(seq, limit);
  }
```

Run: 单文件测试 9/9 绿（**Step 1 的 9 条**）。

- [ ] **Step 3: privacyConfig.test.js 追加测试**

```js
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
});
```

（沿用该文件现有 tmp 目录 helper 模式；若无 helper 用 fs.mkdtempSync(path.join(os.tmpdir(), 'pc-'))。）

Run: `npx cross-env ELECTRON_RUN_AS_NODE=1 node_modules/.bin/electron --test tests/privacyConfig.test.js` — 全绿（既有 + 3 条）。

- [ ] **Step 4: privacyConfig.js 扩展**

文件顶部 require 加 `const crypto = require('node:crypto');`，常量区加：

```js
const DEFAULT_SYNC = { role: null, token: null, hostIp: null, hostPort: null, deviceId: null, lastSeq: 0 };
```

init 的 config 重置行改为（两处语义：sync 不属于隐私配置，重置时保留逻辑一致——统一从 saved 读回）：

```js
  config = { ...DEFAULTS, pet: { ...DEFAULT_PET }, sync: { ...DEFAULT_SYNC } };
```

init 的 try 块内 `config.pet = sanitizePet(saved.pet);` 之后加：

```js
    config.sync = sanitizeSync(saved.sync);
    if (!config.sync.deviceId) {
      config.sync.deviceId = crypto.randomUUID();
      write(); // 首次生成即落盘
    }
```

sanitize 函数（sanitizeDataDir 之后）加：

```js
function sanitizeSync(sync) {
  const src = sync && typeof sync === 'object' ? sync : {};
  const out = { ...DEFAULT_SYNC };
  if (src.role === null || src.role === 'host' || src.role === 'client') out.role = src.role;
  for (const k of ['token', 'hostIp']) {
    if (typeof src[k] === 'string' && src[k].trim()) out[k] = src[k].trim();
  }
  if (Number.isInteger(src.hostPort) && src.hostPort >= 1024 && src.hostPort <= 65535) out.hostPort = src.hostPort;
  if (typeof src.deviceId === 'string' && src.deviceId.trim()) out.deviceId = src.deviceId.trim();
  if (Number.isInteger(src.lastSeq) && src.lastSeq >= 0) out.lastSeq = src.lastSeq;
  return out;
}
```

导出函数（setDataDir 之后）加：

```js
function getSync() {
  return { ...config.sync };
}

// patch 部分更新；非法字段忽略（sanitizeSync 白名单）
function setSync(patch) {
  config.sync = sanitizeSync({ ...config.sync, ...(patch || {}) });
  write();
}
```

module.exports 追加 `getSync, setSync`。

- [ ] **Step 5: 全量回归 + Commit**

Run: `npm test` — Expected: **120/120**（108 基线 + 9 store-sync + 3 privacyConfig）。

```bash
git add src/main/store.js src/main/privacyConfig.js tests/store-sync.test.js tests/privacyConfig.test.js
git commit -m "feat: 同步基础设施——store origin/seq 元数据与幂等入库、sync 配置字段"
```

---

## Task 2: syncserver.js 主机端 HTTP+SSE 服务

**Files:**
- Create: `src/main/syncserver.js`
- Test: `tests/syncserver.test.js`（新建）

- [ ] **Step 1: 写失败测试（tests/syncserver.test.js）**

```js
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { ClipStore } = require('../src/main/store');
const { startSyncServer } = require('../src/main/syncserver');

const TOKEN = 'test-token-abc';

function makeStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'syncsrv-'));
  return { store: new ClipStore(':memory:', path.join(dir, 'images')), dir };
}

async function req(port, method, p, { body, headers = {}, raw = false } = {}) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port, path: p, method, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        resolve({ status: res.statusCode, body: raw ? buf : buf.toString('utf8') });
      });
    });
    r.on('error', reject);
    if (body) r.write(body);
    r.end();
  });
}

const jpost = (port, p, obj, token) =>
  req(port, 'POST', p, {
    body: JSON.stringify(obj),
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(JSON.stringify(obj)), Authorization: `Bearer ${token}` },
  });

test('鉴权：无 token / 错 token → 401，对 token → 200', async () => {
  const { store } = makeStore();
  const srv = await startSyncServer({ store, imagesDir: null, token: TOKEN, ip: '127.0.0.1', portRange: [46000, 46050] });
  try {
    assert.strictEqual((await req(srv.port, 'GET', '/health')).status, 401);
    assert.strictEqual((await req(srv.port, 'GET', '/health', { headers: { Authorization: 'Bearer wrong' } })).status, 401);
    const ok = await req(srv.port, 'GET', '/health', { headers: { Authorization: `Bearer ${TOKEN}` } });
    assert.strictEqual(ok.status, 200);
    assert.strictEqual(JSON.parse(ok.body).deviceId, 'dev-host');
  } finally {
    srv.stop();
  }
});

test('POST /clip：入库返回 seq（=行id），SSE 客户端收到广播', async () => {
  const { store } = makeStore();
  const srv = await startSyncServer({ store, imagesDir: null, token: TOKEN, deviceId: 'dev-host', ip: '127.0.0.1', portRange: [46000, 46050] });
  const events = [];
  const es = http.get({ host: '127.0.0.1', port: srv.port, path: '/events', headers: { Authorization: `Bearer ${TOKEN}` } }, (res) => {
    let buf = '';
    res.on('data', (c) => {
      buf += c.toString('utf8');
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const frame = buf.slice(0, i); buf = buf.slice(i + 2);
        const m = frame.match(/^data: (.*)$/m);
        if (m) events.push(JSON.parse(m[1]));
      }
    });
  });
  await new Promise((r) => setTimeout(r, 300));
  try {
    const res = await jpost(srv.port, '/clip', { text: '同步文本', originDeviceId: 'dev-b', originId: 1 }, TOKEN);
    assert.strictEqual(res.status, 200);
    const { seq } = JSON.parse(res.body);
    assert.ok(seq >= 1);
    await new Promise((r) => setTimeout(r, 300)); // 等 100ms 防抖广播
    assert.strictEqual(events.length, 1);
    assert.strictEqual(events[0].seq, seq);
    assert.strictEqual(events[0].text, '同步文本');
    assert.strictEqual(events[0].originDeviceId, 'dev-b');
  } finally {
    es.destroy();
    srv.stop();
  }
});

test('幂等：同 origin 重复 POST 返回同 seq 不产生新行', async () => {
  const { store } = makeStore();
  const srv = await startSyncServer({ store, imagesDir: null, token: TOKEN, ip: '127.0.0.1', portRange: [46000, 46050] });
  try {
    const r1 = await jpost(srv.port, '/clip', { text: 'dup', originDeviceId: 'dev-b', originId: 9 }, TOKEN);
    const r2 = await jpost(srv.port, '/clip', { text: 'dup', originDeviceId: 'dev-b', originId: 9 }, TOKEN);
    assert.strictEqual(JSON.parse(r1.body).seq, JSON.parse(r2.body).seq);
    const day = new Date().toISOString().slice(0, 10);
    assert.strictEqual(store.countByDay(day), 1);
  } finally {
    srv.stop();
  }
});

test('大小限制：文本 >1MB → 413，图片 >10MB → 413', async () => {
  const { store } = makeStore();
  const srv = await startSyncServer({ store, imagesDir: null, token: TOKEN, ip: '127.0.0.1', portRange: [46000, 46050] });
  try {
    const big = JSON.stringify({ text: 'x'.repeat(1024 * 1024 + 1), originDeviceId: 'd', originId: 1 });
    const res = await req(srv.port, 'POST', '/clip', {
      body: big,
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(big), Authorization: `Bearer ${TOKEN}` },
    });
    assert.strictEqual(res.status, 413);
  } finally {
    srv.stop();
  }
});

test('GET /items?since：按 id 游标补拉', async () => {
  const { store } = makeStore();
  const a = store.insertRemoteText({ text: 'a1', originDeviceId: 'b', originId: 1, hostSeq: 1 });
  store.insertRemoteText({ text: 'a2', originDeviceId: 'b', originId: 2, hostSeq: 2 });
  const srv = await startSyncServer({ store, imagesDir: null, token: TOKEN, ip: '127.0.0.1', portRange: [46000, 46050] });
  try {
    const res = await req(srv.port, 'GET', `/items?since=${a}`, { headers: { Authorization: `Bearer ${TOKEN}` } });
    assert.strictEqual(res.status, 200);
    const { items } = JSON.parse(res.body);
    assert.strictEqual(items.length, 1);
    assert.strictEqual(items[0].text, 'a2');
  } finally {
    srv.stop();
  }
});

test('POST /clip-image + GET /image/<id>：二进制往返', async () => {
  const { store, dir } = makeStore();
  const srv = await startSyncServer({ store, imagesDir: path.join(dir, 'images'), token: TOKEN, ip: '127.0.0.1', portRange: [46000, 46050] });
  try {
    const buf = Buffer.from('png-bytes-here');
    const meta = Buffer.from(JSON.stringify({ originDeviceId: 'dev-b', originId: 3, width: 8, height: 6 })).toString('base64');
    const res = await req(srv.port, 'POST', '/clip-image', {
      body: buf,
      headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': buf.length, 'X-Meta': meta, Authorization: `Bearer ${TOKEN}` },
    });
    assert.strictEqual(res.status, 200);
    const { seq } = JSON.parse(res.body);
    const img = await req(srv.port, 'GET', `/image/${seq}`, { headers: { Authorization: `Bearer ${TOKEN}` }, raw: true });
    assert.strictEqual(img.status, 200);
    assert.deepStrictEqual(img.body, buf);
  } finally {
    srv.stop();
  }
});

test('主机本地条目 pushLocal 广播给 SSE 客户端', async () => {
  const { store } = makeStore();
  const srv = await startSyncServer({ store, imagesDir: null, token: TOKEN, deviceId: 'dev-host', ip: '127.0.0.1', portRange: [46000, 46050] });
  const events = [];
  const es = http.get({ host: '127.0.0.1', port: srv.port, path: '/events', headers: { Authorization: `Bearer ${TOKEN}` } }, (res) => {
    let buf = '';
    res.on('data', (c) => {
      buf += c.toString('utf8');
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const frame = buf.slice(0, i); buf = buf.slice(i + 2);
        const m = frame.match(/^data: (.*)$/m);
        if (m) events.push(JSON.parse(m[1]));
      }
    });
  });
  await new Promise((r) => setTimeout(r, 300));
  try {
    const id = store.insert('主机本地复制');
    store.markOrigin(id, 'dev-host');
    srv.pushLocal(id);
    await new Promise((r) => setTimeout(r, 300));
    assert.strictEqual(events.length, 1);
    assert.strictEqual(events[0].originDeviceId, 'dev-host');
    assert.strictEqual(events[0].originId, id);
  } finally {
    es.destroy();
    srv.stop();
  }
});
```

注意：Node 19+ 全局 agent keep-alive 问题——http.get/http.request 默认 agent 会池化连接，`srv.stop()` 需 `closeAllConnections()`（实现里处理）；测试里 es.destroy() 主动断开 SSE。

Run: `npx cross-env ELECTRON_RUN_AS_NODE=1 node_modules/.bin/electron --test tests/syncserver.test.js`
Expected: FAIL（模块不存在）。

- [ ] **Step 2: 实现 src/main/syncserver.js**

```js
// 局域网共享剪贴板——主机端常驻 HTTP+SSE 服务。
// seq 即 clips 行 id（自增天然单调）；幂等键 (origin_device_id, origin_id)；
// 只绑指定局域网 IP；token 头鉴权；SSE 心跳 25s；广播 100ms 防抖。

const http = require('node:http');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const TEXT_MAX_BYTES = 1024 * 1024;       // 1MB
const IMAGE_MAX_BYTES = 10 * 1024 * 1024; // 10MB，与本地图片上限一致
const HEARTBEAT_MS = 25000;
const DEBOUNCE_MS = 100;
const MAX_SSE_CLIENTS = 16;
const DEFAULT_PORT_RANGE = [43789, 43999];

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const len = Number(req.headers['content-length'] || 0);
    if (len > limit) {
      reject(Object.assign(new Error('payload-too-large'), { code: 413 }));
      return;
    }
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(Object.assign(new Error('payload-too-large'), { code: 413 }));
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function sseWrite(res, obj) {
  res.write(`data: ${JSON.stringify(obj)}\n\n`);
}

// opts: { store, imagesDir, token, deviceId, ip, portRange }（portRange/ip 测试注入）
// resolve { port, ip, stop(), pushLocal(rowId) }；端口被占在 portRange 内递增探测，耗尽抛 no-port。
function startSyncServer(opts) {
  const { store, imagesDir, token, deviceId } = opts;
  const ip = opts.ip; // 生产调用方传 lanIp()（见 index.js）
  const [p0, p1] = opts.portRange || DEFAULT_PORT_RANGE;
  const sseClients = new Set();
  let pending = []; // 防抖合并的广播队列
  let timer = null;
  let hbTimer = null;

  function flush() {
    timer = null;
    if (!pending.length) return;
    const events = pending;
    pending = [];
    for (const res of sseClients) {
      for (const ev of events) sseWrite(res, ev);
    }
  }

  function enqueueBroadcast(rowId) {
    const row = store.get(rowId);
    if (!row) return;
    const ev = row.type === 'image'
      ? { seq: row.id, kind: 'image', imageId: row.id, originDeviceId: row.origin_device_id, originId: row.origin_id, width: row.width, height: row.height }
      : { seq: row.id, kind: 'text', text: row.text, originDeviceId: row.origin_device_id, originId: row.origin_id };
    pending.push(ev);
    if (!timer) timer = setTimeout(flush, DEBOUNCE_MS);
  }

  const server = http.createServer(async (req, res) => {
    try {
      const auth = req.headers.authorization || '';
      if (auth !== `Bearer ${token}`) {
        res.statusCode = 401;
        res.end('unauthorized');
        return;
      }
      const url = new URL(req.url, 'http://x');
      const pathname = url.pathname;

      if (req.method === 'GET' && pathname === '/health') {
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ ok: true, deviceId }));
        return;
      }

      if (req.method === 'POST' && pathname === '/clip') {
        let body;
        try {
          body = JSON.parse((await readBody(req, TEXT_MAX_BYTES)).toString('utf8'));
        } catch (err) {
          res.statusCode = err.code === 413 ? 413 : 400;
          res.end();
          return;
        }
        const r = store.insertRemoteText({
          text: body.text, originDeviceId: body.originDeviceId, originId: body.originId,
        });
        if (!r) {
          res.statusCode = 200;
          res.end(JSON.stringify({ seq: null, deduped: true }));
          return;
        }
        enqueueBroadcast(r.id);
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ seq: r.id }));
        return;
      }

      if (req.method === 'POST' && pathname === '/clip-image') {
        let meta;
        try {
          meta = JSON.parse(Buffer.from(String(req.headers['x-meta'] || ''), 'base64').toString('utf8'));
        } catch {
          res.statusCode = 400;
          res.end();
          return;
        }
        let buf;
        try {
          buf = await readBody(req, IMAGE_MAX_BYTES);
        } catch (err) {
          res.statusCode = err.code === 413 ? 413 : 400;
          res.end();
          return;
        }
        const r = store.insertRemoteImage(buf, meta);
        if (!r) {
          res.statusCode = 200;
          res.end(JSON.stringify({ seq: null, deduped: true }));
          return;
        }
        enqueueBroadcast(r.id);
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ seq: r.id }));
        return;
      }

      const imgMatch = pathname.match(/^\/image\/(\d+)$/);
      if (req.method === 'GET' && imgMatch) {
        const row = store.get(Number(imgMatch[1]));
        if (!row || row.type !== 'image' || !row.image_path || !imagesDir) {
          res.statusCode = 404;
          res.end();
          return;
        }
        const imagePath = path.join(imagesDir, path.basename(row.image_path)); // basename 防穿越
        if (!fs.existsSync(imagePath)) {
          res.statusCode = 404;
          res.end();
          return;
        }
        res.setHeader('Content-Type', 'image/png');
        fs.createReadStream(imagePath)
          .on('error', () => { if (!res.headersSent) res.statusCode = 500; res.end(); })
          .pipe(res);
        return;
      }

      if (req.method === 'GET' && pathname === '/items') {
        const since = Number(url.searchParams.get('since') || 0);
        const limit = Math.min(Number(url.searchParams.get('limit') || 200), 500);
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ items: store.listSince(since, limit) }));
        return;
      }

      if (req.method === 'GET' && pathname === '/events') {
        if (sseClients.size >= MAX_SSE_CLIENTS) {
          res.statusCode = 503;
          res.end();
          return;
        }
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
        });
        res.write('retry: 3000\n\n');
        sseClients.add(res);
        req.on('close', () => sseClients.delete(res));
        return;
      }

      res.statusCode = 404;
      res.end();
    } catch (err) {
      console.error('syncserver 请求处理失败:', err);
      if (!res.headersSent) res.statusCode = 500;
      res.end();
    }
  });

  return new Promise((resolve, reject) => {
    let port = p0;
    const stop = () => {
      clearTimeout(timer);
      clearInterval(hbTimer);
      for (const res of sseClients) res.end();
      sseClients.clear();
      server.close();
      if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
    };
    const tryListen = () => {
      server.once('error', (err) => {
        if (err.code === 'EADDRINUSE' && port < p1) {
          port += 1;
          tryListen();
        } else {
          reject(err.code === 'EADDRINUSE' ? Object.assign(new Error('no-port'), { code: 'no-port' }) : err);
        }
      });
      server.listen(port, ip, () => {
        hbTimer = setInterval(() => {
          for (const res of sseClients) res.write(':ping\n\n');
        }, HEARTBEAT_MS);
        if (typeof hbTimer.unref === 'function') hbTimer.unref();
        resolve({ port, ip, stop, pushLocal: enqueueBroadcast });
      });
    };
    tryListen();
  });
}

module.exports = { startSyncServer, TEXT_MAX_BYTES, IMAGE_MAX_BYTES };
```

Run: 单文件测试 7/7 绿。

- [ ] **Step 3: 全量回归 + Commit**

Run: `npm test` — Expected: **127/127**（120 基线 + 7 syncserver）。

```bash
git add src/main/syncserver.js tests/syncserver.test.js
git commit -m "feat: 局域网共享主机端——HTTP+SSE 同步服务（鉴权/幂等/大小限制/防抖广播）"
```

---

## Task 3: syncclient.js 客户端 + 端到端集成测试

**Files:**
- Create: `src/main/syncclient.js`
- Test: `tests/syncclient.test.js`（新建）

- [ ] **Step 1: 写失败测试（tests/syncclient.test.js）——对真实 syncserver 做端到端**

```js
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { ClipStore } = require('../src/main/store');
const { startSyncServer } = require('../src/main/syncserver');
const { startSyncClient } = require('../src/main/syncclient');

const TOKEN = 'e2e-token';
const PORT_RANGE = [47000, 47050];

function pair() {
  const dirA = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-a-'));
  const dirB = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-b-'));
  const storeA = new ClipStore(':memory:', path.join(dirA, 'images')); // 主机
  const storeB = new ClipStore(':memory:', path.join(dirB, 'images')); // 客户端
  return { storeA, storeB, dirA, dirB };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('端到端：客户端本地复制 → 出现在主机库；主机本地复制 → 出现在客户端库', async () => {
  const { storeA, storeB } = pair();
  const srv = await startSyncServer({ store: storeA, imagesDir: null, token: TOKEN, deviceId: 'dev-host', ip: '127.0.0.1', portRange: PORT_RANGE });
  let lastSeq = 0;
  const client = startSyncClient({
    store: storeB, imagesDir: null, token: TOKEN, deviceId: 'dev-b',
    hostIp: '127.0.0.1', hostPort: srv.port,
    getLastSeq: () => lastSeq, setLastSeq: (n) => { lastSeq = n; },
    onStatus: () => {},
  });
  try {
    await sleep(500); // 等连接与补拉
    // 客户端复制
    const idB = storeB.insert('客户端的文本');
    storeB.markOrigin(idB, 'dev-b');
    client.pushLocal(idB);
    await sleep(800);
    const day = new Date().toISOString().slice(0, 10);
    assert.ok(storeA.listByDay(day).some((r) => r.text === '客户端的文本'));
    // 主机复制 → 广播 → 客户端
    const idA = storeA.insert('主机的文本');
    storeA.markOrigin(idA, 'dev-host');
    srv.pushLocal(idA);
    await sleep(800);
    assert.ok(storeB.listByDay(day).some((r) => r.text === '主机的文本'));
    // 回声抑制：客户端没把自己那条再插一遍
    assert.strictEqual(storeB.listByDay(day).filter((r) => r.text === '客户端的文本').length, 1);
  } finally {
    client.stop();
    srv.stop();
  }
});

test('断线补拉：客户端掉线期间主机的新内容，重连后补到', async () => {
  const { storeA, storeB } = pair();
  const srv = await startSyncServer({ store: storeA, imagesDir: null, token: TOKEN, deviceId: 'dev-host', ip: '127.0.0.1', portRange: PORT_RANGE });
  let lastSeq = 0;
  const mk = () => startSyncClient({
    store: storeB, imagesDir: null, token: TOKEN, deviceId: 'dev-b',
    hostIp: '127.0.0.1', hostPort: srv.port,
    getLastSeq: () => lastSeq, setLastSeq: (n) => { lastSeq = n; },
    onStatus: () => {},
  });
  const client1 = mk();
  try {
    await sleep(500);
    client1.stop(); // 掉线
    await sleep(200);
    const id = storeA.insert('掉线期间的主机内容');
    storeA.markOrigin(id, 'dev-host');
    srv.pushLocal(id);
    await sleep(300);
    const client2 = mk(); // 重连（同 lastSeq）
    await sleep(800);
    const day = new Date().toISOString().slice(0, 10);
    assert.ok(storeB.listByDay(day).some((r) => r.text === '掉线期间的主机内容'));
    client2.stop();
  } finally {
    client1.stop();
    srv.stop();
  }
});

test('图片端到端：客户端图片 → 主机 → 另一客户端收到字节一致的图片', async () => {
  const dirC = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-c-'));
  const storeC = new ClipStore(':memory:', path.join(dirC, 'images'));
  const { storeA, storeB } = pair();
  const srv = await startSyncServer({ store: storeA, imagesDir: null, token: TOKEN, deviceId: 'dev-host', ip: '127.0.0.1', portRange: PORT_RANGE });
  let seqB = 0;
  const clientB = startSyncClient({
    store: storeB, imagesDir: null, token: TOKEN, deviceId: 'dev-b',
    hostIp: '127.0.0.1', hostPort: srv.port, getLastSeq: () => seqB, setLastSeq: (n) => { seqB = n; }, onStatus: () => {},
  });
  let seqC = 0;
  const clientC = startSyncClient({
    store: storeC, imagesDir: path.join(dirC, 'images'), token: TOKEN, deviceId: 'dev-c',
    hostIp: '127.0.0.1', hostPort: srv.port, getLastSeq: () => seqC, setLastSeq: (n) => { seqC = n; }, onStatus: () => {},
  });
  try {
    await sleep(600);
    const buf = Buffer.from('real-png-payload');
    const idB = storeB.insertImage(buf, 7, 9);
    storeB.markOrigin(idB, 'dev-b');
    clientB.pushLocal(idB);
    await sleep(1200);
    const day = new Date().toISOString().slice(0, 10);
    const rowC = storeC.listByDay(day).find((r) => r.type === 'image');
    assert.ok(rowC, '客户端 C 应收到图片条目');
    const bytes = fs.readFileSync(path.join(dirC, 'images', rowC.image_path));
    assert.deepStrictEqual(bytes, buf);
  } finally {
    clientB.stop();
    clientC.stop();
    srv.stop();
  }
});

test('鉴权失败：错 token → onStatus 收到 error 且不入库', async () => {
  const { storeA, storeB } = pair();
  const srv = await startSyncServer({ store: storeA, imagesDir: null, token: TOKEN, deviceId: 'dev-host', ip: '127.0.0.1', portRange: PORT_RANGE });
  const statuses = [];
  const client = startSyncClient({
    store: storeB, imagesDir: null, token: 'wrong-token', deviceId: 'dev-b',
    hostIp: '127.0.0.1', hostPort: srv.port,
    getLastSeq: () => 0, setLastSeq: () => {}, onStatus: (s) => statuses.push(s),
  });
  try {
    await sleep(800);
    assert.ok(statuses.includes('error'));
    assert.strictEqual(storeA.countByDay(new Date().toISOString().slice(0, 10)), 0);
  } finally {
    client.stop();
    srv.stop();
  }
});
```

Run: `npx cross-env ELECTRON_RUN_AS_NODE=1 node_modules/.bin/electron --test tests/syncclient.test.js`
Expected: FAIL（模块不存在）。

- [ ] **Step 2: 实现 src/main/syncclient.js**

```js
// 局域网共享剪贴板——客户端：连接主机、断线补拉 + 实时 SSE、本地上传 + 补传队列。
// 回声抑制：originDeviceId === 本机 的条目直接跳过；远端条目不经过 watcher，天然无回环。

const http = require('node:http');

const RETRY_MIN_MS = 1000;
const RETRY_MAX_MS = 30000;
const FLUSH_INTERVAL_MS = 5000;

// opts: { store, imagesDir, token, deviceId, hostIp, hostPort,
//         getLastSeq(), setLastSeq(n), onStatus(status: 'connecting'|'connected'|'disconnected'|'error') }
function startSyncClient(opts) {
  const { store, imagesDir, token, deviceId, hostIp, hostPort, getLastSeq, setLastSeq, onStatus } = opts;
  const base = `http://${hostIp}:${hostPort}`;
  const headers = { Authorization: `Bearer ${token}` };
  let stopped = false;
  let retryMs = RETRY_MIN_MS;
  let esRes = null; // 当前 SSE 响应（断开用）
  let flushTimer = null;

  const status = (s) => { try { onStatus && onStatus(s); } catch { /* 状态回调不致命 */ } };

  async function pushRow(id) {
    const row = store.get(id);
    if (!row) return false;
    if (row.type === 'image') {
      const filePath = require('node:path').join(imagesDir, require('node:path').basename(row.image_path));
      const buf = require('node:fs').readFileSync(filePath);
      const meta = Buffer.from(JSON.stringify({ originDeviceId: deviceId, originId: id, width: row.width, height: row.height })).toString('base64');
      const res = await fetch(`${base}/clip-image`, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/octet-stream', 'X-Meta': meta, 'Content-Length': buf.length }, body: buf });
      if (res.status === 401 || res.status === 403) throw Object.assign(new Error('unauthorized'), { fatal: true });
      if (!res.ok) throw new Error(`push image ${res.status}`);
      const { seq } = await res.json();
      if (seq != null) store.markSynced(id, seq);
    } else {
      const body = JSON.stringify({ text: row.text, originDeviceId: deviceId, originId: id });
      const res = await fetch(`${base}/clip`, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }, body });
      if (res.status === 401 || res.status === 403) throw Object.assign(new Error('unauthorized'), { fatal: true });
      if (!res.ok) throw new Error(`push text ${res.status}`);
      const { seq } = await res.json();
      if (seq != null) store.markSynced(id, seq);
    }
    return true;
  }

  // 补传队列：本机产生、主机未确认的条目
  async function flushUnsynced() {
    const ids = store.listUnsynced(deviceId);
    for (const id of ids) {
      if (stopped) return;
      try {
        await pushRow(id);
      } catch (err) {
        if (err.fatal) throw err;
        return; // 网络问题：等下一轮
      }
    }
  }

  async function applyItem(item) {
    if (item.origin_device_id === deviceId) return; // 回声：自己的内容回来
    if (item.type === 'image') {
      const res = await fetch(`${base}/image/${item.id}`, { headers });
      if (!res.ok) throw new Error(`fetch image ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      const r = store.insertRemoteImage(buf, {
        width: item.width, height: item.height,
        originDeviceId: item.origin_device_id, originId: item.origin_id, hostSeq: item.id,
      });
      if (r) setLastSeq(item.id);
      else setLastSeq(item.id); // 内容去重也算已消费该 seq
    } else {
      const r = store.insertRemoteText({
        text: item.text, originDeviceId: item.origin_device_id, originId: item.origin_id, hostSeq: item.id,
      });
      setLastSeq(item.id); // 幂等去重/内容去重都算消费
    }
  }

  async function pullSince() {
    const res = await fetch(`${base}/items?since=${getLastSeq()}&limit=500`, { headers });
    if (res.status === 401 || res.status === 403) throw Object.assign(new Error('unauthorized'), { fatal: true });
    if (!res.ok) throw new Error(`pull ${res.status}`);
    const { items } = await res.json();
    for (const item of items) {
      if (stopped) return;
      await applyItem(item);
    }
  }

  function connectSse() {
    return new Promise((resolve, reject) => {
      const req = http.get({ host: hostIp, port: hostPort, path: '/events', headers }, (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          reject(Object.assign(new Error(`sse ${res.statusCode}`), { fatal: res.statusCode === 401 || res.statusCode === 403 }));
          return;
        }
        esRes = res;
        let buf = '';
        res.on('data', (c) => {
          buf += c.toString('utf8');
          let i;
          while ((i = buf.indexOf('\n\n')) >= 0) {
            const frame = buf.slice(0, i);
            buf = buf.slice(i + 2);
            const m = frame.match(/^data: (.*)$/m);
            if (!m) continue;
            try {
              const ev = JSON.parse(m[1]);
              applyItem({
                id: ev.seq, type: ev.kind === 'image' ? 'image' : 'text', text: ev.text,
                width: ev.width, height: ev.height,
                origin_device_id: ev.originDeviceId, origin_id: ev.originId,
              }).catch((err) => console.error('同步条目入库失败:', err));
            } catch (err) {
              console.error('同步事件解析失败:', err);
            }
          }
        });
        res.on('close', () => { esRes = null; reject(new Error('sse-closed')); });
        resolve();
      });
      req.on('error', reject);
    });
  }

  async function cycle() {
    while (!stopped) {
      status('connecting');
      try {
        const health = await fetch(`${base}/health`, { headers });
        if (health.status === 401 || health.status === 403) throw Object.assign(new Error('unauthorized'), { fatal: true });
        if (!health.ok) throw new Error(`health ${health.status}`);
        await pullSince();
        await flushUnsynced();
        status('connected');
        retryMs = RETRY_MIN_MS;
        await connectSse(); // 长连，断开则抛错进下一轮
      } catch (err) {
        if (stopped) return;
        if (esRes) { try { esRes.destroy(); } catch { /* 已断 */ } esRes = null; }
        if (err.fatal) {
          status('error');
          return; // 鉴权错：不重试，等用户改配置
        }
        status('disconnected');
        await new Promise((r) => setTimeout(r, retryMs));
        retryMs = Math.min(retryMs * 2, RETRY_MAX_MS);
      }
    }
  }

  flushTimer = setInterval(() => {
    if (stopped) return;
    flushUnsynced().catch(() => { /* 下一轮 */ });
  }, FLUSH_INTERVAL_MS);
  if (typeof flushTimer.unref === 'function') flushTimer.unref();
  const cyclePromise = cycle();

  return {
    pushLocal(id) {
      // 立即尝试上传（不等 5s 周期）；失败留队列
      pushRow(id).catch(() => { /* listUnsynced 兜底 */ });
    },
    async stop() {
      stopped = true;
      clearInterval(flushTimer);
      if (esRes) { try { esRes.destroy(); } catch { /* 已断 */ } }
      await cyclePromise.catch(() => { /* 循环退出即完成 */ });
    },
  };
}

module.exports = { startSyncClient };
```

Run: 单文件测试 4/4 绿。若时序偶发失败（sleep 窗口），把对应 sleep 加大到 1500 并说明。

- [ ] **Step 3: 全量回归 + Commit**

Run: `npm test` — Expected: **131/131**（127 + 4 syncclient）。

```bash
git add src/main/syncclient.js tests/syncclient.test.js
git commit -m "feat: 局域网共享客户端——断线补拉/SSE 实时/补传队列/回声抑制"
```

---

## Task 4: index.js 接线 + 连接窗口 + 托盘 UI + README + 冒烟

**Files:**
- Modify: `src/main/index.js`
- Modify: `src/main/ipc.js`
- Create: `src/renderer/syncconn.html`、`src/renderer/syncconn.js`
- Modify: `README.md`

- [ ] **Step 1: index.js 接线**

顶部 require 加：

```js
const { startSyncServer } = require('./syncserver');
const { startSyncClient } = require('./syncclient');
const { lanIp } = require('./qrserver');
```

模块级（`let dataPaths = null;` 旁）加：

```js
let syncHandle = null;
let syncStatus = 'off'; // off | connecting | connected | disconnected | error
let syncTrayStatusItem = null;
```

whenReady 内 `dataPaths = paths;` 之后加（store/privacyConfig 已就绪）：

```js
  startSync();
```

函数定义（createTray 之前）加：

```js
  function updateSyncTrayStatus() {
    if (!syncTrayStatusItem) return;
    const label = {
      off: '共享剪贴板：未开启',
      connecting: '共享剪贴板：连接中…',
      connected: '共享剪贴板：已连接',
      disconnected: '共享剪贴板：已断开，重连中…',
      error: '共享剪贴板：连接失败（请检查配对）',
    }[syncStatus];
    syncTrayStatusItem.label = label;
  }

  function stopSync() {
    if (syncHandle) {
      const h = syncHandle;
      syncHandle = null;
      h.stop().catch(() => { /* 停止失败不阻塞 */ });
    }
    syncStatus = 'off';
    updateSyncTrayStatus();
  }

  function startSync() {
    stopSync();
    const s = privacyConfig.getSync();
    if (s.role === 'host' && s.token) {
      try {
        const ip = lanIp();
        startSyncServer({
          store, imagesDir: dataPaths.imagesDir, token: s.token, deviceId: s.deviceId, ip,
        }).then((srv) => {
          syncHandle = srv;
          syncStatus = 'connected';
          updateSyncTrayStatus();
          // 探测到的实际端口可能与上次不同，写回配置
          if (s.hostPort !== srv.port || s.hostIp !== ip) {
            privacyConfig.setSync({ hostIp: ip, hostPort: srv.port });
          }
        }).catch((err) => {
          console.error('共享服务启动失败:', err);
          syncStatus = 'error';
          updateSyncTrayStatus();
        });
      } catch (err) {
        console.error('共享服务启动失败（无局域网 IP？）:', err);
        syncStatus = 'error';
        updateSyncTrayStatus();
      }
    } else if (s.role === 'client' && s.hostIp && s.hostPort && s.token) {
      syncStatus = 'connecting';
      updateSyncTrayStatus();
      const client = startSyncClient({
        store, imagesDir: dataPaths.imagesDir, token: s.token, deviceId: s.deviceId,
        hostIp: s.hostIp, hostPort: s.hostPort,
        getLastSeq: () => privacyConfig.getSync().lastSeq,
        setLastSeq: (n) => privacyConfig.setSync({ lastSeq: n }),
        onStatus: (st) => {
          syncStatus = st;
          updateSyncTrayStatus();
        },
      });
      syncHandle = client;
    }
  }
```

watcher onClip 里 `const id = store.insert(text);` 之后（pet 判断之前）加：

```js
        if (id != null) {
          store.markOrigin(id, privacyConfig.getSync().deviceId);
          if (syncHandle) syncHandle.pushLocal(id);
        }
```

onImage 里 `const id = store.insertImage(img.buffer, img.width, img.height);` 之后同样加：

```js
        if (id != null) {
          store.markOrigin(id, privacyConfig.getSync().deviceId);
          if (syncHandle) syncHandle.pushLocal(id);
        }
```

`app.on('will-quit', ...)` 所在的退出清理处加 `stopSync();`（watcher.stop 旁）。

托盘菜单：「存储位置」三组之后、「隐私模式」之前插入。主机/客户端共用的动态构建——createTray() 构建时按当前 role 生成模板段：

```js
    { type: 'separator' },
    syncSection(),
    { type: 'separator' },
```

其中 `syncSection()` 在 createTray 外定义为返回数组的函数（用 ... 展开进模板）：

```js
  function syncSection() {
    const s = privacyConfig.getSync();
    if (s.role === 'host') {
      const addr = syncHandle && syncHandle.port
        ? `${privacyConfig.getSync().hostIp}:${syncHandle.port}` : '启动中…';
      return [
        { label: `共享主机：${addr}`, enabled: false },
        {
          label: '重新生成配对码',
          click: () => {
            privacyConfig.setSync({ token: require('node:crypto').randomBytes(16).toString('hex') });
            startSync(); // 重启服务换新 token
          },
        },
        { label: '关闭共享服务', click: () => { privacyConfig.setSync({ role: null }); stopSync(); createTray(); } },
      ];
    }
    if (s.role === 'client') {
      return [
        { label: '共享剪贴板', id: 'sync-status', enabled: false },
        { label: '断开连接', click: () => { privacyConfig.setSync({ role: null }); stopSync(); createTray(); } },
      ];
    }
    return [
      { label: '开启共享主机…', click: () => {
          privacyConfig.setSync({ role: 'host', token: require('node:crypto').randomBytes(16).toString('hex') });
          startSync();
          createTray(); // 重建托盘显示地址段
        } },
      { label: '连接共享主机…', click: () => openSyncConnWin() },
    ];
  }
```

createTray 构建模板处把 `syncSection()` 展开（`...syncSection()`），并在模板里给状态项挂 id：`{ label: '共享剪贴板', id: 'sync-status', enabled: false }` 已在 syncSection 内。createTray() 末尾把 `syncTrayStatusItem = trayMenu.getMenuItemById ? null : null` 省略——改为：buildFromTemplate 之前 `const template = [...]`，build 之后 `syncTrayStatusItem = menu.getMenuItemById('sync-status'); updateSyncTrayStatus();`。

（注意：现有 createTray 是 `tray.setContextMenu(Menu.buildFromTemplate([...]))` 形式——按现有代码风格最小改动接入；`syncTrayStatusItem` 只在 client 角色有值，host 角色的地址项是构建时快照，重启服务/换码后已 createTray() 重建。）

连接窗口（仿 v6 qrwin 的小窗模式，但需输入——用独立小窗 + ipc）：

`src/renderer/syncconn.html`：

```html
<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'self'; style-src 'self' 'unsafe-inline'">
  <title>连接共享主机</title>
  <style>
    body { font: 14px system-ui; margin: 0; padding: 16px; background: #fff; color: #222; }
    label { display: block; margin: 8px 0 4px; }
    input { width: 100%; box-sizing: border-box; padding: 6px 8px; border: 1px solid #ccc; border-radius: 6px; }
    button { margin-top: 12px; padding: 6px 16px; border: none; border-radius: 6px; background: #4a7dff; color: #fff; cursor: pointer; }
    #err { color: #d33; margin-top: 8px; min-height: 1em; }
  </style>
</head>
<body>
  <label>主机 IP:端口（如 192.168.1.5:43789）</label>
  <input id="addr" placeholder="192.168.1.5:43789">
  <label>配对码（主机托盘「重新生成配对码」可见？—— 见下）</label>
  <input id="token" placeholder="配对码">
  <button id="go">连接</button>
  <div id="err"></div>
  <script src="syncconn.js"></script>
</body>
</html>
```

`src/renderer/syncconn.js`：

```js
const { ipcRenderer } = require('electron');
document.getElementById('go').addEventListener('click', async () => {
  const addr = document.getElementById('addr').value.trim();
  const token = document.getElementById('token').value.trim();
  const err = document.getElementById('err');
  err.textContent = '';
  const m = addr.match(/^([\d.]+):(\d+)$/);
  if (!m) { err.textContent = '地址格式应为 IP:端口'; return; }
  if (!token) { err.textContent = '请输入配对码'; return; }
  const res = await ipcRenderer.invoke('sync-connect', { hostIp: m[1], hostPort: Number(m[2]), token });
  if (res.ok) window.close();
  else err.textContent = res.error || '连接失败';
});
```

配对码可见性问题：主机托盘显示「共享主机：IP:端口」但 token 太长不显示全。主机加菜单项「复制配对码」→ clipboard.writeText(token)。

主机段加一项（syncSection host 分支，addr 项之后）：

```js
        { label: '复制配对码', click: () => clipboard.writeText(privacyConfig.getSync().token || '') },
```

主进程窗口与 ipc（index.js，仿 qrWin 的独立小窗；ipc.js 注册 invoke）：

index.js `openSyncConnWin`：

```js
  let syncConnWin = null;
  function openSyncConnWin() {
    if (syncConnWin) { syncConnWin.focus(); return; }
    syncConnWin = new BrowserWindow({
      width: 320, height: 240, resizable: false, maximizable: false, minimizable: false,
      parent: win || undefined, modal: false, autoHideMenuBar: true,
      webPreferences: { preload: path.join(__dirname, 'preload.js') },
    });
    syncConnWin.loadFile(path.join(__dirname, '../renderer/syncconn.html'));
    syncConnWin.on('closed', () => { syncConnWin = null; });
  }
```

（确认现有 preload 暴露了什么——读 src/main/preload.js 与 ipc.js 的注册方式，仿照现有 `qr-*` 或 palette 的模式注册 `sync-connect`；若 preload 用 contextBridge.exposeInMainWorld 则 renderer 端用 window.xxx 而非 require('electron')。**实现前必须读 preload.js 与 ipc.js 决定正确的桥接方式**，并在 syncconn.js 中用与现有 renderer 一致的桥。）

ipc.js 注册（按现有 registerIpc 模式）：

```js
  ipcMain.handle('sync-connect', async (_e, { hostIp, hostPort, token }) => {
    try {
      const res = await fetch(`http://${hostIp}:${hostPort}/health`, {
        headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(3000),
      });
      if (!res.ok) return { ok: false, error: '配对码错误或主机不可达' };
      privacyConfig.setSync({ role: 'client', hostIp, hostPort, token });
      startSync(); // index.js 作用域——通过注入的回调调用（见下）
      createTray();
      return { ok: true };
    } catch {
      return { ok: false, error: '主机不可达（IP/端口/网络）' };
    }
  });
```

index.js 的 registerIpc 调用处现有注入对象（类似 `{ store, qrWin, ... }`）加 `onSyncConnect: (cfg) => { privacyConfig.setSync({ role: 'client', ...cfg }); startSync(); createTray(); }`，ipc.js 的 handler 改为调 `handlers.onSyncConnect({hostIp, hostPort, token})` 并先自行做 health 检查（或移到 index.js）。**以现有 ipc.js 注入风格为准**。

- [ ] **Step 2: 语法检查 + 全量回归**

Run: `node --check src/main/index.js src/main/syncserver.js src/main/syncclient.js src/main/ipc.js && npm test` — Expected: OK，**131/131**。

- [ ] **Step 3: 冒烟（单机回环）**

1. `pgrep -fl electron` 检查并 kill 既有实例（如实报告）；备份 config.json。
2. 后台 `npm start` 等 6 秒；托盘「开启共享主机…」无法自动点击（坐标脆）——改为直接写 config：`jq` 或手写把 `sync` 字段设为 `{role:'host', token:'smoketoken123', deviceId:'smoke-host', lastSeq:0}`（保留其他字段）；重启应用等 6 秒。
3. 从 config.json 读出实际 hostIp/hostPort（应用启动后会把探测到的 IP:端口写回）；`curl -H "Authorization: Bearer smoketoken123" http://IP:端口/health` 应返回 `{"ok":true}`；错 token 应 401。
4. `curl -X POST -H "Authorization: Bearer smoketoken123" -H "Content-Type: application/json" -d '{"text":"冒烟同步文本","originDeviceId":"smoke-client","originId":1}' http://IP:端口/clip` → 返回 `{"seq":N}`；`curl -N -H "Authorization: Bearer smoketoken123" http://IP:端口/events &` 后再 POST 一条 → 确认 SSE 流收到；kill curl。
5. 用 sqlite3/应用窗口确认两条远端文本进了当天抽屉（v7 之后 db 位置可能在自定义目录——冒烟前确认 dataDir 为默认）。
6. 真实 DB 清理：DELETE 掉冒烟插入的确切文本（按 text 精确匹配，报告删除行数）；恢复 config.json 备份（去掉 sync 字段）；kill 应用；确认默认库无残留、config 还原。
7. 托盘 UI 与双机实测留给用户手动验证。

- [ ] **Step 4: README + Commit**

README「功能」列表加一条：

```markdown
- 局域网共享剪贴板：一台机器开「共享主机」，其他机器输 IP + 配对码连接，复制内容实时同步到所有机器（断网自动补拉补齐）
```

「数据位置」章节后新增「局域网共享」小节：

```markdown
## 局域网共享

托盘菜单「开启共享主机…」把本机变为共享源（显示 IP:端口，「复制配对码」给配对用）；其他机器「连接共享主机…」输入 IP:端口 + 配对码即可。同步内容：文本与图片（疑似密码各端按自己的隐私模式打码）。只同步开启后的新内容；断网期间的内容恢复连接后自动补齐。仅建议可信局域网使用（明文传输 + 配对码鉴权）。
```

```bash
git add src/main/index.js src/main/ipc.js src/renderer/syncconn.html src/renderer/syncconn.js README.md
git commit -m "feat: 局域网共享剪贴板接线——托盘 UI、连接窗口、watcher 推送、退出清理"
```

---

## 自检记录

- Spec 覆盖：主机服务(§3.3→T2)、客户端/补拉补传/回声抑制(§3.4→T3)、store 迁移(§3.4→T1)、隐私(§3.5→协议不传 is_secret，T2/T3 无该字段)、配置(§3.6→T1)、托盘 UI(§3.7→T4)、错误处理表(§4→T2 限制/401/413、T3 退避/fatal)、测试策略(§5→T1-T3 单测集成、T4 冒烟)。
- 无占位符：所有代码步骤含完整实现；T4 的 preload/桥接细节因取决于现有 preload.js 实现而明确指示"先读再仿"，非占位符（决定权在现有代码事实）。
- 类型一致：insertRemoteText/insertRemoteImage/markOrigin/markSynced/listUnsynced/listSince 在 T1 定义、T2/T3/T4 消费；startSyncServer({store, imagesDir, token, deviceId, ip, portRange}) → {port, ip, stop, pushLocal}；startSyncClient(opts) → {pushLocal, stop}；getSync/setSync 的 sync 字段六键一致。
- 测试计数：108 基线 → T1 后 120（+9 store-sync +3 privacyConfig）→ T2 后 127（+7 syncserver）→ T3 后 131（+4 syncclient）→ T4 不增（渲染层惯例 + 接线无新单测，冒烟覆盖）。

## 执行期修订

- **T1 加固（a448d08）**：质量审查建议 markOrigin 加 `origin_device_id IS NULL` 守卫 + 4 条边界测试，计数 +4（120→124）。
- **T2 契约与修正（9a6261e/20e18c1）**：质量审查 3 条契约写入派单——去重仍回 ACK（seq=当天已存在行 id，不回 null）、origin 可 null 原样传出、handler 异常兜底。实现者修正计划原文两处违约：/clip-image 去重 ACK（计划原文回 seq:null 会致无限重传）、findExisting 限当天范围。store.js 追加 findTextIdToday/findImageIdToday 只读方法。新增「内容去重仍回 ACK」测试 + X-Meta 400/SSE 503 测试。计数 124→132→134。
- **T3 修订**：新增「null-origin 历史行消费 seq 不插入」测试（5 条而非计划 4 条）；400 视为 fatal（数据非法重试无意义）。计数预期 134→139。
- **T3 实现修正（a800527）**：计划原文 3 处不自洽被实现者修复——connectSse 应挂起至 close 才 reject（立即 resolve 导致紧密重连循环 + SSE 泄漏 + 耗尽 16 上限）；Electron/undici fetch 静默忽略 agent:false，改 `Connection: close` 禁连接复用（keep-alive 死 socket 致全量跑必挂）；imagesDir 统一回退 `imagesDir || store.imagesDir`（syncserver /image 与 syncclient pushRow 两处）。
- **T3 健壮性修复（193aeb1）**：质量审查 3 阻塞项（SSE apply 不串行致失败条目永久丢失、fetch 无超时 stop 挂死、退避不可中断拖 30s）+ 2 非阻塞（队列毒化、flushTimer 吞 fatal）修复，+2 断点重放测试。计数 139→141。
- **T4 接线修复（91b4502）**：质量审查 3 P1——stopSync 对 host 的同步 stop 调 .catch 抛 TypeError、host server pending 回填无角色复查致泄漏、markOrigin 无条件调用破坏「只同步开启后的新内容」且涉历史/密码原文上传（改为 role 非 null 才标记，与 spec §3.4 一致）；2 P2——syncconn try/catch + 按钮防重入、host 启动失败托盘无显示。P3（复制配对码经剪贴板入历史）判定低危接受。createTray 重建不 destroy 旧 Tray（70aeee1 引入）随后补修（345ba5b）。
- **终审修复（511b7ec）**：终审 2 P1——syncclient pullSince 不翻页（>500 积压永久丢失，改循环到页不满）、先快照后订阅 TOCTOU（改 SSE 200 订阅成功后二次追平）；加固：客户端对主机数据加 1MB/10MB 上限校验（防恶意主机写满磁盘），+2 测试。
