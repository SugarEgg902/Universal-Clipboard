# 剪贴板抽屉柜 v3：片段库 + 隐私安全区 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 历史条目可 Pin 成片段（触发词+分组），`Cmd/Ctrl+Shift+;` 唤起快速粘贴面板一键粘贴；启发式识别疑似密码，可配置"记录但打码（默认）/完全不记录"。

**Architecture:** 数据层在 clips 表加 pinned/trigger_word/group_name 三列（沿用 PRAGMA 迁移）；新纯函数模块 secretDetector（熵+字符类启发式）与 privacyConfig（config.json 持久化托盘单选）；新模块 palette（迷你窗口）与 paster（平台粘贴适配，macOS AppleScript 先行）；渲染层加片段抽屉视图/Pin 表单/打码渲染/面板模式（同一 index.html 以 `?palette=1` 区分）。

**Tech Stack:** Electron 33、better-sqlite3、node:test（`npm test` = `cross-env ELECTRON_RUN_AS_NODE=1 electron --test tests/`，**禁止** plain `node --test`，better-sqlite3 是 Electron ABI）。

**当前基线：** main @ a9e85a5，33/33 测试通过。

---

## 背景：执行者需要知道的现有结构

- `src/main/store.js` — `ClipStore`（构造 `(dbPath=':memory:', imagesDir=null)`），`migrate()` 用 `PRAGMA table_info(clips)` 检测缺列再 ALTER（v2 加过 type/image_path/width/height，本次照抄模式加三列）。所有查询语句是构造器里的 prepared statements。
- `src/main/ipc.js` — `registerIpc({ store, getWindow, imagesDir })`，`withThumb(row)` 给图片行加 `thumb`。渲染进程经 `src/preload.js` 的 `window.api.*` 调用。
- `src/main/index.js` — 托盘（含"开机自启"checkbox 模式可参照）、watcher 接线（`onClip` 里 `store.insert`）、`showWindow()` 定位到鼠标所在屏幕、失焦隐藏（devtools 打开时除外）、`'window-shown'` 事件经 `webContents.send` 通知渲染层刷新。
- `src/renderer/app.js` — 纯原生 JS。`state = { days, selected, keyword, items, selectedIndex }`；`itemRow(item)` 分行类型渲染；`updateSelectionHighlight()` 用 `itemsEl.querySelectorAll('.item')` 按 `state.items` 索引对齐（分组标题 `.search-group` 不计入）；快捷键处理器在文件尾部。
- 渲染层无自动化测试（前两轮既定惯例），渲染任务的门是 `node --check src/renderer/app.js` + 全量 `npm test` 保持 33/33。
- `trigger` 是 SQLite 关键字，**列名用 `trigger_word`**。

---

## Task 1: secretDetector（隐私检测器纯函数）

**Files:**
- Create: `src/main/secretDetector.js`
- Test: `tests/secretDetector.test.js`

- [ ] **Step 1: 写失败测试**

Create `tests/secretDetector.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert');
const { looksLikeSecret } = require('../src/main/secretDetector');

test('典型随机密码判定为疑似密码', () => {
  assert.strictEqual(looksLikeSecret('Xy9#kQ2$vL8mP4!z'), true);
  assert.strictEqual(looksLikeSecret('aB3$dE7%fH2*jK9!mN'), true);
});

test('长度不足 16 不判定', () => {
  assert.strictEqual(looksLikeSecret('Xy9#kQ2$vL8mP4'), false); // 14 字符
});

test('无空格/换行要求：含空白即不判定', () => {
  assert.strictEqual(looksLikeSecret('hello world foo bar 123!'), false);
  assert.strictEqual(looksLikeSecret('Xy9#kQ2$vL8mP4!z\n'), false);
});

test('URL 排除', () => {
  assert.strictEqual(looksLikeSecret('https://example.com/very/long/path?a=b&c=d'), false);
});

test('文件路径排除', () => {
  assert.strictEqual(looksLikeSecret('/usr/local/bin/some-very-long-tool-name'), false);
  assert.strictEqual(looksLikeSecret('C:\\Program Files\\Some Very Long App Name'), false);
});

test('纯数字长串排除（订单号等）', () => {
  assert.strictEqual(looksLikeSecret('12345678901234567890'), false);
});

test('字符类不足 3 类不判定', () => {
  assert.strictEqual(looksLikeSecret('abcdefghijklmnop'), false); // 仅小写
  assert.strictEqual(looksLikeSecret('ABCDEFGHIJKLMNOP'), false); // 仅大写
  assert.strictEqual(looksLikeSecret('abc123def456ghi789'), false); // 小写+数字两类
});

test('低熵重复模式不判定（同 3 类但可预测）', () => {
  assert.strictEqual(looksLikeSecret('abababababababab1!'), false);
  assert.strictEqual(looksLikeSecret('aaaaaaaaaaaaaaaA1!'), false);
});

test('高熵 3 类以上无空白字符串判定为疑似密码', () => {
  assert.strictEqual(looksLikeSecret('kX9#pQ2$mV7nL4@zR'), true);
});

test('普通中文文本/英文句子不判定', () => {
  assert.strictEqual(looksLikeSecret('这是一段普通的中文文本内容用于测试检测器的误报率'), false);
  assert.strictEqual(looksLikeSecret('the quick brown fox jumps over the lazy dog'), false);
});

test('Shannon 熵边界：aaa…（低熵）与混合串（高熵）', () => {
  assert.strictEqual(looksLikeSecret('aaaaaaaaaaaaaaaa1!'), false);
  assert.strictEqual(looksLikeSecret('aZ1!bY2@cX3#dW4$eV'), true);
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npx cross-env ELECTRON_RUN_AS_NODE=1 node_modules/.bin/electron --test tests/secretDetector.test.js`
Expected: FAIL（`Cannot find module '../src/main/secretDetector'`）

- [ ] **Step 3: 实现**

Create `src/main/secretDetector.js`:

```js
// 疑似密码启发式检测：长度 + 字符类 + 熵 + 排除规则（URL/路径/纯数字/含空白）。
// 纯函数，无副作用，供主进程入库拦截与读取侧打码共用。

const MIN_LEN = 16;
const MIN_CLASSES = 3;
const MIN_ENTROPY = 3.5; // bit/char

function charClasses(s) {
  let n = 0;
  if (/[a-z]/.test(s)) n++;
  if (/[A-Z]/.test(s)) n++;
  if (/[0-9]/.test(s)) n++;
  if (/[^a-zA-Z0-9]/.test(s)) n++;
  return n;
}

function shannonEntropy(s) {
  const counts = new Map();
  for (const ch of s) counts.set(ch, (counts.get(ch) || 0) + 1);
  let h = 0;
  for (const c of counts.values()) {
    const p = c / s.length;
    h -= p * Math.log2(p);
  }
  return h;
}

function looksLikeSecret(text) {
  const s = String(text).trim();
  if (s.length < MIN_LEN) return false;
  if (/\s/.test(s)) return false;            // 密码一般无空白；句子/多行直接排除
  if (s.includes('://')) return false;       // URL
  if (s.startsWith('/')) return false;       // Unix 路径
  if (/^[A-Za-z]:[\\/]/.test(s)) return false; // Windows 路径
  if (/^\d+$/.test(s)) return false;         // 纯数字（订单号/卡号段）
  if (charClasses(s) < MIN_CLASSES) return false;
  if (shannonEntropy(s) < MIN_ENTROPY) return false;
  return true;
}

module.exports = { looksLikeSecret };
```

- [ ] **Step 4: 运行确认通过**

Run: `npx cross-env ELECTRON_RUN_AS_NODE=1 node_modules/.bin/electron --test tests/secretDetector.test.js`
Expected: 11/11 pass。

注意：若 `'Xy9#kQ2$vL8mP4!z'`（15 字符）被判 false 是因为长度——它本来就 <16，测试里"典型密码"用例已换成 16 字符版本；若其他样例因熵边界翻转，调整测试样例字符串（不要放宽阈值）。

- [ ] **Step 5: Commit**

```bash
git add src/main/secretDetector.js tests/secretDetector.test.js
git commit -m "feat: 疑似密码启发式检测器（长度/字符类/熵/排除规则）"
```

---

## Task 2: store 片段字段与 API

**Files:**
- Modify: `src/main/store.js`
- Test: `tests/snippet.test.js`

- [ ] **Step 1: 写失败测试**

Create `tests/snippet.test.js`:

```js
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
  const plain = s.insert('not pinned', at(2026, 10, 9, 12));
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
```

- [ ] **Step 2: 运行确认失败**

Run: `npx cross-env ELECTRON_RUN_AS_NODE=1 node_modules/.bin/electron --test tests/snippet.test.js`
Expected: FAIL（`s.pin is not a function`）

- [ ] **Step 3: 实现 store.js 修改**

3a. `migrate()` 里追加三列检测（在现有 height 块之后）：

```js
    if (!cols.includes('pinned')) {
      this.db.exec('ALTER TABLE clips ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0');
    }
    if (!cols.includes('trigger_word')) {
      this.db.exec('ALTER TABLE clips ADD COLUMN trigger_word TEXT');
    }
    if (!cols.includes('group_name')) {
      this.db.exec('ALTER TABLE clips ADD COLUMN group_name TEXT');
    }
```

3b. 构造器的 prepared statements 追加（放在 `dayImagesStmt` 之后）：

```js
    this.pinStmt = this.db.prepare(
      'UPDATE clips SET pinned = 1, trigger_word = ?, group_name = ? WHERE id = ?'
    );
    this.unpinStmt = this.db.prepare(
      'UPDATE clips SET pinned = 0, trigger_word = NULL, group_name = NULL WHERE id = ?'
    );
    this.triggerConflictStmt = this.db.prepare(
      'SELECT id FROM clips WHERE pinned = 1 AND trigger_word IS NOT NULL AND lower(trigger_word) = lower(?) AND id != ?'
    );
    this.listSnippetsStmt = this.db.prepare(
      'SELECT id, text, created_at, type, image_path, width, height, pinned, trigger_word, group_name FROM clips WHERE pinned = 1 ORDER BY created_at DESC'
    );
```

3c. 类方法追加（放在 `countByDay` 之后）：

```js
  // 触发词校验：空/null 合法（仅分组收藏）；否则 1-32 位字母数字连字符下划线
  normalizeTrigger(trigger) {
    if (trigger === null || trigger === undefined) return null;
    const t = String(trigger).trim();
    if (!t) return null;
    if (!/^[\w-]{1,32}$/.test(t)) throw new Error('触发词仅允许字母、数字、连字符、下划线（1-32 位）');
    return t;
  }

  // Pin 即 upsert：已 Pin 条目再调用 = 修改触发词/分组
  pin(id, trigger, groupName) {
    const row = this.getStmt.get(id);
    if (!row) throw new Error('条目不存在');
    const t = this.normalizeTrigger(trigger);
    if (t && this.triggerConflictStmt.get(t, id)) throw new Error('触发词已被占用');
    const g = groupName ? String(groupName).trim() : null;
    this.pinStmt.run(t, g || null, id);
    return true;
  }

  unpin(id) {
    this.unpinStmt.run(id);
    return true;
  }

  // 所有片段按分组返回：[{ name, items }]，null 组名归为"未分组"，组内 created_at 倒序
  listSnippets() {
    const rows = this.listSnippetsStmt.all();
    const byGroup = new Map();
    for (const r of rows) {
      const key = r.group_name || '未分组';
      if (!byGroup.has(key)) byGroup.set(key, []);
      byGroup.get(key).push(r);
    }
    return Array.from(byGroup, ([name, items]) => ({ name, items }));
  }
```

注意：现有 `listByDayStmt`/`searchStmt`/`getStmt` 的 SELECT 列**不加**新三列——v2 渲染层不受影响；片段视图走 `listSnippetsStmt`/`getStmt`（getStmt 返回全列？查看现有 `getStmt` 只选 7 列——把 `getStmt` 改为选全部 10 列，因为 copy/delete 逻辑不依赖列集合，多返回无害）：

```js
    this.getStmt = this.db.prepare(
      'SELECT id, text, created_at, type, image_path, width, height, pinned, trigger_word, group_name FROM clips WHERE id = ?'
    );
```

- [ ] **Step 4: 运行确认通过**

Run: `npm test`
Expected: 44 + 7 = 51/51 pass（既有 44 个不受影响）。

- [ ] **Step 5: Commit**

