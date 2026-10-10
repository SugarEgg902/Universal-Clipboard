# 自定义存储位置 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 托盘菜单自选剪贴板数据目录（clipboard.db + images），切换后新位置从零记录（或沿用该目录已有库），旧位置数据不动，写配置后自动重启生效。

**Architecture:** config.json 新增 `dataDir` 指针（config 本身永驻 userData）；新纯函数模块 `storagePath.js` 负责路径解析与可写探针；index.js 启动时先 init privacyConfig → resolveDataPaths → openStore（失败回退默认）；托盘菜单提供更改/恢复与当前路径常驻显示。

**Tech Stack:** Electron 33（dialog.showOpenDialog / app.relaunch）、Node fs/path。

**Spec:** `docs/superpowers/specs/2026-10-10-custom-storage-path-design.md`

**分支:** 从 main（96/96）切 `feature/custom-storage-path`。

---

## 背景：执行者需要知道的现有结构

- **测试**：`npm test` = `cross-env ELECTRON_RUN_AS_NODE=1 electron --test tests/`（绝不 plain node）；单文件 `npx cross-env ELECTRON_RUN_AS_NODE=1 node_modules/.bin/electron --test tests/<file>`。基线 96/96。
- **privacyConfig.js**：整体 config 对象模式，`{ privacyMode, pet:{...} }` 原子写（tmp+rename）。本计划加第三字段 `dataDir`。导出 `{ init, getMode, setMode, getPet, setPet, PET_EMOJIS }`。
- **index.js 启动顺序**（app.whenReady，约 144-148 行）：当前是 `openStore(dbPath, imagesDir)` 在前、`privacyConfig.init(userData)` 在后。**本功能必须交换顺序**（init 只读 config 文件，无任何前置依赖，交换安全）：先 init 才能读到 dataDir 再决定 dbPath。
- **store**：`openStore(dbPath, imagesDir)`（src/main/store.js），构造函数里 `fs.mkdirSync(imagesDir, {recursive:true})`；打开失败（只读等）会抛。
- **托盘菜单**：`createTray()` 内一次性 `Menu.buildFromTemplate` + `setContextMenu` 常驻；「开机自启」checkbox 之后、「桌宠」之前是合适的插入位。托盘当前不显示任何路径信息。
- **冒烟纪律**：kill 既有实例（`pgrep -fl electron`，报告是否杀了用户日常实例）；真实数据零污染（本功能冒烟用独立测试目录，不碰真实 clipboard.db）；截图 Read 验证。

---

## Task 1: storagePath 模块 + privacyConfig dataDir 字段

**Files:**
- Create: `src/main/storagePath.js`
- Modify: `src/main/privacyConfig.js`
- Test: `tests/storagePath.test.js`（新建）；`tests/privacyConfig.test.js`（追加）

- [ ] **Step 1: 写失败测试（tests/storagePath.test.js）**

