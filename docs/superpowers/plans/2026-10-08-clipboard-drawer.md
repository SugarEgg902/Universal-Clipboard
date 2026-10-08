# 剪贴板抽屉柜 (Clipboard Drawer) 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 构建一个 Electron 跨平台桌面应用，以"左侧竖排日期抽屉 + 右侧剪贴文本列表"的形式展示剪贴板历史，托盘常驻、全局快捷键唤起。

**Architecture:** Electron 主进程负责托盘/快捷键/剪贴板轮询/SQLite 持久化；渲染进程为无框架的原生 HTML/CSS/JS，通过 contextBridge + IPC 与主进程通信。数据层与日期工具为纯 CommonJS 模块，用 `node:test` 单测覆盖。

**Tech Stack:** Electron 33, better-sqlite3, electron-rebuild, electron-builder, cross-env, node:test

**设计文档:** `docs/superpowers/specs/2026-10-08-clipboard-drawer-design.md`

---

## 文件结构

```
cut/
├── package.json                  # 依赖、脚本、electron-builder 配置
├── .gitignore                    # node_modules, dist
├── assets/
│   └── trayTemplate.png          # 16x16 托盘图标（模板图）
├── src/
│   ├── main/
│   │   ├── index.js              # 入口：窗口/托盘/快捷键/生命周期
│   │   ├── dates.js              # 日期工具（纯函数，可测试）
│   │   ├── store.js              # SQLite 数据层（可测试）
│   │   ├── watcher.js            # 剪贴板轮询监听（可测试）
│   │   └── ipc.js                # IPC handler 注册
│   ├── preload.js                # contextBridge 暴露 window.api
│   └── renderer/
│       ├── index.html
│       ├── styles.css
│       └── app.js
├── tests/
│   ├── dates.test.js
│   ├── store.test.js
│   └── watcher.test.js
└── README.md
```

---

## Task 1: 项目脚手架

**Files:**
- Create: `package.json`
- Create: `.gitignore`
- Create: `src/main/index.js`（最小占位版）

- [ ] **Step 1: 创建 package.json**

```json
{
  "name": "clipboard-drawer",
  "version": "0.1.0",
  "description": "剪贴板抽屉柜：按日期展示剪贴板历史",
  "main": "src/main/index.js",
  "scripts": {
    "start": "electron .",
    "test": "cross-env ELECTRON_RUN_AS_NODE=1 electron --test tests/",
    "postinstall": "electron-rebuild -f -w better-sqlite3",
    "pack": "electron-builder --dir",
    "dist": "electron-builder"
  },
  "devDependencies": {
    "cross-env": "^7.0.3",
    "electron": "^33.0.0",
    "electron-builder": "^25.1.8",
    "electron-rebuild": "^3.7.1"
  },
  "dependencies": {
    "better-sqlite3": "^11.3.0"
  },
  "build": {
    "appId": "com.clipboarddrawer.app",
    "productName": "ClipboardDrawer",
    "files": ["src/**/*", "assets/**/*", "package.json"],
    "mac": { "category": "public.app-category.utilities" },
    "win": { "target": "nsis" },
    "linux": { "target": "AppImage", "category": "Utility" }
  }
}
```

注意：`test` 脚本用 `ELECTRON_RUN_AS_NODE=1 electron --test` 运行——因为 `postinstall` 会把 better-sqlite3 重编译为 Electron ABI，系统 node 无法加载它，必须以 node 模式运行 Electron 来跑测试。

- [ ] **Step 2: 创建 .gitignore**

```
node_modules/
dist/
npm-debug.log
```

- [ ] **Step 3: 创建最小 src/main/index.js（占位，Task 7 会替换为完整版）**

```js
const { app, BrowserWindow } = require('electron');

app.whenReady().then(() => {
  const win = new BrowserWindow({ width: 760, height: 500 });
  win.loadURL('data:text/html;charset=utf-8,<h1 style="font-family:sans-serif">Clipboard Drawer</h1>');
});
```

- [ ] **Step 4: 安装依赖并验证启动**

Run: `npm install`
Expected: postinstall 执行 electron-rebuild，better-sqlite3 编译成功，无报错。

