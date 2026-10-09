# 图片支持 + 键盘导航 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在已合并 main 的剪贴板抽屉柜上增量增加：剪贴板图片捕获/存储/缩略图展示/点击复制，以及键盘导航（↑↓ 选择、Enter 复制、Cmd/Ctrl+K 聚焦搜索、Esc 语义细化）。

**Architecture:** 图片以 PNG 文件存 `userData/images/<sha256前16位>.png`（同哈希复用），SQLite 存元数据（type/image_path/width/height），旧库启动时 ALTER 迁移。渲染端通过自定义 `clipimg://thumb/<id>` 协议加载缩略图。键盘导航为渲染层状态（selectedIndex）+ 全局 keydown。

> **执行期修正案（2026-10-09）**：Task 5 集成冒烟发现 `clipimg://<id>` 在 standard scheme 下被 Chromium 把纯数字主机名归一化为 IPv4（`clipimg://12` → `clipimg://0.0.0.12/`），导致缩略图 404。已改为 `clipimg://thumb/<id>` 并从 pathname 解析 id（提交 b91652e，CDP 验证 200）。

**Tech Stack:** Electron 33 (protocol.handle), better-sqlite3, node:crypto, node:test

**设计文档:** `docs/superpowers/specs/2026-10-09-image-support-keyboard-nav-design.md`

---

## Task 1: store.js 图片支持（TDD）

**Files:**
- Test: `tests/store.test.js`（追加 7 个测试）
- Modify: `src/main/store.js`

- [ ] **Step 1: 追加失败测试（在 tests/store.test.js 末尾追加，同时在文件头部 require 区加入 `const Database = require('better-sqlite3');`）**

```js
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
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npm test`
Expected: FAIL — `ClipStore` 构造器不接受第二参数 / 无 insertImage 方法（TypeError）。

- [ ] **Step 3: 修改 src/main/store.js**

头部 requires 增加：

```js
const crypto = require('node:crypto');
const path = require('node:path');
```

构造器签名改为 `constructor(dbPath = ':memory:', imagesDir = null)`，在 `this.db = new Database(dbPath);` 之后加入：

```js
if (imagesDir) fs.mkdirSync(imagesDir, { recursive: true });
this.imagesDir = imagesDir;
this.migrate();
```

CREATE TABLE 语句更新为（新库直接建全量列；旧库靠 migrate 补列）：

```js
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS clips (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        text TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        type TEXT NOT NULL DEFAULT 'text',
        image_path TEXT,
        width INTEGER,
        height INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_created_at ON clips(created_at);
    `);
```

新增 migrate 方法（放在构造器内 exec 之后调用的类方法）：

```js
  // 旧库升级：按需补充图片相关列（带默认值，存量行视为文本）
  migrate() {
    const cols = this.db.prepare('PRAGMA table_info(clips)').all().map((c) => c.name);
    if (!cols.includes('type')) {
      this.db.exec("ALTER TABLE clips ADD COLUMN type TEXT NOT NULL DEFAULT 'text'");
    }
    if (!cols.includes('image_path')) {
      this.db.exec('ALTER TABLE clips ADD COLUMN image_path TEXT');
    }
    if (!cols.includes('width')) {
      this.db.exec('ALTER TABLE clips ADD COLUMN width INTEGER');
    }
    if (!cols.includes('height')) {
      this.db.exec('ALTER TABLE clips ADD COLUMN height INTEGER');
    }
  }
```

注意：migrate() 在构造器中的调用必须放在 CREATE TABLE exec 之后；CREATE 语句本身不含 migrate（顺序：exec → mkdir/imagesDir → migrate 均可，确保 migrate 在 exec 后）。构造器语句顺序统一为：

```js
  constructor(dbPath = ':memory:', imagesDir = null) {
    this.db = new Database(dbPath);
    this.db.exec(` ...上面的新 CREATE TABLE... `);
    if (imagesDir) fs.mkdirSync(imagesDir, { recursive: true });
    this.imagesDir = imagesDir;
    this.migrate();
    // ... 原有 prepared statements ...
  }
