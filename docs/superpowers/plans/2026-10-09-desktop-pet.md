# 桌宠悬浮抽屉柜 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 常驻桌宠小窗——迷你抽屉精灵贴角待机（呼吸+随机小动作+打盹），每次复制冒预览气泡（密码只显 🔒），单击开主窗口，可拖动换位。

**Architecture:** 主进程新模块 `pet.js` 复刻 palette.js 的窗口管理模式（无边框透明、focusable:false、alwaysOnTop floating、销毁重建）；配置并入 `privacyConfig`（config.json 扩展 pet 子对象，同一原子写）；watcher 入库成功后组装气泡 payload 经 `pet:clip` 推给桌宠渲染层；桌宠独立页面 pet.html/pet.js/pet.css 承载状态机/冒泡/拖拽。

**Tech Stack:** Electron 33（BrowserWindow transparent/frameless/setAlwaysOnTop）、纯 CSS 动画。

**Spec:** `docs/superpowers/specs/2026-10-09-desktop-pet-design.md`

**分支:** 从 main（76/76）切 `feature/desktop-pet`。

---

## 背景：执行者需要知道的现有结构

- **privacyConfig.js**：当前缓存单个 `mode` 变量，写文件 `{privacyMode}`（tmp+rename 原子写）。本计划将其改造为整体 config 对象（向后兼容：旧文件无 pet 字段时懒默认）。
- **palette.js**：`createPalette({rendererDir}) → {show,hide,getWindow}` 模式——lazy create、`blur` 隐藏、`closed` 置 null、`show()` 可重建。pet.js 复刻此模式但不隐藏（常驻）。
- **index.js**：`app.whenReady` 内顺序 store → privacyConfig.init → createPalette → protocol → registerIpc({store,getWindow,imagesDir,getPaletteWindow,paster,hideApp}) → watcher（onClip/onImage 回调）→ createTray → globalShortcut → createWindow+showWindow。watcher 的 `onClip(text)` 目前不取 `store.insert` 返回值（null=当天重复）。
- **ipc.js**：`registerIpc(deps)` 集中注册 `ipcMain.handle`；`withMeta` spread 透传行字段。
- **preload.js**：`contextBridge.exposeInMainWorld('api', {...})`，invoke + on 两种形态。
- **测试**：`npm test` = `cross-env ELECTRON_RUN_AS_NODE=1 electron --test tests/`（绝不 plain node）；单文件 `npx cross-env ELECTRON_RUN_AS_NODE=1 node_modules/.bin/electron --test tests/<file>`。基线 76/76。
- **渲染层无自动化测试**（惯例）：门 = `node --check` + 全量不回归 + 冒烟。
- **冒烟注意**：检查并 kill 早于启动的既有 app 实例；用真实 DB 后按 text 精确 DELETE 还原；`screencapture -x` 截图后 Read 验证。

---

## Task 1: 配置扩展（privacyConfig 整体化 + pet 子配置）

> **执行期修订（质量审查修复）**：sanitizePet 的 `>= 0` 坐标钳制会拒绝多显示器下左/上方副屏的合法负数坐标（桌宠在该屏永远无法记忆位置），改为仅校验 `Number.isFinite`（负数合法，越界钳制交给窗口层）。setPet 改为非法值保留原值（base 回退）、`null` 显式重置、`undefined` 键跳过；测试相应替换"负数视为非法"断言并新增多 init 重置用例。计数 81→82。

**Files:**
- Modify: `src/main/privacyConfig.js`
- Test: `tests/privacyConfig.test.js`（追加）

- [ ] **Step 1: 写失败测试（追加进 tests/privacyConfig.test.js，沿用文件现有 init 模式：tmp 目录 + init(dir)）**