```js
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { resolveDataPaths, probeWritable } = require('../src/main/storagePath');

test('resolveDataPaths：dataDir 为 null 时用 userData 默认', () => {
  const p = resolveDataPaths('/Users/x/Library/Application Support/clipboard-drawer', null);
  assert.strictEqual(p.dbPath, path.join('/Users/x/Library/Application Support/clipboard-drawer', 'clipboard.db'));
  assert.strictEqual(p.imagesDir, path.join('/Users/x/Library/Application Support/clipboard-drawer', 'images'));
  assert.strictEqual(p.effectiveDir, '/Users/x/Library/Application Support/clipboard-drawer');
});

test('resolveDataPaths：自定义目录 + 尾部斜杠归一', () => {
  const p = resolveDataPaths('/ud', '/Volumes/D/data/');
  assert.strictEqual(p.effectiveDir, path.sep === '\\' ? '\\Volumes\\D\\data' : '/Volumes/D/data');
  assert.strictEqual(p.dbPath, path.join(p.effectiveDir, 'clipboard.db'));
  assert.strictEqual(p.imagesDir, path.join(p.effectiveDir, 'images'));
});

test('resolveDataPaths：相对路径 resolve 成绝对', () => {
  const p = resolveDataPaths('/ud', 'relative/dir');
  assert.ok(path.isAbsolute(p.effectiveDir));
});

test('probeWritable：正常目录可写（自动创建）', () => {
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sp-')), 'sub', 'data');
  const r = probeWritable(dir);
  assert.strictEqual(r.ok, true);
  assert.ok(fs.existsSync(dir));
});

test('probeWritable：文件路径当目录 → ok:false', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-'));
  const filePath = path.join(dir, 'afile');
  fs.writeFileSync(filePath, 'x');
  const r = probeWritable(filePath);
  assert.strictEqual(r.ok, false);
  assert.ok(r.error);
});

test('probeWritable：只读目录 → ok:false（POSIX chmod）', () => {
  if (process.platform === 'win32') return; // Windows 权限模型不同，跳过
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-'));
  fs.chmodSync(dir, 0o555);
  try {
    const r = probeWritable(path.join(dir, 'sub'));
    assert.strictEqual(r.ok, false);
  } finally {
    fs.chmodSync(dir, 0o755);
  }
});
```

Run: `npx cross-env ELECTRON_RUN_AS_NODE=1 node_modules/.bin/electron --test tests/storagePath.test.js`
Expected: FAIL（模块不存在）。

- [ ] **Step 2: 实现 src/main/storagePath.js**

```js
// 存储位置：dataDir（config.json 指针）→ 实际 db/images 路径解析 + 可写探针。
// dataDir 为 null/空串 = 默认 userData；config.json 本身永远留在 userData。

const fs = require('node:fs');
const path = require('node:path');

function resolveDataPaths(userDataDir, dataDir) {
  if (typeof dataDir === 'string' && dataDir.trim()) {
    const abs = path.resolve(dataDir.replace(/[\\/]+$/, ''));
    return {
      dbPath: path.join(abs, 'clipboard.db'),
      imagesDir: path.join(abs, 'images'),
      effectiveDir: abs,
    };
  }
  return {
    dbPath: path.join(userDataDir, 'clipboard.db'),
    imagesDir: path.join(userDataDir, 'images'),
    effectiveDir: userDataDir,
  };
}

// 探针：创建目录（不存在时）+ 写删探针文件。返回 { ok } 或 { ok:false, error }。
function probeWritable(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    const probe = path.join(dir, `.clipboard-drawer-probe-${process.pid}`);
    fs.writeFileSync(probe, 'ok');
    fs.unlinkSync(probe);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

module.exports = { resolveDataPaths, probeWritable };
```

- [ ] **Step 3: privacyConfig.test.js 追加测试（沿用文件现有 tmp 目录 helper 模式）**

```js
test('getDataDir/setDataDir：默认 null，写盘与读取一致', () => {
  const dir = makeTmpDir(); // 若文件已有 helper 则复用
  privacyConfig.init(dir);
  assert.strictEqual(privacyConfig.getDataDir(), null);
  privacyConfig.setDataDir('/Volumes/D/cut-data');
  assert.strictEqual(privacyConfig.getDataDir(), '/Volumes/D/cut-data');
  const saved = JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'));
  assert.strictEqual(saved.dataDir, '/Volumes/D/cut-data');
  assert.strictEqual(saved.privacyMode, 'mask'); // 其他字段不受影响
});

test('setDataDir：空串与 null 归一为 null（恢复默认）', () => {
  const dir = makeTmpDir();
  privacyConfig.init(dir);
  privacyConfig.setDataDir('/x');
  privacyConfig.setDataDir('');
  assert.strictEqual(privacyConfig.getDataDir(), null);
  privacyConfig.setDataDir('/x');
  privacyConfig.setDataDir(null);
  assert.strictEqual(privacyConfig.getDataDir(), null);
});

test('setDataDir：非字符串忽略；与 setPet/setMode 互不覆盖', () => {
  const dir = makeTmpDir();
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
});
```