```bash
git add src/main/store.js tests/snippet.test.js
git commit -m "feat: 片段数据层（pinned/trigger_word/group_name 迁移 + pin/unpin/listSnippets）"
```

---

## Task 3: privacyConfig + 主进程接线（托盘菜单 + 入库拦截）

**Files:**
- Create: `src/main/privacyConfig.js`
- Modify: `src/main/index.js`
- Test: `tests/privacyConfig.test.js`

- [ ] **Step 1: 写失败测试**

Create `tests/privacyConfig.test.js`:

```js
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
```

- [ ] **Step 2: 运行确认失败**

Run: `npx cross-env ELECTRON_RUN_AS_NODE=1 node_modules/.bin/electron --test tests/privacyConfig.test.js`
Expected: FAIL（Cannot find module）

- [ ] **Step 3: 实现 privacyConfig.js**

Create `src/main/privacyConfig.js`:

```js
// 隐私模式配置：userData/config.json 持久化，内存缓存，托盘菜单单选切换。
// mask（默认）：记录但打码；skip：完全不记录。

const fs = require('node:fs');
const path = require('node:path');

let configPath = null;
let mode = 'mask';

function init(userDataDir) {
  configPath = path.join(userDataDir, 'config.json');
  try {
    const saved = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    if (saved.privacyMode === 'mask' || saved.privacyMode === 'skip') mode = saved.privacyMode;
    else mode = 'mask';
  } catch {
    mode = 'mask'; // 文件不存在或损坏都回退默认
  }
}

function getMode() {
  return mode;
}

function setMode(next) {
  if (next !== 'mask' && next !== 'skip') return;
  mode = next;
  if (!configPath) return;
  try {
    fs.writeFileSync(configPath, JSON.stringify({ privacyMode: mode }, null, 2));
  } catch (err) {
    console.error('隐私配置保存失败:', err);
  }
}

module.exports = { init, getMode, setMode };
```

- [ ] **Step 4: 测试通过 + Commit**

Run: `npx cross-env ELECTRON_RUN_AS_NODE=1 node_modules/.bin/electron --test tests/privacyConfig.test.js`
Expected: 3/3 pass。

```bash
git add src/main/privacyConfig.js tests/privacyConfig.test.js
git commit -m "feat: 隐私模式配置模块（mask/skip，config.json 持久化）"
```

- [ ] **Step 5: index.js 接线（拦截 + 托盘菜单）**

5a. 头部 require 追加：

```js
const { looksLikeSecret } = require('./secretDetector');
const privacyConfig = require('./privacyConfig');
```

5b. `app.whenReady().then(() => {` 内 `store = openStore(...)` 之后加：

```js
  privacyConfig.init(app.getPath('userData'));
```

5c. `onClip` 替换为：

```js
    onClip: (text) => {
      try {
        // 检测器本身不 trim（含空白即不判定是对多行内容的严格排除）；
        // 调用点 trim 以兜住"终端复制带尾换行的密码"这一常见形态。
        if (privacyConfig.getMode() === 'skip' && looksLikeSecret(String(text).trim())) {
          console.log('[隐私] 已跳过疑似密码内容（完全不记录模式）');
          return;
        }
        store.insert(text);
      } catch (err) {
        console.error('剪贴板写入数据库失败:', err);
      }
    },
```

> **执行期修正案（Task 1）**：计划原实现 `String(text).trim()` 与计划测试 `'…\n' → false` 矛盾（trim 先行会让尾换行逃过 `\s` 检查）。以测试为准：检测器不 trim（012cb93）；trim 责任移到调用点（本任务）。store 入库本就对 text trim，故读取侧打码与 skip 拦截判定一致。

5d. `createTray()` 的菜单模板，在"开机自启"项之后、`{ type: 'separator' }` 之前插入隐私模式子菜单：

```js
    {
      label: '隐私模式',
      submenu: [
        {
          label: '记录但打码',
          type: 'radio',
          checked: privacyConfig.getMode() === 'mask',
          click: () => privacyConfig.setMode('mask'),
        },
        {
          label: '完全不记录',
          type: 'radio',
          checked: privacyConfig.getMode() === 'skip',
          click: () => privacyConfig.setMode('skip'),
        },
      ],
    },
```

- [ ] **Step 6: 语法检查 + 回归**

Run: `node --check src/main/index.js && npm test`
Expected: 语法 OK；54/54 pass。

- [ ] **Step 7: Commit**

```bash
git add src/main/index.js
git commit -m "feat: 隐私模式主进程接线（托盘单选菜单 + skip 模式入库拦截）"
```

---

## Task 4: ipc 扩展 + preload（片段 handler + 打标 + 粘贴 handler）

**Files:**
- Modify: `src/main/ipc.js`
- Modify: `src/preload.js`
- Modify: `src/main/index.js`（registerIpc 调用点，本任务先传占位，Task 5 注入完整依赖）

> 说明：`clipboard:pasteSnippet` 依赖 Task 5 的 `paster` 与 `getPaletteWindow`。本任务把 handler 写好，`registerIpc` 的 deps 增加 `getPaletteWindow` 与 `paster`（允许为 undefined——本任务 index.js 先传 `getPaletteWindow: () => null, paster: null`，handler 内判空降级）。

- [ ] **Step 1: ipc.js 整体替换为**

```js
const path = require('node:path');
const { ipcMain, clipboard, nativeImage } = require('electron');
const { getLast7Days, formatLabel } = require('./dates');
const { looksLikeSecret } = require('./secretDetector');

// 图片条目附带缩略图协议地址；文本条目 thumb 为 null
function withThumb(row) {
  return row.type === 'image'
    ? { ...row, text: '', thumb: `clipimg://thumb/${row.id}` }
    : { ...row, thumb: null };
}

// 读取侧判定疑似密码（不移民数据，模式切换后历史行为即刻一致）
function withSecret(row) {
  return row.type === 'text' && looksLikeSecret(row.text)
    ? { ...row, secret: true }
    : { ...row, secret: false };
}

const withMeta = (row) => withSecret(withThumb(row));