```js
test('getPet：无 pet 字段时返回懒默认值', () => {
  // init 一个只写 {"privacyMode":"mask"} 的目录
  const dir = makeTmpDir(); // 若文件已有 helper 则复用
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ privacyMode: 'mask' }));
  privacyConfig.init(dir);
  const pet = privacyConfig.getPet();
  assert.strictEqual(pet.enabled, true);
  assert.strictEqual(pet.x, null);
  assert.strictEqual(pet.y, null);
  assert.strictEqual(pet.emoji, '📦');
});

test('getPet：pet 字段部分缺失时深合并默认', () => {
  const dir = makeTmpDir();
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ privacyMode: 'skip', pet: { emoji: '🐱' } }));
  privacyConfig.init(dir);
  const pet = privacyConfig.getPet();
  assert.strictEqual(pet.emoji, '🐱');
  assert.strictEqual(pet.enabled, true); // 默认回填
  assert.strictEqual(privacyConfig.getMode(), 'skip'); // 原字段不受影响
});

test('setPet：深合并写盘且原子文件包含 privacyMode', () => {
  const dir = makeTmpDir();
  privacyConfig.init(dir);
  privacyConfig.setMode('skip');
  privacyConfig.setPet({ x: 100, y: 200 });
  const saved = JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'));
  assert.strictEqual(saved.privacyMode, 'skip');
  assert.strictEqual(saved.pet.x, 100);
  assert.strictEqual(saved.pet.y, 200);
  assert.strictEqual(saved.pet.enabled, true);
  assert.strictEqual(privacyConfig.getPet().y, 200);
});

test('setPet：非法字段被钳制（emoji 白名单 / x,y 数字或 null / enabled 布尔）', () => {
  const dir = makeTmpDir();
  privacyConfig.init(dir);
  privacyConfig.setPet({ emoji: '💣', enabled: 'yes', x: 'abc', y: -5 });
  const pet = privacyConfig.getPet();
  assert.strictEqual(pet.emoji, '📦'); // 不在白名单 → 保持默认
  assert.strictEqual(pet.enabled, true);
  assert.strictEqual(pet.x, null);
  assert.strictEqual(pet.y, null); // 负数视为非法
});

test('setMode 与 setPet 独立不互相覆盖', () => {
  const dir = makeTmpDir();
  privacyConfig.init(dir);
  privacyConfig.setPet({ emoji: '🐤', x: 10 });
  privacyConfig.setMode('skip');
  const saved = JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'));
  assert.strictEqual(saved.pet.emoji, '🐤');
  assert.strictEqual(saved.privacyMode, 'skip');
});
```

Run: `npx cross-env ELECTRON_RUN_AS_NODE=1 node_modules/.bin/electron --test tests/privacyConfig.test.js`
Expected: 新 5 条 FAIL（getPet/setPet 不存在）。

- [ ] **Step 2: 改造 privacyConfig.js（整体 config 对象）**

整文件替换为：

```js
// 应用配置：userData/config.json 持久化，内存缓存，原子写（tmp+rename）。
// privacyMode: mask（默认，记录但打码）/ skip（完全不记录）。
// pet: 桌宠 { enabled, x, y, emoji }——x/y 为窗口坐标 null=默认角落，emoji 白名单限定。

const fs = require('node:fs');
const path = require('node:path');

const PET_EMOJIS = ['📦', '🗃️', '🐱', '🐤'];
const DEFAULT_PET = { enabled: true, x: null, y: null, emoji: '📦' };

let configPath = null;
let config = { privacyMode: 'mask', pet: { ...DEFAULT_PET } };

function sanitizePet(pet) {
  const src = pet && typeof pet === 'object' ? pet : {};
  const out = { ...DEFAULT_PET };
  if (typeof src.enabled === 'boolean') out.enabled = src.enabled;
  if (src.emoji && PET_EMOJIS.includes(src.emoji)) out.emoji = src.emoji;
  for (const k of ['x', 'y']) {
    if (src[k] === null || src[k] === undefined) continue;
    if (Number.isFinite(src[k]) && src[k] >= 0) out[k] = src[k];
  }
  return out;
}

function write() {
  if (!configPath) return;
  try {
    const tmp = configPath + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(config, null, 2));
    fs.renameSync(tmp, configPath);
  } catch (err) {
    console.error('配置保存失败:', err);
  }
}

function init(userDataDir) {
  configPath = path.join(userDataDir, 'config.json');
  config = { privacyMode: 'mask', pet: { ...DEFAULT_PET } };
  try {
    const saved = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    if (saved.privacyMode === 'mask' || saved.privacyMode === 'skip') config.privacyMode = saved.privacyMode;
    config.pet = sanitizePet(saved.pet);
  } catch {
    // 文件不存在或损坏都回退默认
  }
}

function getMode() {
  return config.privacyMode;
}

function setMode(next) {
  if (next !== 'mask' && next !== 'skip') return;
  config.privacyMode = next;
  write();
}

function getPet() {
  return { ...config.pet };
}

function setPet(patch) {
  config.pet = sanitizePet({ ...config.pet, ...patch });
  write();
}

module.exports = { init, getMode, setMode, getPet, setPet, PET_EMOJIS };
```