```

查询语句全部带出新列：

```js
    this.insertStmt = this.db.prepare('INSERT INTO clips (text, created_at) VALUES (?, ?)');
    this.existsStmt = this.db.prepare(
      'SELECT id FROM clips WHERE text = ? AND created_at >= ? AND created_at < ?'
    );
    this.listByDayStmt = this.db.prepare(
      'SELECT id, text, created_at, type, image_path, width, height FROM clips WHERE created_at >= ? AND created_at < ? ORDER BY created_at DESC'
    );
    this.searchStmt = this.db.prepare(
      "SELECT id, text, created_at, type, image_path, width, height FROM clips WHERE type = 'text' AND text LIKE ? ESCAPE '\\' ORDER BY created_at DESC LIMIT 200"
    );
    this.getStmt = this.db.prepare(
      'SELECT id, text, created_at, type, image_path, width, height FROM clips WHERE id = ?'
    );
    this.deleteStmt = this.db.prepare('DELETE FROM clips WHERE id = ?');
    this.clearDayStmt = this.db.prepare('DELETE FROM clips WHERE created_at >= ? AND created_at < ?');
    this.countByDayStmt = this.db.prepare(
      'SELECT COUNT(*) AS n FROM clips WHERE created_at >= ? AND created_at < ?'
    );
    this.insertImageStmt = this.db.prepare(
      'INSERT INTO clips (text, created_at, type, image_path, width, height) VALUES (?, ?, ?, ?, ?, ?)'
    );
    this.imageExistsStmt = this.db.prepare(
      'SELECT id FROM clips WHERE image_path = ? AND created_at >= ? AND created_at < ?'
    );
    this.imageRefsStmt = this.db.prepare(
      'SELECT COUNT(*) AS n FROM clips WHERE image_path = ?'
    );
    this.dayImagesStmt = this.db.prepare(
      "SELECT image_path FROM clips WHERE type = 'image' AND created_at >= ? AND created_at < ?"
    );
```

delete 方法改为（先取行，删行，图片行清理文件）：

```js
  delete(id) {
    const row = this.getStmt.get(id);
    if (!row) return;
    this.deleteStmt.run(id);
    if (row.type === 'image') this.removeImageFile(row.image_path);
  }

  // 无任何行再引用该图片文件时删除它
  removeImageFile(fileName) {
    if (!this.imagesDir || !fileName) return;
    if (this.imageRefsStmt.get(fileName).n > 0) return;
    try {
      fs.unlinkSync(path.join(this.imagesDir, fileName));
    } catch {
      // 文件可能已不存在
    }
  }
```

clearDay 方法改为：

```js
  clearDay(dateKey) {
    const [start, end] = dayRange(dateKey);
    const images = this.dayImagesStmt.all(start, end);
    this.clearDayStmt.run(start, end);
    for (const { image_path } of images) this.removeImageFile(image_path);
  }
```

新增 insertImage 方法（放在 insert 之后）：

```js
  // 图片入库：sha256 哈希命名文件写入 imagesDir（同哈希复用同一文件），元数据入库。
  // 同一天内同图不重复记录；无 imagesDir 或写盘失败返回 null。
  insertImage(buffer, width, height, now = Date.now()) {
    if (!this.imagesDir || !Buffer.isBuffer(buffer) || !buffer.length) return null;
    const hash = crypto.createHash('sha256').update(buffer).digest('hex');
    const fileName = hash.slice(0, 16) + '.png';
    const [start, end] = dayRange(toDateKey(now));
    if (this.imageExistsStmt.get(fileName, start, end)) return null;
    try {
      const filePath = path.join(this.imagesDir, fileName);
      if (!fs.existsSync(filePath)) fs.writeFileSync(filePath, buffer);
    } catch (err) {
      console.error('图片写盘失败:', err);
      return null;
    }
    return this.insertImageStmt.run('', now, 'image', fileName, width ?? null, height ?? null)
      .lastInsertRowid;
  }