Run: `npm start`
Expected: 弹出一个 760x500 窗口显示 "Clipboard Drawer"。按 Cmd+Q 退出。

- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json .gitignore src/main/index.js
git commit -m "chore: Electron 项目脚手架"
```

---

## Task 2: 日期工具 dates.js（TDD）

**Files:**
- Test: `tests/dates.test.js`
- Create: `src/main/dates.js`

- [ ] **Step 1: 写失败测试 tests/dates.test.js**

```js
const test = require('node:test');
const assert = require('node:assert');
const { toDateKey, dayRange, getLast7Days, formatLabel } = require('../src/main/dates');

test('toDateKey 返回本地日期 YYYY-MM-DD', () => {
  const ts = new Date(2026, 9, 8, 15, 4, 5).getTime();
  assert.strictEqual(toDateKey(ts), '2026-10-08');
});

test('dayRange 覆盖当天本地零点至次日零点', () => {
  const [start, end] = dayRange('2026-10-08');
  assert.strictEqual(new Date(start).getHours(), 0);
  assert.strictEqual(new Date(start).getMinutes(), 0);
  assert.strictEqual(new Date(start).getDate(), 8);
  assert.strictEqual(new Date(end).getDate(), 9);
});

test('getLast7Days 今天排第一，共 7 天', () => {
  const now = new Date(2026, 9, 8, 12, 0, 0).getTime();
  const days = getLast7Days(now);
  assert.strictEqual(days.length, 7);
  assert.strictEqual(days[0], '2026-10-08');
  assert.strictEqual(days[6], '2026-10-02');
});