Run: 单文件全绿。

- [ ] **Step 3: 全量回归 + Commit**

Run: `npm test` — Expected: **82/82 pass**（76 + 5 新 + 审查修正：替换 1 条钳制用例、新增 1 条多 init 用例）。

```bash
git add src/main/privacyConfig.js tests/privacyConfig.test.js
git commit -m "feat: 配置整体化——pet 子配置（位置/开关/形象，白名单钳制，懒默认）"
```

---

## Task 2: pet 主进程窗口 + IPC + watcher 接线 + 托盘

> **执行期修订（质量审查修复，commit 338377e）**：① `loadFile` 加 `.catch`（pet.html 在 Task 3 才创建，且 pet 默认开启，否则启动即未处理 rejection）；② 多屏修正——applyDrag 钳制改为 `screen.getDisplayNearestPoint` 最近显示器（原实现只钳主屏，与 4dce8cd 配置层负数坐标支持矛盾，副屏桌宠一拖即弹回）；create() 恢复位置时校验是否仍落在某块已连接显示器的可见区内，越界回退默认角落（防拔屏后桌宠出现在屏外无恢复路径）；③ pet:set-emoji handler 加 PET_EMOJIS 白名单守卫再转发渲染层；④ Menu 并入 ipc.js 顶部 require；⑤ 24/40 魔数加注释；⑥ onClip 的 looksLikeSecret 提为局部常量。计数不变（86/86）。

**Files:**
- Create: `src/main/pet.js`
- Modify: `src/main/index.js`
- Modify: `src/main/ipc.js`
- Modify: `src/preload.js`
- Test: `tests/pet.test.js`（新建）

- [ ] **Step 1: 写失败测试（tests/pet.test.js）**

```js
const test = require('node:test');
const assert = require('node:assert');
const { buildClipPayload } = require('../src/main/pet');

test('buildClipPayload：普通文本截断 60 字', () => {
  const p = buildClipPayload({ kind: 'text', text: 'a'.repeat(100), secret: false });
  assert.strictEqual(p.kind, 'text');
  assert.strictEqual(p.preview.length, 60);
  assert.strictEqual(p.secret, false);
});

test('buildClipPayload：密码行预览为空串且 secret=true', () => {
  const p = buildClipPayload({ kind: 'text', text: 'Xy9#kQ2$vL8mP4!zR', secret: true });
  assert.strictEqual(p.preview, '');
  assert.strictEqual(p.secret, true);
});

test('buildClipPayload：图片带尺寸', () => {
  const p = buildClipPayload({ kind: 'image', width: 800, height: 600 });
  assert.strictEqual(p.kind, 'image');
  assert.strictEqual(p.preview, '800×600');
});

test('buildClipPayload：缺 text 视为空', () => {
  const p = buildClipPayload({ kind: 'text' });
  assert.strictEqual(p.preview, '');
  assert.strictEqual(p.secret, false);
});
```

Run: `npx cross-env ELECTRON_RUN_AS_NODE=1 node_modules/.bin/electron --test tests/pet.test.js`
Expected: FAIL（模块不存在）。

- [ ] **Step 2: 实现 src/main/pet.js**