// 注册所有 IPC handler。deps: { store, getWindow, imagesDir, getPaletteWindow, paster }
function registerIpc({ store, getWindow, imagesDir, getPaletteWindow, paster }) {
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
    store.listByDay(dateKey).map(withMeta)
  );

  // 跨全部历史搜索（仅文本条目）
  ipcMain.handle('clipboard:search', (_event, keyword) => store.search(keyword).map(withMeta));

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

  // ---- 片段库 ----

  // 分组片段列表：[{ name, items: [带 meta 的行] }]
  ipcMain.handle('clipboard:listSnippets', () =>
    store.listSnippets().map((g) => ({ name: g.name, items: g.items.map(withMeta) }))
  );

  // Pin（upsert）。触发词冲突/非法返回 { ok:false, error }，由渲染层内联展示
  ipcMain.handle('clipboard:pin', (_event, id, trigger, groupName) => {
    try {
      store.pin(id, trigger, groupName);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: String(err.message || err) };
    }
  });

  ipcMain.handle('clipboard:unpin', (_event, id) => {
    store.unpin(id);
    return { ok: true };
  });

  // 快速面板粘贴：写剪贴板 → 隐藏面板 → 模拟粘贴。
  // 粘贴失败时内容已在剪贴板，渲染层提示手动粘贴。
  ipcMain.handle('clipboard:pasteSnippet', async (_event, id) => {
    const row = store.get(id);
    if (!row || row.type !== 'text') return { ok: false, reason: 'not-found' };
    clipboard.writeText(row.text);
    const palette = getPaletteWindow && getPaletteWindow();
    if (palette) palette.hide();
    if (!paster) return { ok: false, reason: 'unsupported-platform' };
    return paster.paste();
  });

  ipcMain.handle('window:hide', () => {
    const win = getWindow();
    if (win) win.hide();
    const palette = getPaletteWindow && getPaletteWindow();
    if (palette) palette.hide();
  });
}

module.exports = { registerIpc };
```

- [ ] **Step 2: preload.js 整体替换为**

```js
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  listDays: () => ipcRenderer.invoke('clipboard:listDays'),
  listByDay: (dateKey) => ipcRenderer.invoke('clipboard:listByDay', dateKey),
  search: (keyword) => ipcRenderer.invoke('clipboard:search', keyword),
  deleteClip: (id) => ipcRenderer.invoke('clipboard:delete', id),
  clearDay: (dateKey) => ipcRenderer.invoke('clipboard:clearDay', dateKey),
  copyClip: (id) => ipcRenderer.invoke('clipboard:copy', id),
  listSnippets: () => ipcRenderer.invoke('clipboard:listSnippets'),
  pinClip: (id, trigger, groupName) => ipcRenderer.invoke('clipboard:pin', id, trigger, groupName),
  unpinClip: (id) => ipcRenderer.invoke('clipboard:unpin', id),
  pasteSnippet: (id) => ipcRenderer.invoke('clipboard:pasteSnippet', id),
  hideWindow: () => ipcRenderer.invoke('window:hide'),
  onWindowShown: (callback) => ipcRenderer.on('window-shown', () => callback()),
});
```

- [ ] **Step 3: index.js registerIpc 调用点更新**

```js
  registerIpc({ store, getWindow: () => win, imagesDir, getPaletteWindow: () => null, paster: null });
```

（Task 5 会把它替换为真实依赖。）

- [ ] **Step 4: 语法检查 + 回归**

Run: `node --check src/main/ipc.js && node --check src/preload.js && node --check src/main/index.js && npm test`
Expected: 54/54 pass。

- [ ] **Step 5: Commit**

```bash
git add src/main/ipc.js src/preload.js src/main/index.js
git commit -m "feat: IPC 片段接口与隐私打标（listSnippets/pin/unpin/pasteSnippet + secret 字段）"
```

---

## Task 5: paster 粘贴适配层 + palette 迷你窗口 + 主进程接线

**Files:**
- Create: `src/main/paster.js`
- Create: `src/main/palette.js`
- Modify: `src/main/index.js`
- Test: `tests/paster.test.js`

- [ ] **Step 1: 写失败测试**

Create `tests/paster.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert');
const { paste } = require('../src/main/paster');

test('darwin 分支调用 osascript 模拟 Cmd+V', async () => {
  const calls = [];
  const fakeExec = (cmd, args, cb) => {
    calls.push({ cmd, args });
    cb(null);
  };
  const res = await paste('darwin', fakeExec);
  assert.deepStrictEqual(res, { ok: true });
  assert.strictEqual(calls[0].cmd, 'osascript');
  assert.ok(calls[0].args[0].includes('keystroke "v"'));
  assert.ok(calls[0].args[0].includes('command down'));
});

test('osascript 失败返回 paste-failed', async () => {
  const fakeExec = (_cmd, _args, cb) => cb(new Error('not allowed'));
  const res = await paste('darwin', fakeExec);
  assert.deepStrictEqual(res, { ok: false, reason: 'paste-failed' });
});