test('formatLabel: 今天 / 昨天 / 周几+日期', () => {
  const today = '2026-10-08'; // 2026-10-08 是周四
  assert.strictEqual(formatLabel('2026-10-08', today), '今天');
  assert.strictEqual(formatLabel('2026-10-07', today), '昨天');
  assert.strictEqual(formatLabel('2026-10-06', today), '周二 10/6');
  assert.strictEqual(formatLabel('2026-10-04', today), '周日 10/4');
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npm test`
Expected: FAIL，`Cannot find module '../src/main/dates'`。

- [ ] **Step 3: 实现 src/main/dates.js**

```js
const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

function pad(n) {
  return String(n).padStart(2, '0');
}

// 本地日期 → 'YYYY-MM-DD'
function toDateKey(ts = Date.now()) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function parseDateKey(dateKey) {
  const [y, m, d] = dateKey.split('-').map(Number);
  return { y, m, d };
}

// 某 dateKey 对应的本地时间半开区间 [start, end)
function dayRange(dateKey) {
  const { y, m, d } = parseDateKey(dateKey);
  return [new Date(y, m - 1, d).getTime(), new Date(y, m - 1, d + 1).getTime()];
}

// 最近 7 天的 dateKey，[今天, 昨天, ..., 6天前]
function getLast7Days(now = Date.now()) {
  const today = new Date(now);
  const days = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(today.getFullYear(), today.getMonth(), today.getDate() - i);
    days.push(toDateKey(d.getTime()));
  }
  return days;
}

// 抽屉标签：今天 / 昨天 / 周几 M/D
function formatLabel(dateKey, todayKey = toDateKey()) {
  if (dateKey === todayKey) return '今天';
  const today = parseDateKey(todayKey);
  const yesterdayKey = toDateKey(new Date(today.y, today.m - 1, today.d - 1).getTime());
  if (dateKey === yesterdayKey) return '昨天';
  const { y, m, d } = parseDateKey(dateKey);
  const wd = WEEKDAYS[new Date(y, m - 1, d).getDay()];
  return `${wd} ${m}/${d}`;
}

module.exports = { toDateKey, dayRange, getLast7Days, formatLabel };
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npm test`
Expected: PASS，`pass 4` 或类似输出（dates 测试全绿）。

- [ ] **Step 5: Commit**

```bash
git add tests/dates.test.js src/main/dates.js
git commit -m "feat: 日期工具模块（toDateKey/dayRange/getLast7Days/formatLabel）"
```

---

## Task 3: 数据层 store.js（TDD）

**Files:**
- Test: `tests/store.test.js`
- Create: `src/main/store.js`

- [ ] **Step 1: 写失败测试 tests/store.test.js**

```js
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
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npm test`
Expected: FAIL，`Cannot find module '../src/main/store'`。

- [ ] **Step 3: 实现 src/main/store.js**

```js
const fs = require('node:fs');
const Database = require('better-sqlite3');
const { toDateKey, dayRange } = require('./dates');

class ClipStore {
  constructor(dbPath = ':memory:') {
    this.db = new Database(dbPath);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS clips (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        text TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_created_at ON clips(created_at);
    `);
    this.insertStmt = this.db.prepare('INSERT INTO clips (text, created_at) VALUES (?, ?)');
    this.existsStmt = this.db.prepare(
      'SELECT id FROM clips WHERE text = ? AND created_at >= ? AND created_at < ?'
    );
    this.listByDayStmt = this.db.prepare(
      'SELECT id, text, created_at FROM clips WHERE created_at >= ? AND created_at < ? ORDER BY created_at DESC'
    );
    this.searchStmt = this.db.prepare(
      "SELECT id, text, created_at FROM clips WHERE text LIKE ? ESCAPE '\\' ORDER BY created_at DESC"
    );
    this.getStmt = this.db.prepare('SELECT id, text, created_at FROM clips WHERE id = ?');
    this.deleteStmt = this.db.prepare('DELETE FROM clips WHERE id = ?');
    this.clearDayStmt = this.db.prepare('DELETE FROM clips WHERE created_at >= ? AND created_at < ?');
    this.countByDayStmt = this.db.prepare(
      'SELECT COUNT(*) AS n FROM clips WHERE created_at >= ? AND created_at < ?'
    );
  }

  // 返回 lastInsertRowid；空白文本或当天重复时返回 null
  insert(text, now = Date.now()) {
    const trimmed = String(text).trim();
    if (!trimmed) return null;
    const [start, end] = dayRange(toDateKey(now));
    if (this.existsStmt.get(trimmed, start, end)) return null;
    return this.insertStmt.run(trimmed, now).lastInsertRowid;
  }

  listByDay(dateKey) {
    const [start, end] = dayRange(dateKey);
    return this.listByDayStmt.all(start, end);
  }

  // 跨全部历史搜索，LIKE 通配符（%, _）按字面匹配
  search(keyword) {
    const escaped = String(keyword).replace(/[\\%_]/g, (ch) => '\\' + ch);
    return this.searchStmt.all(`%${escaped}%`);
  }

  get(id) {
    return this.getStmt.get(id);
  }

  delete(id) {
    this.deleteStmt.run(id);
  }

  clearDay(dateKey) {
    const [start, end] = dayRange(dateKey);
    this.clearDayStmt.run(start, end);
  }

  countByDay(dateKey) {
    const [start, end] = dayRange(dateKey);
    return this.countByDayStmt.get(start, end).n;
  }
}

// 打开磁盘数据库；文件损坏时备份为 .bak 并重建
function openStore(dbPath) {
  try {
    const store = new ClipStore(dbPath);
    store.db.prepare('SELECT COUNT(*) FROM clips').get(); // 触发损坏检测
    return store;
  } catch (err) {
    if (dbPath !== ':memory:' && fs.existsSync(dbPath)) {
      fs.renameSync(dbPath, dbPath + '.bak');
      return new ClipStore(dbPath);
    }
    throw err;
  }
}

module.exports = { ClipStore, openStore };
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npm test`
Expected: PASS，全部 store + dates 测试通过。

- [ ] **Step 5: Commit**

```bash
git add tests/store.test.js src/main/store.js
git commit -m "feat: SQLite 数据层（插入去重/按天查询/搜索/删除/清空/损坏恢复）"
```

---

## Task 4: 剪贴板监听 watcher.js（TDD）

**Files:**
- Test: `tests/watcher.test.js`
- Create: `src/main/watcher.js`

- [ ] **Step 1: 写失败测试 tests/watcher.test.js**

```js
const test = require('node:test');
const assert = require('node:assert');
const { ClipboardWatcher } = require('../src/main/watcher');

function makeWatcher(readText) {
  const got = [];
  const w = new ClipboardWatcher({ readText, onClip: (t) => got.push(t), intervalMs: 10 });
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

test('readText 抛错时静默跳过，下次恢复', () => {
  let fail = true;
  const { w, got } = makeWatcher(() => {
    if (fail) throw new Error('clipboard unavailable');
    return 'ok';
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
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npm test`
Expected: FAIL，`Cannot find module '../src/main/watcher'`。

- [ ] **Step 3: 实现 src/main/watcher.js**

```js
// 轮询系统剪贴板，文本变化时回调 onClip。
// readText/onClip 由注入，便于测试；主进程注入 electron 的 clipboard.readText。
class ClipboardWatcher {
  constructor({ readText, onClip, intervalMs = 500 }) {
    if (typeof readText !== 'function' || typeof onClip !== 'function') {
      throw new Error('ClipboardWatcher 需要 readText 和 onClip 函数');
    }
    this.readText = readText;
    this.onClip = onClip;
    this.intervalMs = intervalMs;
    this.lastText = null;
    this.timer = null;
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => this.check(), this.intervalMs);
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  check() {
    let text;
    try {
      text = this.readText();
    } catch {
      return; // 读取失败静默跳过本次
    }
    if (!text || !text.trim()) return;
    if (text !== this.lastText) {
      this.lastText = text;
      this.onClip(text);
    }
  }
}

module.exports = { ClipboardWatcher };
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npm test`
Expected: PASS，全部 14 个测试左右通过。

- [ ] **Step 5: Commit**

```bash
git add tests/watcher.test.js src/main/watcher.js
git commit -m "feat: 剪贴板轮询监听（变化检测/空白过滤/错误容忍）"
```

---

## Task 5: IPC 层（ipc.js + preload.js）

**Files:**
- Create: `src/main/ipc.js`
- Create: `src/preload.js`

- [ ] **Step 1: 创建 src/main/ipc.js**

```js
const { ipcMain, clipboard } = require('electron');
const { getLast7Days, formatLabel } = require('./dates');

// 注册所有 IPC handler。deps: { store, getWindow }
function registerIpc({ store, getWindow }) {
  // 最近 7 天抽屉元数据：[{ dateKey, label, count }]
  ipcMain.handle('clipboard:listDays', () =>
    getLast7Days().map((dateKey) => ({
      dateKey,
      label: formatLabel(dateKey),
      count: store.countByDay(dateKey),
    }))
  );

  ipcMain.handle('clipboard:listByDay', (_event, dateKey) => store.listByDay(dateKey));

  // 跨全部历史搜索
  ipcMain.handle('clipboard:search', (_event, keyword) => store.search(keyword));

  ipcMain.handle('clipboard:delete', (_event, id) => {
    store.delete(id);
    return true;
  });

  ipcMain.handle('clipboard:clearDay', (_event, dateKey) => {
    store.clearDay(dateKey);
    return true;
  });

  // 复制回剪贴板并隐藏窗口
  ipcMain.handle('clipboard:copy', (_event, id) => {
    const row = store.get(id);
    if (!row) return false;
    clipboard.writeText(row.text);
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

- [ ] **Step 2: 创建 src/preload.js**

```js
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  listDays: () => ipcRenderer.invoke('clipboard:listDays'),
  listByDay: (dateKey) => ipcRenderer.invoke('clipboard:listByDay', dateKey),
  search: (keyword) => ipcRenderer.invoke('clipboard:search', keyword),
  deleteClip: (id) => ipcRenderer.invoke('clipboard:delete', id),
  clearDay: (dateKey) => ipcRenderer.invoke('clipboard:clearDay', dateKey),
  copyClip: (id) => ipcRenderer.invoke('clipboard:copy', id),
  hideWindow: () => ipcRenderer.invoke('window:hide'),
  onWindowShown: (callback) => ipcRenderer.on('window-shown', callback),
});
```

- [ ] **Step 3: 语法检查 + 回归测试**

Run: `node --check src/main/ipc.js && node --check src/preload.js && npm test`
Expected: 无语法错误，全部测试仍通过（IPC 层无独立单测，集成验证在 Task 7 手动完成）。

- [ ] **Step 4: Commit**

```bash
git add src/main/ipc.js src/preload.js
git commit -m "feat: IPC 层与 preload 桥接（listDays/listByDay/search/delete/clearDay/copy/hide）"
```

---

## Task 6: 渲染进程 UI

**Files:**
- Create: `src/renderer/index.html`
- Create: `src/renderer/styles.css`
- Create: `src/renderer/app.js`

- [ ] **Step 1: 创建 src/renderer/index.html**

```html
<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'self'; style-src 'self' 'unsafe-inline'">
  <title>剪贴板抽屉柜</title>
  <link rel="stylesheet" href="styles.css">
</head>
<body>
  <div id="app">
    <aside id="sidebar">
      <input id="search" type="text" placeholder="搜索剪贴历史…">
      <nav id="drawers"></nav>
      <button id="clear-day">清空当天</button>
    </aside>
    <main id="content">
      <header id="content-title"></header>
      <div id="items"></div>
    </main>
  </div>
  <script src="app.js"></script>
</body>
</html>
```

- [ ] **Step 2: 创建 src/renderer/styles.css**

```css
:root {
  color-scheme: light dark;
  --bg: #ffffff;
  --bg-side: #f5f5f7;
  --border: #e0e0e3;
  --text: #1d1d1f;
  --text-dim: #8e8e93;
  --hover: #eaeaee;
  --active-bg: #d9e7ff;
  --accent: #0a66d8;
  --danger: #d33;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #1e1e20;
    --bg-side: #262628;
    --border: #3a3a3e;
    --text: #e8e8ea;
    --text-dim: #8e8e93;
    --hover: #333336;
    --active-bg: #2c4a75;
    --accent: #5b9dff;
    --danger: #ff6b6b;
  }
}
* { box-sizing: border-box; margin: 0; padding: 0; }
html, body { height: 100%; }
body {
  font-family: -apple-system, BlinkMacSystemFont, "PingFang SC", "Segoe UI", sans-serif;
  font-size: 13px;
  color: var(--text);
  background: var(--bg);
  overflow: hidden;
}
#app { display: flex; height: 100vh; }

/* 左侧抽屉栏 */
#sidebar {
  width: 190px;
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  background: var(--bg-side);
  border-right: 1px solid var(--border);
}
#search {
  margin: 10px;
  padding: 6px 10px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--bg);
  color: var(--text);
  outline: none;
}
#search:focus { border-color: var(--accent); }
#drawers { flex: 1; overflow-y: auto; padding: 0 8px; }
.drawer {
  display: flex;
  justify-content: space-between;
  align-items: center;
  width: 100%;
  padding: 9px 12px;
  margin-bottom: 4px;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: var(--text);
  cursor: pointer;
  text-align: left;
  font-size: 13px;
}
.drawer:hover { background: var(--hover); }
.drawer.active { background: var(--active-bg); font-weight: 600; }
.drawer-count { color: var(--text-dim); font-size: 12px; }
#clear-day {
  margin: 8px;
  padding: 7px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: transparent;
  color: var(--text-dim);
  cursor: pointer;
}
#clear-day:hover { color: var(--danger); border-color: var(--danger); }