```

openStore 改为：

```js
function openStore(dbPath, imagesDir = null) {
  let probe;
  try {
    probe = new Database(dbPath);
    probe.prepare('SELECT COUNT(*) FROM sqlite_master').get();
  } catch (err) {
    if (dbPath === ':memory:' || !fs.existsSync(dbPath)) throw err;
    try { probe.close(); } catch { /* 已关闭 */ }
    probe = null;
    fs.renameSync(dbPath, dbPath + '.bak');
  } finally {
    if (probe) {
      try { probe.close(); } catch { /* 已关闭 */ }
    }
  }
  return new ClipStore(dbPath, imagesDir);
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npm test`
Expected: PASS — store 22 个 + 其余 11 个 = 33/33。

- [ ] **Step 5: Commit**

```bash
git add tests/store.test.js src/main/store.js
git commit -m "feat: 数据层图片支持（哈希去重/文件存储/引用计数清理/旧库迁移）"
```

---

## Task 2: watcher.js 图片分支（TDD）

**Files:**
- Test: `tests/watcher.test.js`（重写以适配新构造器 + 追加 3 个测试）
- Modify: `src/main/watcher.js`

- [ ] **Step 1: 重写 tests/watcher.test.js 为以下内容**

```js
const test = require('node:test');
const assert = require('node:assert');
const { ClipboardWatcher } = require('../src/main/watcher');

function makeWatcher(readText) {
  const got = [];
  const w = new ClipboardWatcher({
    readText,
    onClip: (t) => got.push(t),
    intervalMs: 10,
  });
  return { w, got };
}

test('剪贴板文本变化时触发 onClip', () => {
  let current = 'a';
  const { w, got } = makeWatcher(() => current);
  w.check();
  current = 'b';
  w.check();
  current = 'b';
  w.check(); // 无变化，不触发
  assert.deepStrictEqual(got, ['a', 'b']);
});

test('空文本和纯空白不触发', () => {
  const { w, got } = makeWatcher(() => '   ');
  w.check();
  assert.deepStrictEqual(got, []);
});

test('readText 抛错时跳过并记录日志，下次恢复', () => {
  let fail = true;
  const got = [];
  const w = new ClipboardWatcher({
    readText: () => {
      if (fail) throw new Error('clipboard unavailable');
      return 'ok';
    },
    onClip: (t) => got.push(t),
    intervalMs: 10,
  });
  w.check();
  fail = false;
  w.check();
  assert.deepStrictEqual(got, ['ok']);
});

test('start/stop 控制轮询定时器', async () => {
  let current = 'x';
  const { w, got } = makeWatcher(() => current);
  w.start();
  current = 'y';
  await new Promise((r) => setTimeout(r, 40));
  w.stop();
  const countAfterStop = got.length;
  current = 'z';
  await new Promise((r) => setTimeout(r, 40));
  assert.deepStrictEqual(got, ['x', 'y']);
  assert.strictEqual(got.length, countAfterStop);
});

test('剪贴板含图片时触发 onImage（按 key 去重），不读取文本', () => {
  const got = [];
  let key = 'a';
  const w = new ClipboardWatcher({
    hasImage: () => true,
    readImage: () => ({ buffer: Buffer.from('png'), width: 1, height: 1, key }),
    readText: () => {
      throw new Error('不应读取文本');
    },
    onClip: () => {
      throw new Error('不应触发文本回调');
    },
    onImage: (img) => got.push(img.key),
    intervalMs: 10,
  });
  w.check();
  key = 'b';
  w.check();
  key = 'b';
  w.check();
  assert.deepStrictEqual(got, ['a', 'b']);
});

test('空图片缓冲区跳过', () => {
  const got = [];
  const w = new ClipboardWatcher({
    hasImage: () => true,
    readImage: () => ({ buffer: Buffer.alloc(0), width: 0, height: 0, key: 'a' }),
    readText: () => 'ignored',
    onClip: () => {},
    onImage: () => got.push('img'),
    intervalMs: 10,
  });
  w.check();
  assert.deepStrictEqual(got, []);
});

test('readImage 抛错时跳过并记录日志，下次恢复', () => {
  let fail = true;
  const got = [];
  const w = new ClipboardWatcher({
    hasImage: () => true,
    readImage: () => {
      if (fail) throw new Error('image unavailable');
      return { buffer: Buffer.from('ok'), width: 1, height: 1, key: 'k' };
    },
    readText: () => 'ignored',
    onClip: () => {},
    onImage: () => got.push('img'),
    intervalMs: 10,
  });
  w.check();
  fail = false;
  w.check();
  assert.deepStrictEqual(got, ['img']);
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npm test`
Expected: FAIL — 新构造器缺 hasImage/readImage/onImage 处理（含图片的 3 个新测试失败；原 4 个测试因 makeWatcher 现在传对象字面量仍兼容 readText/onClip，应仍通过）。

- [ ] **Step 3: 修改 src/main/watcher.js 整体为**

```js
// 轮询系统剪贴板：含图片时走 onImage，否则走 onClip（文本）。
// hasImage/readImage/onImage 可选注入（默认无图片），便于测试；
// 主进程注入 electron clipboard 的对应操作。
class ClipboardWatcher {
  constructor({ hasImage, readImage, readText, onClip, onImage, intervalMs = 500 }) {
    if (typeof readText !== 'function' || typeof onClip !== 'function') {
      throw new Error('ClipboardWatcher 需要 readText 和 onClip 函数');
    }
    this.hasImage = hasImage || (() => false);
    this.readImage = readImage || (() => null);
    this.readText = readText;
    this.onClip = onClip;
    this.onImage = onImage || (() => {});
    this.intervalMs = intervalMs;
    this.lastSig = null;
    this.timer = null;
  }

  start() {
    if (this.timer) return;
    this.check(); // 启动时立即采样一次，捕获当前剪贴板
    this.timer = setInterval(() => this.check(), this.intervalMs);
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  check() {
    let sig = null;
    let payload = null;
    let handler = null;
    try {
      if (this.hasImage()) {
        const img = this.readImage();
        if (!img || !img.buffer || !img.buffer.length) return;
        sig = 'img:' + img.key;
        payload = img;
        handler = this.onImage;
      } else {
        const text = this.readText();
        if (!text || !text.trim()) return;
        sig = 'text:' + text;
        payload = text;
        handler = this.onClip;
      }
    } catch (err) {
      console.error('剪贴板读取失败:', err); // 跳过本次轮询，仅记录日志
      return;
    }
    if (sig !== this.lastSig) {
      this.lastSig = sig;
      handler(payload);
    }
  }
}

module.exports = { ClipboardWatcher };
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npm test`
Expected: PASS — 33/33。

- [ ] **Step 5: Commit**

```bash
git add tests/watcher.test.js src/main/watcher.js
git commit -m "feat: 剪贴板监听图片分支（格式检测/key 变化检测/空图与错误容忍）"
```

---

## Task 3: 主进程接线（index.js + ipc.js）

**Files:**
- Modify: `src/main/index.js`
- Modify: `src/main/ipc.js`

- [ ] **Step 1: 修改 src/main/ipc.js 整体为**

```js
const path = require('node:path');
const { ipcMain, clipboard, nativeImage } = require('electron');
const { getLast7Days, formatLabel } = require('./dates');

// 图片条目附带缩略图协议地址；文本条目 thumb 为 null
function withThumb(row) {
  return row.type === 'image'
    ? { ...row, text: '', thumb: `clipimg://thumb/${row.id}` }
    : { ...row, thumb: null };
}

// 注册所有 IPC handler。deps: { store, getWindow, imagesDir }
function registerIpc({ store, getWindow, imagesDir }) {
  // 最近 7 天抽屉元数据：[{ dateKey, label, count }]
  // 注意：todayKey 从 getLast7Days()[0] 统一取得再传给 formatLabel，
  // 避免两个调用各自读取 Date.now() 跨午夜时标签不一致。
  ipcMain.handle('clipboard:listDays', () => {
    const days = getLast7Days();
    const todayKey = days[0];
    return days.map((dateKey) => ({
      dateKey,
      label: formatLabel(dateKey, todayKey),
      count: store.countByDay(dateKey),
    }));
  });

  ipcMain.handle('clipboard:listByDay', (_event, dateKey) =>
    store.listByDay(dateKey).map(withThumb)
  );

  // 跨全部历史搜索（仅文本条目）
  ipcMain.handle('clipboard:search', (_event, keyword) => store.search(keyword));

  ipcMain.handle('clipboard:delete', (_event, id) => {
    store.delete(id);
    return true;
  });

  ipcMain.handle('clipboard:clearDay', (_event, dateKey) => {
    store.clearDay(dateKey);
    return true;
  });

  // 复制回剪贴板并隐藏窗口（文本写文本，图片写图片）
  ipcMain.handle('clipboard:copy', (_event, id) => {
    const row = store.get(id);
    if (!row) return false;
    if (row.type === 'image') {
      const imgPath = path.join(imagesDir, path.basename(row.image_path || ''));
      const img = nativeImage.createFromPath(imgPath);
      if (img.isEmpty()) return false;
      clipboard.writeImage(img);
    } else {
      clipboard.writeText(row.text);
    }
    const win = getWindow();
    if (win) win.hide();
    return true;
  });

  ipcMain.handle('window:hide', () => {
    const win = getWindow();
    if (win) win.hide();
  });
}

module.exports = { registerIpc };
```

- [ ] **Step 2: 修改 src/main/index.js**

头部 requires 改为：

```js
const path = require('node:path');
const crypto = require('node:crypto');
const { pathToFileURL } = require('node:url');
const {
  app, BrowserWindow, Tray, Menu, globalShortcut, nativeImage, clipboard, screen,
  protocol, net,
} = require('electron');
const { openStore } = require('./store');
const { ClipboardWatcher } = require('./watcher');
const { registerIpc } = require('./ipc');
```

在 `let win = null;` 等模块级变量之前加入协议注册（必须在 app ready 之前）：

```js
// 缩略图自定义协议：clipimg://thumb/<id>，仅允许返回 images 目录内的图片文件
// （主机名必须为 non-numeric：standard scheme 下纯数字主机会被 Chromium 归一化为 IPv4，如 clipimg://12 → clipimg://0.0.0.12/）
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'clipimg',
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true },
  },
]);
```

whenReady 回调整体改为：

```js
app.whenReady().then(() => {
  const dbPath = path.join(app.getPath('userData'), 'clipboard.db');
  const imagesDir = path.join(app.getPath('userData'), 'images');
  store = openStore(dbPath, imagesDir);

  protocol.handle('clipimg', async (request) => {
    try {
      const url = new URL(request.url);
      const id = Number(url.pathname.split('/').filter(Boolean)[0]);
      const row = store.get(id);
      if (!row || row.type !== 'image' || !row.image_path) {
        return new Response(null, { status: 404 });
      }
      const fileName = path.basename(row.image_path);
      return net.fetch(pathToFileURL(path.join(imagesDir, fileName)).toString());
    } catch {
      return new Response(null, { status: 404 });
    }
  });

  registerIpc({ store, getWindow: () => win, imagesDir });

  const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

  watcher = new ClipboardWatcher({
    hasImage: () => clipboard.availableFormats().some((f) => f.startsWith('image/')),
    readImage: () => {
      const img = clipboard.readImage();
      if (img.isEmpty()) return null;
      const buffer = img.toPNG();
      if (!buffer.length || buffer.length > MAX_IMAGE_BYTES) return null;
      const size = img.getSize();
      return {
        buffer,
        width: size.width,
        height: size.height,
        key: crypto.createHash('sha256').update(buffer).digest('hex'),
      };
    },
    readText: () => clipboard.readText(),
    onClip: (text) => {
      try {
        store.insert(text);
      } catch (err) {
        console.error('剪贴板写入数据库失败:', err);
      }
    },
    onImage: (img) => {
      try {
        store.insertImage(img.buffer, img.width, img.height);
      } catch (err) {
        console.error('图片写入数据库失败:', err);
      }
    },
    intervalMs: 500,
  });
  watcher.start();

  createTray();

  const registered = globalShortcut.register('CommandOrControl+Shift+V', showWindow);
  if (!registered) console.error('全局快捷键 CommandOrControl+Shift+V 注册失败');

  createWindow();
  showWindow(); // 首次启动展示一次
});
```

其余部分（createWindow / showWindow / createTray / activate / window-all-closed / will-quit）保持不变。

- [ ] **Step 3: 语法检查 + 回归**

Run: `node --check src/main/index.js && node --check src/main/ipc.js && npm test`
Expected: 无语法错误；33/33 通过。

- [ ] **Step 4: Commit**

```bash
git add src/main/index.js src/main/ipc.js
git commit -m "feat: 主进程图片接线（clipimg 协议/图片采样/图片复制回剪贴板）"
```

---

## Task 4: 渲染层（图片行 + 键盘导航）

**Files:**
- Modify: `src/renderer/index.html`（CSP 一行）
- Modify: `src/renderer/styles.css`（追加）
- Modify: `src/renderer/app.js`（多处）

- [ ] **Step 1: index.html 的 CSP meta 改为**

```html
  <meta http-equiv="Content-Security-Policy" content="default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' clipimg:">