```js
// 桌宠：常驻迷你窗口（无边框透明，不抢焦点，floating 置顶不压全屏）。
// 复刻 palette.js 管理模式：lazy create、closed 置 null、show() 重建。

const path = require('node:path');
const { BrowserWindow, screen } = require('electron');

const WIN_W = 200;
const WIN_H = 260;

// 气泡 payload 组装（纯函数，watcher 入库成功后调用）
function buildClipPayload({ kind, text, width, height, secret }) {
  if (kind === 'image') {
    return { kind: 'image', preview: `${width}×${height}`, secret: false };
  }
  return { kind: 'text', preview: secret ? '' : String(text || '').slice(0, 60), secret: !!secret };
}

function createPet({ rendererDir, getPetConfig, onMoved }) {
  let petWin = null;

  function create() {
    const cfg = getPetConfig();
    const display = screen.getPrimaryDisplay();
    const x = cfg.x != null ? cfg.x : display.bounds.width - WIN_W - 24;
    const y = cfg.y != null ? cfg.y : display.bounds.height - WIN_H - 24;
    petWin = new BrowserWindow({
      width: WIN_W,
      height: WIN_H,
      x: Math.round(x),
      y: Math.round(y),
      show: false,
      transparent: true,
      frame: false,
      resizable: false,
      skipTaskbar: true,
      hasShadow: false,
      focusable: false,
      webPreferences: {
        preload: path.join(rendererDir, '..', 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
      },
    });
    petWin.setAlwaysOnTop(true, 'floating');
    petWin.loadFile(path.join(rendererDir, 'pet.html'));
    petWin.on('closed', () => {
      petWin = null;
    });
  }

  function show() {
    if (!petWin) create();
    petWin.showInactive(); // focusable:false 窗口不抢焦点
  }

  function hide() {
    if (petWin) petWin.hide();
  }

  // 渲染层拖拽增量（dx,dy 可为负）；钳制在 primary display 内
  function applyDrag(dx, dy) {
    if (!petWin) return;
    const [cx, cy] = petWin.getPosition();
    const d = screen.getPrimaryDisplay().bounds;
    const nx = Math.min(Math.max(cx + dx, d.x - WIN_W + 40), d.x + d.width - 40);
    const ny = Math.min(Math.max(cy + dy, d.y), d.y + d.height - 40);
    petWin.setPosition(nx, ny);
  }

  function persistPosition() {
    if (!petWin || !onMoved) return;
    const [x, y] = petWin.getPosition();
    onMoved(x, y);
  }

  function notifyClip(payload) {
    if (petWin) petWin.webContents.send('pet:clip', payload);
  }

  function setEmoji(emoji) {
    if (petWin) petWin.webContents.send('pet:emoji', emoji);
  }

  function getWindow() {
    return petWin;
  }

  return { show, hide, applyDrag, persistPosition, notifyClip, setEmoji, getWindow };
}

module.exports = { createPet, buildClipPayload };
```

Run: 单文件 4/4。

- [ ] **Step 3: ipc.js 追加 pet handlers（registerIpc deps 扩展）**

deps 追加 `pet, showWindow, showPalette, privacyConfig`。文件末尾（其他 handle 之后）追加：

```js
  ipcMain.handle('pet:drag', (_event, dx, dy) => {
    if (pet) pet.applyDrag(Number(dx) || 0, Number(dy) || 0);
  });
  ipcMain.handle('pet:drag-end', () => {
    if (pet) pet.persistPosition();
  });
  ipcMain.handle('pet:open-main', () => {
    if (showWindow) showWindow();
  });
  ipcMain.handle('pet:open-palette', () => {
    if (showPalette) showPalette();
  });
  ipcMain.handle('pet:context-menu', () => {
    const { Menu } = require('electron');
    Menu.buildFromTemplate([
      { label: '打开主窗口', click: () => showWindow && showWindow() },
      { label: '快速粘贴面板', click: () => showPalette && showPalette() },
      { type: 'separator' },
      {
        label: '禁用桌宠',
        click: () => {
          privacyConfig.setPet({ enabled: false });
          if (pet) pet.hide();
        },
      },
    ]).popup();
  });
  ipcMain.handle('pet:set-emoji', (_event, emoji) => {
    privacyConfig.setPet({ emoji });
    if (pet) pet.setEmoji(emoji);
  });
```

（`Menu` 若已在文件顶部 require 则复用，勿重复。）

- [ ] **Step 4: preload.js 追加**

```js
  petDrag: (dx, dy) => ipcRenderer.invoke('pet:drag', dx, dy),
  petDragEnd: () => ipcRenderer.invoke('pet:drag-end'),
  petOpenMain: () => ipcRenderer.invoke('pet:open-main'),
  petOpenPalette: () => ipcRenderer.invoke('pet:open-palette'),
  petContextMenu: () => ipcRenderer.invoke('pet:context-menu'),
  petSetEmoji: (emoji) => ipcRenderer.invoke('pet:set-emoji', emoji),
  onPetClip: (callback) => ipcRenderer.on('pet:clip', (_e, payload) => callback(payload)),
  onPetEmoji: (callback) => ipcRenderer.on('pet:emoji', (_e, emoji) => callback(emoji)),
```