/* 右侧内容区 */
#content { flex: 1; display: flex; flex-direction: column; min-width: 0; }
#content-title {
  padding: 12px 16px;
  font-weight: 600;
  border-bottom: 1px solid var(--border);
}
#items { flex: 1; overflow-y: auto; padding: 8px 0; }
.item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 16px;
}
.item:hover { background: var(--hover); }
.item-time {
  color: var(--text-dim);
  font-size: 12px;
  flex-shrink: 0;
  font-variant-numeric: tabular-nums;
}
.item-text {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  cursor: pointer;
}
.item-delete {
  border: none;
  background: transparent;
  color: var(--text-dim);
  font-size: 16px;
  cursor: pointer;
  visibility: hidden;
  flex-shrink: 0;
}
.item:hover .item-delete { visibility: visible; }
.item-delete:hover { color: var(--danger); }
.search-group {
  padding: 10px 16px 4px;
  font-weight: 600;
  color: var(--text-dim);
  font-size: 12px;
}
.empty { padding: 40px 16px; text-align: center; color: var(--text-dim); }
```

- [ ] **Step 3: 创建 src/renderer/app.js**

```js
const state = { days: [], selected: null, keyword: '' };

const drawersEl = document.getElementById('drawers');
const itemsEl = document.getElementById('items');
const titleEl = document.getElementById('content-title');
const searchEl = document.getElementById('search');
const clearBtn = document.getElementById('clear-day');