```

- [ ] **Step 2: styles.css 追加**

```css
.item.selected { background: var(--active-bg); }
.item.selected .item-delete { visibility: visible; }
.item-thumb {
  width: 40px;
  height: 40px;
  object-fit: contain;
  border-radius: 4px;
  background: var(--bg-side);
  border: 1px solid var(--border);
  cursor: pointer;
  flex-shrink: 0;
}
```

- [ ] **Step 3: app.js 修改**

(3a) state 增加 items 与 selectedIndex：

```js
const state = { days: [], selected: null, keyword: '', items: [], selectedIndex: -1 };
```

(3b) selectDay 中在 renderDrawers() 之后加 `state.selectedIndex = -1;`（renderItems 之前）。

(3c) renderItems 改为：

```js
function renderItems(items) {
  state.items = items;
  if (state.selectedIndex >= items.length) state.selectedIndex = items.length - 1;
  itemsEl.innerHTML = '';
  if (!items.length) {
    itemsEl.innerHTML = '<div class="empty">暂无剪贴记录</div>';
    return;
  }
  for (let i = 0; i < items.length; i++) {
    const row = itemRow(items[i]);
    if (i === state.selectedIndex) row.classList.add('selected');
    itemsEl.appendChild(row);
  }
}
```

(3d) doSearch 的分组循环中，每个 itemRow 调用处改为按索引加选中类。具体：把

```js
    for (const item of group) itemsEl.appendChild(itemRow(item));