- [ ] **Step 5: index.js 接线**

5a. 顶部 require 加 `const { createPet } = require('./pet');`，`let pet = null;`（palette 变量旁）。

5b. `createPalette` 之后：

```js
  pet = createPet({
    rendererDir: path.join(__dirname, '..', 'renderer'),
    getPetConfig: () => privacyConfig.getPet(),
    onMoved: (x, y) => privacyConfig.setPet({ x, y }),
  });
```

5c. `registerIpc` deps 追加：

```js
    pet,
    showWindow,
    showPalette: () => palette.show(),
    privacyConfig,
```

5d. watcher `onClip` 改为（取 insert 返回值；skip 模式密码 return 前不通知——不记录不冒泡）：

```js
    onClip: (text) => {
      try {
        // 检测器本身不 trim（含空白即不判定是对多行内容的严格排除）；
        // 调用点 trim 以兜住"终端复制带尾换行的密码"这一常见形态。
        const trimmed = String(text).trim();
        if (privacyConfig.getMode() === 'skip' && looksLikeSecret(trimmed)) {
          console.log('[隐私] 已跳过疑似密码内容（完全不记录模式）');
          return;
        }
        const id = store.insert(text);
        if (id != null && pet) {
          pet.notifyClip(buildClipPayload({ kind: 'text', text: trimmed, secret: looksLikeSecret(trimmed) }));
        }
      } catch (err) {
        console.error('剪贴板写入数据库失败:', err);
      }
    },
```

`onImage` 改为：

```js
    onImage: (img) => {
      try {
        const id = store.insertImage(img.buffer, img.width, img.height);
        if (id != null && pet) {
          pet.notifyClip(buildClipPayload({ kind: 'image', width: img.width, height: img.height }));
        }
      } catch (err) {
        console.error('图片写入数据库失败:', err);
      }
    },
```

顶部 require `buildClipPayload`：`const { createPet, buildClipPayload } = require('./pet');`

5e. 托盘菜单（"开机自启"之后）追加：

```js
    {
      label: '桌宠',
      type: 'checkbox',
      checked: privacyConfig.getPet().enabled,
      click: (item) => {
        privacyConfig.setPet({ enabled: item.checked });
        if (item.checked) pet.show();
        else pet.hide();
      },
    },
    {
      label: '桌宠形象',
      submenu: privacyConfig.PET_EMOJIS.map((e) => ({
        label: e,
        type: 'radio',
        checked: privacyConfig.getPet().emoji === e,
        click: () => {
          privacyConfig.setPet({ emoji: e });
          if (pet) pet.setEmoji(e);
        },
      })),
    },
```

5f. `createWindow(); showWindow();` 之前追加桌宠启动：

```js
  if (privacyConfig.getPet().enabled) pet.show();
```

- [ ] **Step 6: 语法检查 + 全量回归**

Run: `node --check src/main/pet.js src/main/index.js src/main/ipc.js src/preload.js && npm test` — Expected: OK，**85/85**（81 + pet.test.js 4 条新测试）。

> 注：pet.html/pet.js/pet.css 本任务尚未创建，`petWin.loadFile` 在运行时才会 404——不影响测试与语法门，Task 3 补齐。

- [ ] **Step 7: Commit**

```bash
git add src/main/pet.js src/main/index.js src/main/ipc.js src/preload.js tests/pet.test.js
git commit -m "feat: 桌宠主进程——常驻透明小窗、气泡 payload、IPC、托盘开关与形象"
```

---

## Task 3: 桌宠渲染层（状态机 + 冒泡 + 拖拽）+ 冒烟 + README