function toDateKey(ts) {
  const d = new Date(ts);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function formatTime(ts) {
  const d = new Date(ts);
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function truncate(text, max = 80) {
  return text.length > max ? text.slice(0, max) + '…' : text;
}

// 7 天外日期的搜索分组回退为 dateKey 本身
function labelFor(dateKey) {
  const found = state.days.find((d) => d.dateKey === dateKey);
  return found ? found.label : dateKey;
}

function renderDrawers() {
  drawersEl.innerHTML = '';
  for (const day of state.days) {
    const btn = document.createElement('button');
    btn.className = 'drawer' + (state.selected === day.dateKey && !state.keyword ? ' active' : '');
    const label = document.createElement('span');
    label.className = 'drawer-label';
    label.textContent = day.label;
    const count = document.createElement('span');
    count.className = 'drawer-count';
    count.textContent = day.count;
    btn.append(label, count);
    btn.addEventListener('click', () => selectDay(day.dateKey));
    drawersEl.appendChild(btn);
  }
}

async function refreshDays() {
  state.days = await window.api.listDays();
  renderDrawers();
}

async function selectDay(dateKey) {
  state.selected = dateKey;
  state.keyword = '';
  searchEl.value = '';
  renderDrawers();
  const items = await window.api.listByDay(dateKey);
  titleEl.textContent = `${labelFor(dateKey)} · ${items.length} 条`;
  renderItems(items);
}

function renderItems(items) {
  itemsEl.innerHTML = '';
  if (!items.length) {
    itemsEl.innerHTML = '<div class="empty">暂无剪贴记录</div>';
    return;
  }
  for (const item of items) itemsEl.appendChild(itemRow(item));
}

function itemRow(item) {
  const row = document.createElement('div');
  row.className = 'item';

  const time = document.createElement('span');
  time.className = 'item-time';
  time.textContent = formatTime(item.created_at);

  const preview = document.createElement('span');
  preview.className = 'item-text';
  preview.textContent = truncate(item.text);
  preview.title = item.text;
  preview.addEventListener('click', () => window.api.copyClip(item.id));

  const del = document.createElement('button');
  del.className = 'item-delete';
  del.textContent = '×';
  del.title = '删除该条';
  del.addEventListener('click', async (e) => {
    e.stopPropagation();
    await window.api.deleteClip(item.id);
    refreshAfterMutation();
  });

  row.append(time, preview, del);
  return row;
}

async function refreshAfterMutation() {
  if (state.keyword) {
    await doSearch();
  } else if (state.selected) {
    await refreshDays();
    selectDay(state.selected);
  }
}

async function doSearch() {
  renderDrawers();
  const rows = await window.api.search(state.keyword);
  titleEl.textContent = `搜索“${state.keyword}” · ${rows.length} 条`;
  itemsEl.innerHTML = '';
  if (!rows.length) {
    itemsEl.innerHTML = '<div class="empty">没有匹配的记录</div>';
    return;
  }
  const groups = new Map();
  for (const r of rows) {
    const key = toDateKey(r.created_at);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }
  for (const [key, group] of groups) {
    const h = document.createElement('div');
    h.className = 'search-group';
    h.textContent = `${labelFor(key)} · ${group.length} 条`;
    itemsEl.appendChild(h);
    for (const item of group) itemsEl.appendChild(itemRow(item));
  }
}

searchEl.addEventListener('input', () => {
  state.keyword = searchEl.value.trim();
  if (state.keyword) doSearch();
  else if (state.selected) selectDay(state.selected);
});

clearBtn.addEventListener('click', async () => {
  if (!state.selected || state.keyword) return;
  await window.api.clearDay(state.selected);
  await refreshDays();
  selectDay(state.selected);
});

window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') window.api.hideWindow();
});