```

改为（在 doSearch 开头加 `state.selectedIndex = -1;`，并把分组追加改为带索引）：

doSearch 开头（titleEl.textContent 之前）加 `state.selectedIndex = -1;`。分组追加改为：

```js
  let flatIndex = 0;
  for (const [key, group] of groups) {
    const h = document.createElement('div');
    h.className = 'search-group';
    h.textContent = `${labelFor(key)} · ${group.length} 条`;
    itemsEl.appendChild(h);
    for (const item of group) {
      const row = itemRow(item);
      if (flatIndex === state.selectedIndex) row.classList.add('selected');
      itemsEl.appendChild(row);
      flatIndex++;
    }
  }
```

注意：此时 selectedIndex 恒为 -1，选中高亮在搜索态由键盘导航后的 moveSelection 重绘提供——更简单统一的做法：搜索态不逐行判 selected，键盘导航统一走 updateSelectionHighlight()（见 3g）。因此 doSearch 保持原有追加逻辑不变，仅加 `state.selectedIndex = -1;` 与 `state.items = rows;`（供 Enter 复制取数据）。

(3e) itemRow 改为支持图片（整体替换原函数）：

```js
function itemRow(item) {
  const row = document.createElement('div');
  row.className = 'item';

  const time = document.createElement('span');
  time.className = 'item-time';
  time.textContent = formatTime(item.created_at);

  if (item.type === 'image') {
    const thumb = document.createElement('img');
    thumb.className = 'item-thumb';
    thumb.src = item.thumb;
    thumb.alt = '';
    thumb.addEventListener('error', () => thumb.replaceWith(imageLabel(item)));
    thumb.addEventListener('click', () => window.api.copyClip(item.id));
    row.append(time, thumb);
  } else {
    const preview = document.createElement('span');
    preview.className = 'item-text';
    preview.textContent = truncate(item.text);
    preview.title = item.text;
    preview.addEventListener('click', () => window.api.copyClip(item.id));
    row.append(time, preview);
  }

  const del = document.createElement('button');
  del.className = 'item-delete';
  del.textContent = '×';
  del.title = '删除该条';
  del.addEventListener('click', async (e) => {
    e.stopPropagation();
    await window.api.deleteClip(item.id);
    refreshAfterMutation();
  });

  row.append(del);
  return row;
}