> **执行期修订（质量审查修复，commit 3d9e4d6）**：① playAction 的 scheduleAction() 移到 `state !== 'idle'` early-return 之前（原写法下 timer 落在 sleepy/excited/hover 期间即永久停调度）；② 'dragging' class 双保险——CSS 规则移到所有状态类之后（等优先级靠源码顺序压过 .hover 的 lean），整体 className 赋值改走 `applyClass()` 封装（拖拽标志位拼回 class，防状态切换剥掉 dragging）；③ 鼠标事件升级 Pointer Events + `setPointerCapture`（修窗口外 mouseup 拖拽卡死；pointerup 保留 button===0 守卫，右键抬起不误触 petOpenMain）；④ excited 超时回调加状态守卫；动作/excited 结束经 backToIdle() 统一回退，`matches(':hover')` 感知指针仍在吉祥物上则回 hover 而非 idle（state 与 class 保持一致，避免 mouseleave 失效）；⑤ 动作 class 移除超时按 ACTION_MS 真实时长映射（消除动画结束后的僵直空窗）；⑥ pointerdown 加 `e.button !== 0` 守卫（计划参考代码的 bug：右键会 arm drag 并在 mouseup 误开主窗口——实现期自查偏离，审查判定合理保留）；⑦ unhandledrejection 吞噪音（对齐 app.js）；⑧ .bubble.secret 颜色走 CSS 变量（暗色 #aaa）。另实现期补充：`@media (prefers-color-scheme: dark)` 气泡变量覆写（计划明确允许）。冒烟期间用户真实拖拽验证了持久化写路径，剪切板曾被测试密码覆盖（已如实报告用户）。计数不变（86/86）。

**Files:**
- Create: `src/renderer/pet.html`
- Create: `src/renderer/pet.js`
- Create: `src/renderer/pet.css`
- Modify: `README.md`

> 渲染层无自动化测试（惯例）；门 = `node --check` + 全量不回归 + 冒烟。冒烟前检查并 kill 既有 app 实例。

- [ ] **Step 1: pet.html**

```html
<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'self'; style-src 'self' 'unsafe-inline'">
  <title>pet</title>
  <link rel="stylesheet" href="pet.css">
</head>
<body>
  <div id="stage">
    <div id="bubble-layer"></div>
    <div id="zzz" hidden>💤</div>
    <div id="mascot">📦</div>
  </div>
  <script src="pet.js"></script>
</body>
</html>
```

- [ ] **Step 2: pet.css**

```css
:root { color-scheme: light dark; }
* { margin: 0; padding: 0; box-sizing: border-box; user-select: none; -webkit-user-select: none; }
html, body { width: 100%; height: 100%; overflow: hidden; background: transparent; }
body { font-family: -apple-system, system-ui, sans-serif; }

#stage { position: relative; width: 100%; height: 100%; pointer-events: none; }

/* 吉祥物本体：可点可拖；其余透明区穿透 */
#mascot {
  position: absolute; right: 0; bottom: 0;
  width: 64px; height: 64px;
  font-size: 44px; line-height: 64px; text-align: center;
  cursor: grab; pointer-events: auto;
  animation: bob 3.2s ease-in-out infinite;
}
#mascot.dragging { cursor: grabbing; animation: none; }

/* 待机小动作（JS 切 class，播完移除） */
#mascot.blink   { animation: blink .5s ease; }
#mascot.hop     { animation: hop .6s ease; }
#mascot.look    { animation: look 3s ease; }
#mascot.stretch { animation: stretch 3.2s ease; }
#mascot.flip    { animation: flip .8s ease; }
#mascot.shuffle { animation: shuffle 3s ease; }
#mascot.excited { animation: hop .45s ease 2; }
#mascot.hover   { animation: lean 1.2s ease-in-out infinite; }
#mascot.sleepy  { animation: bob 6s ease-in-out infinite; filter: saturate(.6); }

@keyframes bob     { 0%,100% { transform: translateY(0) } 50% { transform: translateY(-4px) } }
@keyframes blink   { 50% { transform: scaleY(.15) } }
@keyframes hop     { 50% { transform: translateY(-16px) } }
@keyframes look    { 0%,100% { transform: rotate(0) } 25% { transform: rotate(-10deg) } 75% { transform: rotate(10deg) } }
@keyframes stretch { 50% { transform: scaleY(1.2) scaleX(.9) } }
@keyframes flip    { to { transform: rotate(360deg) } }
@keyframes shuffle { 0%,100% { transform: translateX(0) } 25% { transform: translateX(-8px) } 75% { transform: translateX(8px) } }
@keyframes lean    { 0%,100% { transform: rotate(0) } 50% { transform: rotate(10deg) } }

/* 打盹 */
#zzz {
  position: absolute; right: 40px; bottom: 56px;
  font-size: 20px; pointer-events: none;
  animation: zzz 2.4s ease-in-out infinite;
}
@keyframes zzz { 0% { opacity: 0; transform: translateY(6px) } 30% { opacity: 1 } 100% { opacity: 0; transform: translateY(-18px) } }

/* 冒泡 */
#bubble-layer { position: absolute; right: 8px; bottom: 68px; width: 184px;
  display: flex; flex-direction: column; justify-content: flex-end; align-items: flex-end; gap: 4px; }
.bubble {
  max-width: 184px; padding: 6px 10px;
  background: var(--pet-bubble-bg, rgba(255,255,255,.95));
  color: var(--pet-bubble-text, #222);
  border-radius: 10px; box-shadow: 0 2px 8px rgba(0,0,0,.18);
  font-size: 12px; line-height: 1.4; word-break: break-all;
  animation: bubble-rise 3s ease forwards;
}
.bubble.secret { color: #888; }
@keyframes bubble-rise {
  0% { opacity: 0; transform: translateY(8px) scale(.9) }
  10% { opacity: 1; transform: translateY(0) scale(1) }
  80% { opacity: 1 }
  100% { opacity: 0; transform: translateY(-14px) }
}
```