// 窗口每次显示时重置到"今天"并聚焦搜索框
window.api.onWindowShown(() => {
  searchEl.value = '';
  state.keyword = '';
  refreshDays().then(() => {
    if (state.days.length) selectDay(state.days[0].dateKey);
  });
  searchEl.focus();
});

refreshDays().then(() => {
  if (state.days.length) selectDay(state.days[0].dateKey);
});
```

- [ ] **Step 4: 语法检查**

Run: `node --check src/renderer/app.js`
Expected: 无错误。

- [ ] **Step 5: Commit**

```bash
git add src/renderer/
git commit -m "feat: 抽屉柜渲染 UI（抽屉列表/条目/搜索分组/深浅色主题）"
```

---

## Task 7: 主进程完整版 + 托盘图标

**Files:**
- Create: `assets/trayTemplate.png`
- Modify: `src/main/index.js`（整体替换 Task 1 占位版）

- [ ] **Step 1: 写入托盘图标（base64 解码，16x16 模板图）**

Run:

```bash
mkdir -p assets && node -e "require('node:fs').writeFileSync('assets/trayTemplate.png', Buffer.from('iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAIUlEQVR4nGNgYGD4TyEeNeA/hYByAwY+DAbegNFYoNwAAPoYvlAo1u3QAAAAAElFTkSuQmCC', 'base64'))"
```

Expected: 生成 `assets/trayTemplate.png`（可用 `file assets/trayTemplate.png` 验证为 16x16 PNG）。

- [ ] **Step 2: 整体替换 src/main/index.js**

```js
const path = require('node:path');
const {
  app, BrowserWindow, Tray, Menu, globalShortcut, nativeImage, clipboard, screen,
} = require('electron');
const { openStore } = require('./store');
const { ClipboardWatcher } = require('./watcher');
const { registerIpc } = require('./ipc');