test('非 darwin 平台返回 unsupported-platform 且不执行命令', async () => {
  const calls = [];
  const fakeExec = (cmd, args, cb) => { calls.push({ cmd, args }); cb(null); };
  const res = await paste('win32', fakeExec);
  assert.deepStrictEqual(res, { ok: false, reason: 'unsupported-platform' });
  assert.strictEqual(calls.length, 0);
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npx cross-env ELECTRON_RUN_AS_NODE=1 node_modules/.bin/electron --test tests/paster.test.js`
Expected: FAIL（Cannot find module）

- [ ] **Step 3: 实现 paster.js**

Create `src/main/paster.js`:

```js
// 平台粘贴适配层：把已在剪贴板的内容用 Cmd/Ctrl+V 模拟粘贴回之前的应用。
// macOS 用 AppleScript（需用户授予辅助功能权限，首次失败时渲染层引导）。
// 其余平台 v3 未实现，返回 unsupported-platform（内容已入剪贴板，可手动粘贴）。

const { execFile } = require('node:child_process');

const MACOS_PASTE_SCRIPT =
  'tell application "System Events" to keystroke "v" using command down';

function paste(platform = process.platform, execFileFn = execFile) {
  return new Promise((resolve) => {
    if (platform !== 'darwin') {
      resolve({ ok: false, reason: 'unsupported-platform' });
      return;
    }
    execFileFn('osascript', ['-e', MACOS_PASTE_SCRIPT], (err) => {
      if (err) {
        resolve({ ok: false, reason: 'paste-failed' });
        return;
      }
      resolve({ ok: true });
    });
  });
}

module.exports = { paste };
```

- [ ] **Step 4: 测试通过**

Run: `npx cross-env ELECTRON_RUN_AS_NODE=1 node_modules/.bin/electron --test tests/paster.test.js`
Expected: 3/3 pass。

- [ ] **Step 5: 实现 palette.js**

Create `src/main/palette.js`:

```js
// 片段快速粘贴面板：迷你窗口（?palette=1 渲染面板模式），失焦自动隐藏。
// 与主窗口同一 preload/renderer 入口，靠 query 参数区分模式。

const path = require('node:path');
const { BrowserWindow, screen } = require('electron');

function createPalette({ rendererDir }) {
  let paletteWin = null;

  function create() {
    paletteWin = new BrowserWindow({
      width: 480,
      height: 360,
      show: false,
      autoHideMenuBar: true,
      webPreferences: {
        preload: path.join(rendererDir, '..', 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
      },
    });
    paletteWin.loadFile(path.join(rendererDir, 'index.html'), {
      query: { palette: '1' },
    });
    paletteWin.webContents.on('did-finish-load', () => {
      if (paletteWin) paletteWin.webContents.send('window-shown');
    });
    paletteWin.on('blur', () => {
      if (paletteWin && !paletteWin.webContents.isDevToolsOpened()) paletteWin.hide();
    });
    paletteWin.on('closed', () => {
      paletteWin = null;
    });
  }

  function show() {
    if (!paletteWin) create();
    const cursor = screen.getCursorScreenPoint();
    const display = screen.getDisplayNearestPoint(cursor);
    const bounds = paletteWin.getBounds();
    const x = Math.round(display.bounds.x + (display.bounds.width - bounds.width) / 2);
    const y = Math.round(display.bounds.y + (display.bounds.height - bounds.height) / 3);
    paletteWin.setBounds({ x, y, width: bounds.width, height: bounds.height });
    paletteWin.show();
    paletteWin.focus();
    paletteWin.webContents.send('window-shown');
  }

  function hide() {
    if (paletteWin) paletteWin.hide();
  }

  function getWindow() {
    return paletteWin;
  }

  return { show, hide, getWindow };
}

module.exports = { createPalette };
```

- [ ] **Step 6: index.js 接线**

6a. 头部 require 追加：

```js
const { createPalette } = require('./palette');
const paster = require('./paster');
```

6b. 模块级变量区加 `let palette = null;`

6c. whenReady 内 `privacyConfig.init(...)` 之后加：

```js
  palette = createPalette({ rendererDir: path.join(__dirname, '..', 'renderer') });
```

6d. `registerIpc` 调用替换为：

```js
  registerIpc({
    store,
    getWindow: () => win,
    imagesDir,
    getPaletteWindow: () => palette && palette.getWindow(),
    paster,
  });
```

6e. 既有主窗口快捷键之后注册面板快捷键：

```js
  const paletteRegistered = globalShortcut.register('CommandOrControl+Shift+;', () => palette.show());
  if (!paletteRegistered) console.error('全局快捷键 CommandOrControl+Shift+; 注册失败');
```

- [ ] **Step 7: 语法检查 + 回归**

Run: `node --check src/main/palette.js && node --check src/main/paster.js && node --check src/main/index.js && npm test`
Expected: 54 + 3 = 57/57 pass。

- [ ] **Step 8: Commit**

```bash
git add src/main/palette.js src/main/paster.js src/main/index.js tests/paster.test.js
git commit -m "feat: 快速粘贴面板与粘贴适配层（Cmd+Shift+; / AppleScript 注入）"
```

---

## Task 6: 渲染层主窗口（Pin 表单 + 片段抽屉 + 打码渲染）

**Files:**
- Modify: `src/renderer/app.js`
- Modify: `src/renderer/styles.css`

> 本任务无新增自动化测试（渲染层惯例）；门 = `node --check` + 全量测试不回归 + Task 8 冒烟。

- [ ] **Step 1: styles.css 追加**

```css
/* 片段抽屉按钮（固定在日期抽屉之上） */
.drawer.snippets-drawer { font-weight: 600; }
.drawer.snippets-drawer .drawer-label::before { content: '📌 '; }

/* 条目行内 Pin 按钮与触发词徽章 */
.item-pin {
  border: none;
  background: transparent;
  color: var(--text-dim);
  font-size: 14px;
  cursor: pointer;
  visibility: hidden;
  flex-shrink: 0;
}
.item:hover .item-pin { visibility: visible; }
.item-pin.pinned { visibility: visible; color: var(--accent); }
.item-trigger {
  font-size: 11px;
  color: var(--accent);
  background: var(--active-bg);
  border-radius: 4px;
  padding: 1px 6px;
  flex-shrink: 0;
  font-family: ui-monospace, monospace;
}

/* 打码渲染 */
.item-secret-mask { color: var(--text-dim); letter-spacing: 2px; }
.item-secret-show {
  border: none;
  background: transparent;
  color: var(--accent);
  cursor: pointer;
  font-size: 12px;
  flex-shrink: 0;
}

/* Pin 表单弹层 */
#pin-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.25);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 10;
}
#pin-overlay[hidden] { display: none; }
#pin-form {
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 16px;
  width: 320px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
#pin-form h3 { margin: 0; font-size: 14px; }
#pin-form label { font-size: 12px; color: var(--text-dim); display: flex; flex-direction: column; gap: 4px; }
#pin-form input {
  padding: 6px 10px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--bg-side);
  color: var(--text);
  outline: none;
}
#pin-form input:focus { border-color: var(--accent); }
#pin-error { color: var(--danger); font-size: 12px; min-height: 14px; margin: 0; }
#pin-buttons { display: flex; justify-content: flex-end; gap: 8px; }
#pin-buttons button {
  padding: 6px 14px;
  border-radius: 6px;
  border: 1px solid var(--border);
  background: transparent;
  color: var(--text);
  cursor: pointer;
}
#pin-buttons .primary { background: var(--accent); border-color: var(--accent); color: #fff; }
#clear-day:disabled { opacity: 0.4; cursor: default; }
#clear-day:disabled:hover { color: var(--text-dim); border-color: var(--border); }
```

- [ ] **Step 2: app.js 修改**

2a. state 增加片段缓存与常量（`const state = {...}` 之后）：

```js
const SNIPPETS_KEY = '__snippets__';
state.snippetGroups = [];
state.snippetCount = 0;
```

2b. `refreshDays` 改为同时拉取片段计数：

```js
async function refreshDays() {
  const [days, groups] = await Promise.all([window.api.listDays(), window.api.listSnippets()]);
  state.days = days;
  state.snippetGroups = groups;
  state.snippetCount = groups.reduce((n, g) => n + g.items.length, 0);
  renderDrawers();
}
```

2c. `renderDrawers` 开头（`drawersEl.innerHTML = '';` 之后、日期循环之前）插入片段抽屉按钮：

```js
  const snip = document.createElement('button');
  snip.className = 'drawer snippets-drawer' + (state.selected === SNIPPETS_KEY && !state.keyword ? ' active' : '');
  const snipLabel = document.createElement('span');
  snipLabel.className = 'drawer-label';
  snipLabel.textContent = '片段';
  const snipCount = document.createElement('span');
  snipCount.className = 'drawer-count';
  snipCount.textContent = state.snippetCount;
  snip.append(snipLabel, snipCount);
  snip.addEventListener('click', () => selectSnippets());
  drawersEl.appendChild(snip);