// 缩略图加载失败（文件缺失）时的占位
function imageLabel(item) {
  const label = document.createElement('span');
  label.className = 'item-text';
  label.textContent = `🖼 图片 · ${item.width}×${item.height}`;
  label.addEventListener('click', () => window.api.copyClip(item.id));
  return label;
}
```

(3f) 键盘导航：把原 keydown 监听（`if (e.key === 'Escape') window.api.hideWindow();`）整体替换为：

```js
function moveSelection(delta) {
  const n = state.items.length;
  if (!n) return;
  state.selectedIndex = Math.min(Math.max(state.selectedIndex + delta, 0), n - 1);
  updateSelectionHighlight();
}

function updateSelectionHighlight() {
  const rows = itemsEl.querySelectorAll('.item');
  rows.forEach((el, i) => el.classList.toggle('selected', i === state.selectedIndex));
  const el = rows[state.selectedIndex];
  if (el) el.scrollIntoView({ block: 'nearest' });
}

function clearSearch() {
  searchEl.value = '';
  state.keyword = '';
  if (state.selected) selectDay(state.selected);
}

window.addEventListener('keydown', (e) => {
  const mod = e.metaKey || e.ctrlKey;

  if (mod && e.key.toLowerCase() === 'k') {
    e.preventDefault();
    searchEl.focus();
    searchEl.select();
    return;
  }

  if (e.key === 'Escape') {
    if (document.activeElement === searchEl && searchEl.value) {
      e.preventDefault();
      clearSearch();
      return;
    }
    if (state.keyword) {
      clearSearch();
      return;
    }
    window.api.hideWindow();
    return;
  }

  if (document.activeElement === searchEl) {
    // 输入框内：可打字、↑↓ 交给列表导航、Enter 复制选中项（无选中则惰性）
    // （修正案：原计划"Enter 不复制"使键盘主流程断裂，60d9f08 改为有选中时复制）
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
  }

  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    moveSelection(e.key === 'ArrowDown' ? 1 : -1);
    return;
  }

  if (e.key === 'Enter' && state.selectedIndex >= 0) {
    e.preventDefault();
    const item = state.items[state.selectedIndex];
    if (item) window.api.copyClip(item.id);
  }
});
```

注意：moveSelection/updateSelectionHighlight/clearSearch 需在 keydown 监听之前定义（函数声明会提升，位置不敏感，但保持代码顺序清晰）。`state.items` 在搜索态与日期态都已由 renderItems/doSearch 填充。

(3g) 语法检查：

Run: `node --check src/renderer/app.js`
Expected: 无错误。

- [ ] **Step 4: Commit**

```bash
git add src/renderer/
git commit -m "feat: 渲染层图片缩略图与键盘导航（选中态/Enter 复制/⌘K 聚焦/Esc 语义）"
```

---

## Task 5: 集成冒烟 + README

**Files:**
- Modify: `README.md`

- [ ] **Step 1: 集成冒烟测试**

1. `node --check` 全部改动文件 + `npm test`（33/33）。
2. 后台 `npm start`，等待 6 秒。
3. 生成一张测试图片并复制到剪贴板（macOS）：
   `screencapture -x /tmp/clip-test.png && osascript -e 'set the clipboard to (read (POSIX file "/tmp/clip-test.png") as «class PNGf»)'`
   等待 2 秒。
4. 查询数据库确认图片条目：用 `ELECTRON_RUN_AS_NODE=1` electron 运行临时脚本查 `~/Library/Application Support/clipboard-drawer/clipboard.db` 的最新行（type 应为 'image'，width/height 非空），并确认 `~/Library/Application Support/clipboard-drawer/images/` 下有对应 .png 文件。
5. 截屏验证 UI：`screencapture -x /tmp/cut-img-smoke.png`（窗口失焦可能已隐藏——先通过 `osascript -e 'tell application "System Events"'` 或直接重新 show 不可行时，改为：kill 后重启应用使窗口弹出再截屏，或用 Task 7 验证过的 CoreGraphics 方式取窗口 ID 用 `screencapture -l <id>`）。Read 截图确认：今天抽屉计数含图片条目，列表中出现 ~40px 缩略图。
6. 清理：kill 应用、删除临时脚本。

无法自动化、留给用户手验：点击图片粘贴到聊天/预览、↑↓+Enter 键盘操作、>10MB 大图跳过。

- [ ] **Step 2: README.md 更新**

功能列表中“点击文本重新复制到剪贴板”一条之后插入：

```markdown
- 图片剪贴板自动存档（截图/复制图片，>10MB 跳过），行内缩略图，点击复制图片
```

在 `## 开发` 之前插入：