Run: 单文件全绿。

- [ ] **Step 4: privacyConfig.js 扩展**

修改三处（保持文件现有风格）：

4a. 顶部常量与默认 config：

```js
const DEFAULTS = { privacyMode: 'mask', dataDir: null };
// 替换现有的 let config = { privacyMode: 'mask', pet: { ...DEFAULT_PET } };
// 为：let config = { ...DEFAULTS, pet: { ...DEFAULT_PET } };
```

4b. sanitize 与 init 中读取：

```js
function sanitizeDataDir(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'string' && v.trim()) return v;
  return undefined; // 非法值 → init 时忽略（保持默认）
}

// init 的 try 块内，saved.privacyMode 校验之后加：
    if (sanitizeDataDir(saved.dataDir) !== undefined) config.dataDir = sanitizeDataDir(saved.dataDir);
```
（注意：init 每次调用须重置 config.dataDir 为 null——确认 init 的 config 重置语句用的是 `{ ...DEFAULTS, pet: {...DEFAULT_PET} }` 形式。）

4c. 导出函数（getPet/setPet 之后）：

```js
function getDataDir() {
  return config.dataDir;
}

// dir 为 null/空串 = 恢复默认；非字符串忽略本次写入
function setDataDir(dir) {
  if (dir === null || dir === '') {
    config.dataDir = null;
    write();
    return;
  }
  if (typeof dir !== 'string') return;
  config.dataDir = dir;
  write();
}
```

module.exports 追加 `getDataDir, setDataDir`。

Run: 单文件全绿（既有 + 新 3 条）。

- [ ] **Step 5: 全量回归 + Commit**

Run: `npm test` — Expected: **105/105**（96 基线 + 9 条新测试）。

```bash
git add src/main/storagePath.js src/main/privacyConfig.js tests/storagePath.test.js tests/privacyConfig.test.js
git commit -m "feat: 存储位置配置——dataDir 指针、路径解析纯函数、可写探针"
```

---

## Task 2: index.js 接线 + 托盘菜单 + 启动回退 + 冒烟 + README

**Files:**
- Modify: `src/main/index.js`
- Modify: `README.md`

- [ ] **Step 1: index.js 启动重排 + 回退（whenReady 开头，约 144-148 行）**

把：

```js
  const dbPath = path.join(app.getPath('userData'), 'clipboard.db');
  const imagesDir = path.join(app.getPath('userData'), 'images');
  store = openStore(dbPath, imagesDir);
  privacyConfig.init(app.getPath('userData'));
```

改为（init 提前——本功能的前提；init 只读文件无前置依赖）：

```js
  const userDataDir = app.getPath('userData');
  privacyConfig.init(userDataDir);
  let paths = resolveDataPaths(userDataDir, privacyConfig.getDataDir());
  try {
    store = openStore(paths.dbPath, paths.imagesDir);
  } catch (err) {
    // 自定义位置建库失败（只读/磁盘错误等）：回退默认路径，应用照常可用
    console.error('自定义存储位置建库失败，回退默认路径:', err);
    paths = resolveDataPaths(userDataDir, null);
    store = openStore(paths.dbPath, paths.imagesDir);
  }
  dataPaths = paths;
```

模块级（`let store = null;` 旁）加 `let dataPaths = null;`。顶部 require 加 `const { resolveDataPaths, probeWritable } = require('./storagePath');`；electron 解构里确认有 `dialog`（没有则加）。

- [ ] **Step 2: 托盘菜单（createTray 内，「开机自启」之后、「桌宠」之前）**