```

2d. 新增片段视图函数（放在 `selectDay` 之后）：

```js
async function selectSnippets() {
  state.selected = SNIPPETS_KEY;
  state.keyword = '';
  searchEl.value = '';
  renderDrawers();
  state.selectedIndex = -1;
  clearBtn.disabled = true;
  const groups = await window.api.listSnippets();
  state.snippetGroups = groups;
  state.snippetCount = groups.reduce((n, g) => n + g.items.length, 0);
  const total = groups.reduce((n, g) => n + g.items.length, 0);
  titleEl.textContent = `📌 片段 · ${total} 条`;
  itemsEl.innerHTML = '';
  if (!total) {
    state.items = [];
    itemsEl.innerHTML = '<div class="empty">还没有片段：在任意文本条目上点 📌 即可创建</div>';
    return;
  }
  state.items = [];
  for (const g of groups) {
    const h = document.createElement('div');
    h.className = 'search-group';
    h.textContent = `${g.name} · ${g.items.length} 条`;
    itemsEl.appendChild(h);
    for (const item of g.items) itemsEl.appendChild(itemRow(item));
  }
}
```

注意：片段视图与搜索视图共用"分组标题 + 条目"结构，`updateSelectionHighlight` 的 `.item` 索引对齐天然成立；`state.items` 按组序填充与文档顺序一致。

2e. `selectDay` 内恢复清空按钮：`renderDrawers();` 之后加 `clearBtn.disabled = false;`

2f. `itemRow` 文本分支改为（替换现有 else 块）：

```js
  } else {
    const preview = document.createElement('span');
    preview.className = 'item-text';
    if (item.secret) {
      preview.classList.add('item-secret-mask');
      preview.textContent = '••••••••••';
      preview.title = '已隐藏的密码条目';
    } else {
      preview.textContent = truncate(item.text);
      preview.title = item.text;
    }
    preview.addEventListener('click', () => window.api.copyClip(item.id));
    row.append(time, preview);

    if (item.secret) {
      const show = document.createElement('button');
      show.className = 'item-secret-show';
      show.textContent = '显示';
      show.addEventListener('click', (e) => {
        e.stopPropagation();
        if (show.textContent === '显示') {
          preview.textContent = truncate(item.text, 120);
          preview.title = item.text;
          preview.classList.remove('item-secret-mask');
          show.textContent = '隐藏';
        } else {
          preview.textContent = '••••••••••';
          preview.title = '已隐藏的密码条目';
          preview.classList.add('item-secret-mask');
          show.textContent = '显示';
        }
      });
      row.append(show);
    }

    const pin = document.createElement('button');
    pin.className = 'item-pin' + (item.pinned ? ' pinned' : '');
    pin.textContent = item.pinned ? '📌' : '📌';
    pin.title = item.pinned ? '修改/取消 Pin' : 'Pin 成片段';
    pin.addEventListener('click', (e) => {
      e.stopPropagation();
      openPinForm(item);
    });
    row.append(pin);

    if (item.pinned && item.trigger_word) {
      const badge = document.createElement('span');
      badge.className = 'item-trigger';
      badge.textContent = `⌁ ${item.trigger_word}`;
      row.append(badge);
    }
  }
```

（图片分支不变，无 Pin 按钮——仅文本可 Pin。）

2g. 新增 Pin 表单（放在 `imageLabel` 之后）：

```js
// ---- Pin 表单弹层 ----
const pinOverlay = document.createElement('div');
pinOverlay.id = 'pin-overlay';
pinOverlay.hidden = true;
pinOverlay.innerHTML = `
  <div id="pin-form">
    <h3>Pin 成片段</h3>
    <label>触发词（可选，输入面板里敲这个词快速找到）
      <input id="pin-trigger" type="text" placeholder="如 addr" maxlength="32">
    </label>
    <label>分组（可选）
      <input id="pin-group" type="text" placeholder="如 工作" maxlength="32">
    </label>
    <p id="pin-error"></p>
    <div id="pin-buttons">
      <button type="button" id="pin-cancel">取消</button>
      <button type="button" id="pin-confirm" class="primary">确定</button>
      <button type="button" id="pin-remove">取消 Pin</button>
    </div>
  </div>`;
document.body.appendChild(pinOverlay);

let pinTargetId = null;

function openPinForm(item) {
  pinTargetId = item.id;
  document.getElementById('pin-trigger').value = item.trigger_word || '';
  document.getElementById('pin-group').value = item.group_name || '';
  document.getElementById('pin-error').textContent = '';
  document.getElementById('pin-remove').style.display = item.pinned ? '' : 'none';
  pinOverlay.hidden = false;
  document.getElementById('pin-trigger').focus();
}

function closePinForm() {
  pinOverlay.hidden = true;
  pinTargetId = null;
}

document.getElementById('pin-cancel').addEventListener('click', closePinForm);
pinOverlay.addEventListener('click', (e) => { if (e.target === pinOverlay) closePinForm(); });

document.getElementById('pin-remove').addEventListener('click', async () => {
  if (pinTargetId == null) return;
  await window.api.unpinClip(pinTargetId);
  closePinForm();
  refreshAfterMutation();
  if (state.selected === SNIPPETS_KEY) selectSnippets();
});