let win = null;
let tray = null;
let store = null;
let watcher = null;

function createWindow() {
  win = new BrowserWindow({
    width: 760,
    height: 500,
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  // 首次加载完成后由主进程通知渲染进程刷新并聚焦
  win.webContents.on('did-finish-load', () => {
    win.webContents.send('window-shown');
  });
  // 失去焦点自动隐藏（devtools 打开时除外，便于调试）
  win.on('blur', () => {
    if (win && !win.webContents.isDevToolsOpened()) win.hide();
  });
  win.on('closed', () => {
    win = null;
  });
}

function showWindow() {
  if (!win) createWindow();
  const cursor = screen.getCursorScreenPoint();
  const display = screen.getDisplayNearestPoint(cursor);
  const bounds = win.getBounds();
  const x = Math.round(display.bounds.x + (display.bounds.width - bounds.width) / 2);
  const y = Math.round(display.bounds.y + (display.bounds.height - bounds.height) / 3);
  win.setBounds({ x, y, width: bounds.width, height: bounds.height });
  win.show();
  win.focus();
  win.webContents.send('window-shown');
}

function createTray() {
  const iconPath = path.join(__dirname, '..', '..', 'assets', 'trayTemplate.png');
  const icon = nativeImage.createFromPath(iconPath);
  if (process.platform === 'darwin') icon.setTemplateImage(true);
  tray = new Tray(icon.isEmpty() ? nativeImage.createEmpty() : icon);
  tray.setToolTip('剪贴板抽屉柜');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '打开剪贴板抽屉柜', click: showWindow },
    { type: 'separator' },
    { label: '退出', click: () => app.quit() },
  ]));
  tray.on('click', showWindow);
}