```markdown
## 快捷键

- `Cmd/Ctrl+Shift+V` 全局唤起窗口
- `↑` / `↓` 选择条目，`Enter` 复制选中条目
- `Cmd/Ctrl+K` 聚焦搜索框
- `Esc` 清空搜索（有搜索词时）或隐藏窗口
```

- [ ] **Step 3: 回归 + Commit**

Run: `npm test`（33/33）

```bash
git add README.md
git commit -m "docs: README 补充图片支持与快捷键说明"
```

---

## 自检记录

- **Spec 覆盖**：存储决策（T1）、去重/上限（T1/T3）、旧库迁移（T1）、watcher 图片分支（T2）、clipimg 协议与 copy 分支（T3）、行内缩略图（T4）、键盘导航全按键（T4）、删除清理文件（T1）、README（T5）。全部有对应任务。
- **类型一致性**：`insertImage(buffer, width, height, now)` 在 store 定义（T1）、index 调用（T3）一致；`registerIpc({store, getWindow, imagesDir})` T3 定义与 index 调用一致；watcher 构造器键 hasImage/readImage/onImage T2 定义、T3 注入、测试一致；条目行字段 type/thumb/width/height 在 ipc withThumb 与 renderer itemRow 间一致。
- **无占位符**：所有代码步骤含完整代码与命令。