document.getElementById('pin-confirm').addEventListener('click', async () => {
  if (pinTargetId == null) return;
  const trigger = document.getElementById('pin-trigger').value.trim();
  const group = document.getElementById('pin-group').value.trim();
  const res = await window.api.pinClip(pinTargetId, trigger || null, group || null);
  if (!res.ok) {
    document.getElementById('pin-error').textContent = res.error || '保存失败';
    return;
  }
  closePinForm();
  refreshAfterMutation();
  if (state.selected === SNIPPETS_KEY) selectSnippets();
});
```

2h. `refreshAfterMutation` 在片段视图下也要重绘：函数开头加

```js
  if (state.selected === SNIPPETS_KEY && !state.keyword) {
    await refreshDays();
    selectSnippets();
    return;
  }
```

2i. `clearBtn` 点击守卫：函数开头加 `if (state.selected === SNIPPETS_KEY) return;`（按钮已 disabled，双保险）。

2j. 快捷键处理器中 `window.api.hideWindow()` 前关闭 Pin 表单：Escape 分支开头加 `if (!pinOverlay.hidden) { closePinForm(); return; }`。

- [ ] **Step 3: 语法检查 + 回归**

Run: `node --check src/renderer/app.js && npm test`
Expected: 57/57 pass。

- [ ] **Step 4: Commit**

```bash
git add src/renderer/app.js src/renderer/styles.css
git commit -m "feat: 渲染层片段视图与 Pin 表单、密码打码渲染"
```

---

## Task 7: 渲染层面板模式（?palette=1）

**Files:**
- Modify: `src/renderer/app.js`
- Modify: `src/renderer/styles.css`

- [ ] **Step 1: styles.css 追加**

```css
/* 快速粘贴面板模式（?palette=1）：隐藏抽屉栏，单列布局 */
body.palette #sidebar { display: none; }
body.palette #content-title { font-size: 13px; padding: 8px 16px; }
body.palette #items { padding: 4px 0; }
body.palette .item { padding: 6px 16px; }
#palette-hint {
  position: fixed;
  left: 0;
  right: 0;
  bottom: 0;
  padding: 6px 16px;
  font-size: 12px;
  color: var(--danger);
  background: var(--bg);
  border-top: 1px solid var(--border);
}
#palette-hint[hidden] { display: none; }
```

- [ ] **Step 2: app.js 开头分流**

文件顶部结构调整为：

```js
window.addEventListener('unhandledrejection', (e) => console.error('IPC 调用失败:', e.reason));

// 以下常量与纯函数两个模式共用（提升到分流之前，避免 TDZ/Annex B 提升陷阱）
const drawersEl = document.getElementById('drawers');
const itemsEl = document.getElementById('items');
const titleEl = document.getElementById('content-title');
const searchEl = document.getElementById('search');
const clearBtn = document.getElementById('clear-day');

function toDateKey(ts) { /* 原实现不变 */ }
function formatTime(ts) { /* 原实现不变 */ }
function truncate(text, max = 80) { /* 原实现不变 */ }

// 快速粘贴面板模式：?palette=1 时整页切换为迷你面板，主窗口逻辑不执行
const IS_PALETTE = new URLSearchParams(location.search).get('palette') === '1';
if (IS_PALETTE) {
  initPalette();
} else {
  // ===== 主窗口逻辑（原文件其余全部内容原样移入此块） =====
  // ...
}