app.whenReady().then(() => {
  const dbPath = path.join(app.getPath('userData'), 'clipboard.db');
  store = openStore(dbPath);

  registerIpc({ store, getWindow: () => win });

  watcher = new ClipboardWatcher({
    readText: () => clipboard.readText(),
    onClip: (text) => {
      try {
        store.insert(text);
      } catch (err) {
        console.error('剪贴板写入数据库失败:', err);
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

app.on('activate', () => {
  if (process.platform === 'darwin') showWindow();
});

// 关闭窗口不退出，托盘常驻
app.on('window-all-closed', (event) => {
  event.preventDefault();
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  if (watcher) watcher.stop();
});
```

- [ ] **Step 3: 手动集成验证**

Run: `npm start`

按顺序验证（每步记录结果）：
1. 应用启动后自动弹出抽屉柜窗口，左侧显示 7 个日期抽屉（今天/昨天/周几+日期），右侧默认选中"今天"。
2. 在任意应用（如浏览器地址栏）复制一段文本，等待 1 秒左右，窗口中"今天"抽屉计数 +1，右侧出现该条目。
3. 连续复制两次相同文本 → 计数只加一次（自动去重）。
4. 点击条目 → 窗口隐藏；在别处粘贴，内容正确。
5. 按 `Cmd/Ctrl+Shift+V` → 窗口在鼠标所在屏幕弹出并聚焦搜索框。
6. 在搜索框输入关键字 → 右侧按日期分组显示匹配结果（含 7 天前的历史，如有）。
7. 悬停条目出现 `×`，点击删除 → 列表刷新。
8. 点击"清空当天" → 当天条目清空，其他天不受影响。
9. 按 `Esc` 或点击窗口外区域 → 窗口隐藏；菜单栏/系统托盘出现抽屉图标，点击图标可再次打开；托盘菜单"退出"可退出应用。

- [ ] **Step 4: Commit**

```bash
git add assets/trayTemplate.png src/main/index.js
git commit -m "feat: 主进程完整版（托盘/全局快捷键/焦点隐藏/剪贴板监听接线）"
```

---

## Task 8: 打包与文档

**Files:**
- Create: `README.md`
- Modify: `package.json`（build 配置已在 Task 1 写入，本任务验证）

- [ ] **Step 1: 验证本机打包**

Run: `npm run pack`
Expected: `dist/` 下生成 mac 目录（如 `dist/mac-arm64/ClipboardDrawer.app`），无报错。

- [ ] **Step 2: 创建 README.md**

```markdown
# 剪贴板抽屉柜 (Clipboard Drawer)

跨平台（macOS / Windows / Linux）剪贴板历史工具。以"抽屉柜"形式展示剪贴板历史：左侧为最近 7 个日期的抽屉，点击抽屉右侧展示当天复制的所有文本。

## 功能

- 常驻系统托盘，按 `Cmd/Ctrl+Shift+V` 全局唤起
- 最近 7 天日期抽屉，显示每天条数
- 点击文本重新复制到剪贴板
- 跨全部历史搜索（不限 7 天），按日期分组
- 删除单条 / 清空当天；同一天相同文本自动去重
- 数据存于本地 SQLite（`userData/clipboard.db`），永久保留
- 深色/浅色跟随系统；失去焦点自动隐藏

## 开发

```bash
npm install        # 安装依赖（postinstall 自动重编译 better-sqlite3）
npm test           # 运行单元测试（node:test）
npm start          # 启动应用
```

## 打包

```bash
npm run pack       # 免安装目录（dist/）
npm run dist       # 完整安装包（mac: dmg / win: nsis / linux: AppImage）
```
```

- [ ] **Step 3: 回归测试 + Commit**

Run: `npm test`
Expected: 全部测试通过。

```bash
git add README.md package.json
git commit -m "docs: README 与打包验证"
```

---

## 自检记录

- **Spec 覆盖**：架构（T1/T5/T7）、SQLite 存储+去重+损坏恢复（T3）、7 天抽屉 UI/搜索/删除/复制/清空（T5/T6）、托盘+快捷键+焦点隐藏+Esc（T7）、去重监听（T4）、截断显示（app.js `truncate`）、深浅色（styles.css）、打包（T8）。全部有对应任务。
- **类型一致性**：`store` 方法名（insert/listByDay/search/get/delete/clearDay/countByDay）在 T3 定义，T5 IPC 与计划内引用一致；preload `window.api` 方法名与 app.js 调用逐一核对一致；IPC channel 名两端一致。
- **无占位符**：所有代码步骤含完整代码与命令。