（深色适配：`@media (prefers-color-scheme: dark)` 覆写两个气泡变量即可，不加也可接受。）

- [ ] **Step 3: pet.js（渲染层逻辑）**

```js
// 桌宠渲染层：待机状态机 + 冒泡 + 拖拽/单击 + 菜单
const mascot = document.getElementById('mascot');
const zzz = document.getElementById('zzz');
const bubbleLayer = document.getElementById('bubble-layer');

let lastClipAt = Date.now();
let state = 'idle'; // idle | action | hover | sleepy | excited
let actionTimer = null;

const IDLE_ACTIONS = ['blink', 'hop', 'look', 'stretch', 'flip', 'shuffle'];
const SLEEPY_AFTER = 30 * 60 * 1000;

function setState(next) {
  if (state === 'excited' && next !== 'idle') return; // excited 播完再切换
  state = next;
  mascot.className = next === 'action' ? '' : next;
  zzz.hidden = next !== 'sleepy';
}

function playAction() {
  if (state !== 'idle') return;
  const name = IDLE_ACTIONS[Math.floor(Math.random() * IDLE_ACTIONS.length)];
  state = 'action';
  mascot.classList.add(name);
  setTimeout(() => {
    mascot.classList.remove(name);
    if (state === 'action') { state = 'idle'; mascot.className = 'idle'; }
  }, name === 'blink' || name === 'hop' || name === 'flip' ? 900 : 3200);
  scheduleAction();
}

function scheduleAction() {
  clearTimeout(actionTimer);
  actionTimer = setTimeout(playAction, 25000 + Math.random() * 20000);
}

// 冒泡
function pushBubble(payload) {
  while (bubbleLayer.children.length >= 3) bubbleLayer.firstChild.remove();
  const b = document.createElement('div');
  b.className = 'bubble' + (payload.secret ? ' secret' : '');
  if (payload.kind === 'image') b.textContent = `🖼 ${payload.preview}`;
  else if (payload.secret) b.textContent = '🔒 已捕获密码';
  else b.textContent = payload.preview;
  bubbleLayer.appendChild(b);
  setTimeout(() => b.remove(), 3000);
}

window.api.onPetClip((payload) => {
  lastClipAt = Date.now();
  if (state === 'sleepy') setState('idle');
  if (state !== 'excited') {
    state = 'excited';
    mascot.className = 'excited';
    setTimeout(() => { state = 'idle'; mascot.className = 'idle'; }, 950);
  }
  pushBubble(payload);
});

window.api.onPetEmoji((emoji) => { mascot.textContent = emoji; });

// 打盹巡检（30s 粒度足够）
setInterval(() => {
  if (state === 'idle' && Date.now() - lastClipAt > SLEEPY_AFTER) setState('sleepy');
}, 30000);

// 悬停
mascot.addEventListener('mouseenter', () => { if (state === 'idle' || state === 'sleepy') setState('hover'); });
mascot.addEventListener('mouseleave', () => { if (state === 'hover') setState('idle'); });

// 拖拽 vs 单击（4px 阈值）
let drag = null;
mascot.addEventListener('mousedown', (e) => {
  drag = { x: e.screenX, y: e.screenY, moved: false };
  mascot.classList.add('dragging');
});
window.addEventListener('mousemove', (e) => {
  if (!drag) return;
  const dx = e.screenX - drag.x;
  const dy = e.screenY - drag.y;
  if (Math.abs(e.screenX - drag.x) + Math.abs(e.screenY - drag.y) > 4) drag.moved = true;
  if (drag.moved) {
    window.api.petDrag(dx, dy);
    drag.x = e.screenX;
    drag.y = e.screenY;
  }
});
window.addEventListener('mouseup', () => {
  if (!drag) return;
  mascot.classList.remove('dragging');
  if (drag.moved) window.api.petDragEnd();
  else window.api.petOpenMain();
  drag = null;
});
mascot.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  window.api.petContextMenu();
});

setState('idle');
scheduleAction();
```