// initPalette 与 initPalette 内引用的函数声明
function initPalette() { /* 见 2a */ }
```

关键约束：
- **五个 DOM 常量与 `toDateKey`/`formatTime`/`truncate` 必须留在 if/else 之外**（面板模式直接引用它们；放入 else 会因 const 的 TDZ 与块级函数声明的 Annex B 语义在面板模式下抛错）。
- `labelFor`、`state`、`renderDrawers`、`refreshDays`、`selectDay`、`renderItems`、`itemRow`、`imageLabel`、`refreshAfterMutation`、`doSearch`、search/clear 事件监听、moveSelection、updateSelectionHighlight、clearSearch、主窗口 keydown 监听、`onWindowShown` 注册、末尾的 `refreshDays().then(...)`、以及 Task 6 新增的全部片段代码（含 Pin 表单）——全部在 else 块内（它们依赖主窗口 state 或仅主窗口使用）。
- `initPalette` 函数声明放在文件最末尾（函数声明提升，顶部调用安全；其内部对 `searchEl`/`itemsEl`/`titleEl`/`truncate` 的引用在调用时已初始化）。

2a. 面板实现（文件末尾追加）：

```js
function initPalette() {
  document.body.classList.add('palette');
  const hint = document.createElement('div');
  hint.id = 'palette-hint';
  hint.hidden = true;
  document.body.appendChild(hint);

  const pState = { groups: [], items: [], selectedIndex: -1, keyword: '' };

  async function load() {
    pState.groups = await window.api.listSnippets();
    pState.items = pState.groups.flatMap((g) => g.items);
    render();
  }

  function render() {
    pState.selectedIndex = -1;
    const q = pState.keyword.toLowerCase();
    let shown = pState.items;
    if (q) {
      const byTrigger = pState.items.filter(
        (it) => it.trigger_word && it.trigger_word.toLowerCase().startsWith(q)
      );
      const byText = pState.items.filter(
        (it) => !(it.trigger_word && it.trigger_word.toLowerCase().startsWith(q)) &&
          it.text.toLowerCase().includes(q)
      );
      shown = [...byTrigger, ...byText];
    }
    titleEl.textContent = q
      ? `片段 · ${shown.length}/${pState.items.length} 条`
      : `📌 片段 · ${pState.items.length} 条（↑↓ 选择，Enter 粘贴）`;
    itemsEl.innerHTML = '';
    if (!shown.length) {
      itemsEl.innerHTML = '<div class="empty">没有匹配的片段<br>在主窗口里对文本条目点 📌 创建</div>';
      return;
    }
    for (const item of shown) itemsEl.appendChild(paletteRow(item));
  }

  function paletteRow(item) {
    const row = document.createElement('div');
    row.className = 'item';
    const preview = document.createElement('span');
    preview.className = 'item-text';
    preview.textContent = item.secret ? '••••••••（密码条目）' : truncate(item.text, 90);
    preview.addEventListener('click', () => paste(item.id));
    row.append(preview);
    if (item.trigger_word) {
      const badge = document.createElement('span');
      badge.className = 'item-trigger';
      badge.textContent = `⌁ ${item.trigger_word}`;
      row.append(badge);
    }
    return row;
  }

  async function paste(id) {
    const res = await window.api.pasteSnippet(id);
    if (!res || !res.ok) {
      hint.textContent = res && res.reason === 'paste-failed'
        ? '已复制到剪贴板，但模拟粘贴失败——请到 系统设置 → 隐私与安全性 → 辅助功能 授权后手动 Cmd+V'
        : '已复制到剪贴板，请手动粘贴（Cmd/Ctrl+V）';
      hint.hidden = false;
      setTimeout(() => { hint.hidden = true; }, 5000);
    }
  }

  function move(delta) {
    const rows = itemsEl.querySelectorAll('.item');
    if (!rows.length) return;
    pState.selectedIndex = Math.min(
      Math.max(pState.selectedIndex + delta, 0), rows.length - 1
    );
    rows.forEach((el, i) => el.classList.toggle('selected', i === pState.selectedIndex));
    rows[pState.selectedIndex].scrollIntoView({ block: 'nearest' });
  }

  searchEl.addEventListener('input', () => {
    pState.keyword = searchEl.value.trim();
    render();
  });

  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { window.api.hideWindow(); return; }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      move(e.key === 'ArrowDown' ? 1 : -1);
      return;
    }
    if (e.key === 'Enter' && pState.selectedIndex >= 0) {
      e.preventDefault();
      const rows = itemsEl.querySelectorAll('.item');
      const target = rows[pState.selectedIndex];
      if (target) {
        // 行上没有存 id，从可见顺序反查：重算当前过滤结果
        const q = pState.keyword.toLowerCase();
        let shown = pState.items;
        if (q) {
          const byTrigger = pState.items.filter(
            (it) => it.trigger_word && it.trigger_word.toLowerCase().startsWith(q)
          );
          const byText = pState.items.filter(
            (it) => !(it.trigger_word && it.trigger_word.toLowerCase().startsWith(q)) &&
              it.text.toLowerCase().includes(q)
          );
          shown = [...byTrigger, ...byText];
        }
        const item = shown[pState.selectedIndex];
        if (item) paste(item.id);
      }
    }
  });

  window.api.onWindowShown(() => {
    searchEl.value = '';
    pState.keyword = '';
    pState.selectedIndex = -1;
    load().then(() => searchEl.focus());
    searchEl.focus();
  });

  load().then(() => searchEl.focus());
}
```

2b. 文件末尾结构完成即可（`initPalette` 已在 2a 给出完整实现，else 块的内容边界在 Step 2 开头说明中界定）。

- [ ] **Step 3: 语法检查 + 回归**

Run: `node --check src/renderer/app.js && npm test`
Expected: 57/57 pass。

- [ ] **Step 4: Commit**

```bash
git add src/renderer/app.js src/renderer/styles.css
git commit -m "feat: 快速粘贴面板渲染模式（过滤/键盘导航/粘贴失败提示）"
```

---

## Task 8: 集成冒烟 + README

**Files:**
- Modify: `README.md`

- [ ] **Step 1: 冒烟**

1. `node --check` 全部改动文件 + `npm test`（57/57）。
2. 清理旧 DB 测试干扰：不需要——用既有库即可。后台 `npm start`，等 6 秒。
3. 复制疑似密码：`osascript -e 'set the clipboard to "Xy9#kQ2$vL8mP4!zR2"'`（18 字符），等 2 秒。
4. `ELECTRON_RUN_AS_NODE=1` electron 临时脚本查 `~/Library/Application Support/clipboard-drawer/clipboard.db` 最新行：存在且 type='text'（默认 mask 模式应记录）。
5. 用 DB 脚本把某条 UPDATE 成 pinned：`UPDATE clips SET pinned=1, trigger_word='test' WHERE id=<某文本行>`；然后 `osascript` 发送 `keystroke ";" using {command down, shift down}` 唤起面板，等 1 秒，`screencapture -x /tmp/cut-palette-smoke.png`，Read 截图确认面板出现且有过滤提示文案；再发送 `keystroke "test"` 过滤。截第二张图确认过滤后只剩该片段。
6. 粘贴注入真实验证需要辅助功能权限，可能失败——失败属环境限制，记录即可。
7. 清理：kill 应用、删临时脚本与截图外的临时文件。

- [ ] **Step 2: README 更新**

功能列表在图片条目之后追加两条：

```markdown
- 片段库：历史文本一键 Pin，设触发词与分组，`Cmd/Ctrl+Shift+;` 快速粘贴面板随叫随贴
- 隐私安全区：自动识别疑似密码，托盘菜单可切换"记录但打码（默认）/完全不记录"
```

`## 快捷键` 章节在 `- `Cmd/Ctrl+K` 聚焦搜索框` 之后追加：

```markdown
- `Cmd/Ctrl+Shift+;` 片段快速粘贴面板（↑↓ 选择，Enter 粘贴，Esc 取消）
```

- [ ] **Step 3: 回归 + Commit**

Run: `npm test`（57/57）

```bash
git add README.md
git commit -m "docs: README 补充片段库与隐私安全区说明"
```

---

## 自检记录

- **Spec 覆盖**：片段迁移/pin/分组（T2）、隐私检测器（T1）、配置持久化+托盘菜单+拦截（T3）、ipc 打标+pasteSnippet（T4）、面板窗口+快捷键+粘贴适配（T5）、Pin 表单/片段视图/打码（T6）、面板渲染（T7）、冒烟+README（T8）。全部有对应任务。
- **类型一致性**：`ClipStore.pin(id, trigger, groupName)` T2 定义 = T4 ipc 调用；`paste(platform, execFileFn)` T5 定义 = 测试一致；IPC 形状 `{name, items}` 贯穿 store→ipc→renderer；`window.api.pinClip/unpinClip/pasteSnippet/listSnippets` preload 与 app.js 调用一致；`trigger_word` 列名贯穿 store/renderer/palette（避开 SQLite 关键字 `trigger`）。
- **已知计划偏差（相对 spec，已获 spec 同步修正）**：`findByTrigger` 裁剪（改客户端过滤）；pin 即 upsert（无独立 updatePin）；列名 `trigger_word`。
- **无占位符**：所有代码步骤含完整代码与命令。