```js
    { type: 'separator' },
    { label: `存储位置：${dataPaths ? dataPaths.effectiveDir : ''}`, enabled: false },
    {
      label: '更改存储位置…',
      click: async () => {
        const res = await dialog.showOpenDialog({
          title: '选择剪贴板数据存储目录',
          properties: ['openDirectory', 'createDirectory'],
        });
        if (res.canceled || !res.filePaths[0]) return;
        const probe = probeWritable(res.filePaths[0]);
        if (!probe.ok) {
          dialog.showErrorBox('无法使用该目录', probe.error || '目录不可写，请换一个有写入权限的目录');
          return;
        }
        privacyConfig.setDataDir(res.filePaths[0]);
        app.relaunch();
        app.exit(0);
      },
    },
    {
      label: '恢复默认位置',
      click: () => {
        privacyConfig.setDataDir(null);
        app.relaunch();
        app.exit(0);
      },
    },
    { type: 'separator' },
```

（若目标目录已有 clipboard.db，重启后自动沿用——store 的 migrate 会校验补 schema，无需特殊处理。）

- [ ] **Step 3: 语法检查 + 全量回归**

Run: `node --check src/main/index.js src/main/storagePath.js src/main/privacyConfig.js && npm test` — Expected: OK，**105/105**。

- [ ] **Step 4: 冒烟（真实环境）**

1. `pgrep -fl electron` 检查并 kill 既有实例（报告）；备份当前 config.json（`cp ~/Library/Application\ Support/clipboard-drawer/config.json /tmp/cut-config-backup.json`）。
2. 后台 `npm start`，等 6 秒；截图 `/tmp/cut-sp-tray0.png` 前先点开托盘菜单不可行（坐标脆）——改为验证文件系统：`ls ~/Library/Application\ Support/clipboard-drawer/` 确认 clipboard.db 在默认位。
3. 写 config.json 的 dataDir 为 `~/Documents/cut-data-smoke`（osascript/jq/手写 JSON——保持其他字段原值）；`npm start`；等 6 秒；`ls ~/Documents/cut-data-smoke/` 应出现 clipboard.db 与 images/；默认目录旧 clipboard.db 大小/mtime 不变（未被动过）。
4. 在 `~/Documents/cut-data-smoke/clipboard.db` 里 `osascript` 复制一条文本触发新库记录（或跳过，文件存在即可）；然后恢复 config.json（dataDir: null）+ 重启；确认默认目录库打开正常、旧数据条目数不变。
5. 还原：kill 应用；恢复 config.json 备份；`rm -rf ~/Documents/cut-data-smoke`；确认真实 DB 无新增冒烟数据（本次冒烟不改默认库）。
6. 托盘菜单新三项的 UI 验证（常驻路径灰显/更改/恢复）由代码审查 + 用户手动确认（自动化点托盘坐标过脆）。

- [ ] **Step 5: README + Commit**

README「数据位置」章节末尾追加：

```markdown
自定义存储位置：托盘菜单「更改存储位置…」可把数据目录换到任意位置（如另一块磁盘）；切换后新位置从零开始记录（该目录已有 clipboard.db 则沿用），旧数据原地保留不动；「恢复默认位置」切回。
```

```bash
git add src/main/index.js README.md
git commit -m "feat: 自定义存储位置——托盘切换/恢复、启动解析与回退"
```

---

## 自检记录

- Spec 覆盖：dataDir 配置(§3.1→T1)、resolveDataPaths/probeWritable(§3.2→T1)、托盘三件套与 relaunch(§3.3→T2)、启动回退(§3.4→T2)、README(§3.5→T2)、错误处理表(§4→T1 错误码 + T2 回退/探针)、测试策略(§5→T1 单测 + T2 冒烟)。
- 无占位符：所有代码步骤含完整实现。
- 类型一致：resolveDataPaths 返回 { dbPath, imagesDir, effectiveDir } 在 T1 定义、T2 消费；probeWritable 返回 { ok, error? }；getDataDir 返回 string|null。
- 测试计数：基线 96 → T1 后 105（9 条新测试）→ T2 不增（渲染层惯例 + 接线无新单测，冒烟覆盖）。