- [ ] **Step 4: 语法检查 + 全量回归**

Run: `node --check src/renderer/pet.js src/main/pet.js && npm test` — Expected: OK，**81/81**。

- [ ] **Step 5: 冒烟（真实环境）**

1. 检查并 kill 既有实例（`pgrep -fl "electron ."`），后台 `npm start`，等 6 秒——桌宠应出现在右下角。
2. `screencapture -x /tmp/cut-pet-idle.png`，Read 确认桌宠可见且 📦 在呼吸位。
3. `osascript -e 'set the clipboard to "桌宠冒烟测试文本 abc"'`，等 1.5 秒，截图 `/tmp/cut-pet-bubble.png`，Read 确认气泡含预览文本。
4. 复制一张图片（`osascript` 无法直接塞图片进剪贴板：用 `screencapture -i` 太重——改用既有 history 中的图片路径跳过，或复制一段密码验证 🔒）：`osascript -e 'set the clipboard to "Xy9#kQ2$vL8mP4!zR2"'`，等 1.5 秒截图 `/tmp/cut-pet-secret.png`，Read 确认 🔒 气泡、无密码内容。
5. 悬停桌宠（`osascript` 移动鼠标到右下角坐标）观察 hover，可选。
6. 拖动换位：osascript 模拟拖拽较脆——用鼠标事件 `tell application "System Events"` 的 drag 不可靠时，改为验证持久化路径：直接改 config.json 的 pet.x/y 后重启应用观察位置变化。
7. 托盘禁用/启用：`osascript` 点托盘图标（坐标脆弱）→ 若不可行，改验证 config 写入 + 重启后桌宠按 enabled 显隐。
8. 还原：kill 应用；真实 DB 按 text 精确 DELETE 冒烟文本行；config.json 的 pet 段恢复默认（enabled:true,x:null,y:null,emoji:📦）；删除临时文件；PNG 保留 /tmp。

- [ ] **Step 6: README + Commit**

功能列表"常驻系统托盘"一条之后追加：

```markdown
- 桌宠悬浮窗：右下角迷你抽屉精灵，复制即冒预览气泡（密码只显 🔒），待机随机小动作，单击开主窗口，可拖动换位
```

```bash
git add src/renderer/pet.html src/renderer/pet.js src/renderer/pet.css README.md
git commit -m "feat: 桌宠渲染层——待机状态机、冒泡、拖拽换位"
```

---

## 自检记录

- Spec 覆盖：形态/置顶(§3.1→T2)、事件接线与 skip 语义(§3.2→T2)、配置(§3.3→T1)、IPC(§3.4→T2)、冒泡(§4.1→T3)、状态机(§4.2→T3)、交互(§4.3→T3)、边界(§5→T2 钳制/T3 冒烟)、测试(§6→T1/T2/T3)。
- 无占位符：所有代码步骤含完整实现。
- 类型一致：payload `{kind, preview, secret}` 在 pet.js 生成、IPC 透传、pet.js 渲染层消费一致；配置 pet 字段名在 privacyConfig/pet.js/index.js/tray 一致。
- 测试计数：基线 76 → T1 后 82（5 新 + 1 审查修正）→ T2 后 86（pet.test.js 4 条）→ T3 不增（渲染层惯例）。
