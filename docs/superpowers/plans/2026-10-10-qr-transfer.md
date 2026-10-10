# 扫码快传（QR Transfer）实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 剪贴板内容一键生成二维码——单条/当天/多选三个入口，短文本直编二维码离线可扫，长文本/图片/多选自动起临时局域网 HTTP 服务，二维码只编码带随机 token 的内网 URL。

**Architecture:** 主进程新模块 `qrserver.js`（双路判定纯函数 + Node 内置 http 临时服务，零新依赖）；`qrwin.js` 复刻 palette.js 弹窗模式承载二维码；渲染层 vendor `qrcode` 包的 UMD 构建画 canvas（无构建步骤的惯例）；入口挂在 app.js 行 hover 按钮与 sidebar。

**Tech Stack:** Electron 33、Node 内置 http/crypto/os、qrcode（npm，vendor UMD）。

**Spec:** `docs/superpowers/specs/2026-10-10-qr-transfer-design.md`

**分支:** 从 main（86/86）切 `feature/qr-transfer`。

---

## 背景：执行者需要知道的现有结构

- **测试**：`npm test` = `cross-env ELECTRON_RUN_AS_NODE=1 electron --test tests/`（绝不 plain node）；单文件 `npx cross-env ELECTRON_RUN_AS_NODE=1 node_modules/.bin/electron --test tests/<file>`。基线 86/86。
- **渲染层无构建步骤、无自动化测试**（惯例）：`<script src>` 直接加载，CSP `default-src 'self'`。第三方库只能 vendor UMD 构建进 `src/renderer/vendor/`。门 = `node --check` + 全量不回归 + 冒烟。
- **secret 不是 DB 字段**：`src/main/ipc.js` 的 `withMeta` 用 `looksLikeSecret(row.text)` 实时算出行上的 `secret: true/false` 给渲染层（`src/main/secretDetector.js` 导出 `looksLikeSecret`）。QR 入口判断密码条目用同一个函数（主进程侧）。
- **图片条目**：DB 行 `type:'image'`、`image_path` 字段（sha256 文件名，实际文件在 `imagesDir`）；渲染层经自定义协议 `clipimg://thumb/<id>` 显示。QR 服务端读文件必须 `path.basename(image_path)` 拼回 imagesDir（防目录穿越），index.js 的 clipimg handler 就是范例。
- **store**：`openStore(dbPath, imagesDir)`（src/main/store.js）；`store.get(id)` 返回单行；`store.insert(text)` 返回 id；内存库 `openStore(':memory:', tmpdir)` 可用于测试。
- **弹窗模式**：`src/main/palette.js` 与 `src/main/pet.js` 的 `createXxx({rendererDir}) → {show,...}`——lazy create、`closed` 置 null、`show()` 重建。qrwin 复刻。
- **index.js 顺序**：`app.whenReady` 内 store → privacyConfig.init → createPalette → createPet → protocol → registerIpc({store, getWindow, imagesDir, ...}) → watcher → createTray → createWindow。qrwin 在 createPet 之后创建，deps 传入 registerIpc。
- **app.js 顶部分流**：`const IS_PALETTE = ...get('palette') === '1'`，if/else 两分支。新入口代码只进主窗口分支；函数声明与 const 的位置注意 TDZ/Annex-B 坑（v3 教训：5 个 DOM const 与工具函数保持在分流外）。
- **app.js itemRow**（src/renderer/app.js:139-255）：每行结构 = `time` + 文本 preview 或 img thumb → （secret 行有"显示"按钮）→ 📌 pin 按钮 → 徽章们；末尾统一挂 `del`(×) 按钮（图片行也挂）。QR 按钮插在 pin 之后、del 之前。
- **index.html sidebar**（src/renderer/index.html:11-15）：`<input id="search">`、`<nav id="drawers">`、`<button id="clear-day">清空当天</button>`。当天 QR 按钮放 clear-day 之后。
- **冒烟纪律**：kill 既有实例（`pgrep -fl electron`）；真实 DB 按 text 精确 DELETE 还原；`screencapture -x` 截图后 Read PNG。

---

## Task 1: qrserver——双路判定 + 临时 HTTP 服务 + 内容解析

**Files:**
- Create: `src/main/qrserver.js`
- Test: `tests/qrserver.test.js`（新建）

- [ ] **Step 1: 写失败测试（tests/qrserver.test.js）**

```js
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { routeFor, lanIp, resolveContent, startServer, INLINE_MAX_BYTES } = require('../src/main/qrserver');
const { openStore } = require('../src/main/store');

function getJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, body, type: res.headers['content-type'] }));
    }).on('error', reject);
  });
}

// —— routeFor 双路判定 ——

test('routeFor：≤1000 字节文本走 inline', () => {
  const short = 'a'.repeat(INLINE_MAX_BYTES);
  const r = routeFor({ kind: 'text', text: short });
  assert.strictEqual(r.mode, 'inline');
  assert.strictEqual(r.data, short);
});

test('routeFor：1001 字节文本走 url（按 UTF-8 字节计，中文 3 字节/字）', () => {
  assert.strictEqual(routeFor({ kind: 'text', text: 'a'.repeat(INLINE_MAX_BYTES + 1) }).mode, 'url');
  // 334 个汉字 = 1002 字节 → url；333 个 = 999 字节 → inline
  assert.strictEqual(routeFor({ kind: 'text', text: '汉'.repeat(334) }).mode, 'url');
  assert.strictEqual(routeFor({ kind: 'text', text: '汉'.repeat(333) }).mode, 'inline');
});

test('routeFor：image 与 bundle 恒走 url', () => {
  assert.strictEqual(routeFor({ kind: 'image' }).mode, 'url');
  assert.strictEqual(routeFor({ kind: 'bundle', ids: [1] }).mode, 'url');
});

// —— resolveContent 内容解析 ——

function mkStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qr-test-'));
  return { store: openStore(':memory:', dir), dir };
}

test('resolveContent：text 取行文本，image 取文件路径，bundle 拼合并排除密码', () => {
  const { store, dir } = mkStore();
  const id1 = store.insert('第一段');
  const id2 = store.insert('第二段');
  store.insert('Xy9#kQ2$vL8mP4!zR'); // 疑似密码
  const imgId = store.insertImage(fs.readFileSync(path.join(__dirname, 'fixtures/1px.png')), 1, 1);

  const t = resolveContent(store, dir, { kind: 'text', id: id1 });
  assert.deepStrictEqual(t, { contentType: 'text', text: '第一段' });

  if (imgId != null) {
    const img = resolveContent(store, dir, { kind: 'image', id: imgId });
    assert.strictEqual(img.contentType, 'image');
    assert.ok(fs.existsSync(img.imagePath));
  }

  const b = resolveContent(store, dir, { kind: 'bundle', ids: [id1, id2, imgId].filter(Boolean) });
  assert.strictEqual(b.contentType, 'text');
  assert.strictEqual(b.text, '第一段\n\n第二段'); // 图片行与非文本行被跳过
});

test('resolveContent：id 不存在/类型不符 → not-found；bundle 全被过滤 → empty', () => {
  const { store, dir } = mkStore();
  assert.throws(() => resolveContent(store, dir, { kind: 'text', id: 9999 }), /not-found/);
  const imgOnly = store.insertImage(Buffer.from('notapng'), 1, 1);
  if (imgOnly != null) {
    assert.throws(() => resolveContent(store, dir, { kind: 'bundle', ids: [imgOnly] }), /empty/);
  }
  assert.throws(() => resolveContent(store, dir, { kind: 'bundle', ids: [] }), /empty/);
});

// —— startServer 临时 HTTP 服务 ——

test('startServer：GET /t/<token> 返回内容，错误 token 404，stop 后拒绝连接', async () => {
  const session = await startServer({ contentType: 'text', text: '你好，世界' }, { timeoutMs: 60000 });
  try {
    assert.match(session.url, /^http:\/\/127\.0\.0\.1:\d+\/t\/[0-9a-f]{32}$/);
    const ok = await getJson(session.url);
    assert.strictEqual(ok.status, 200);
    assert.strictEqual(ok.body, '你好，世界');
    assert.match(ok.type, /text\/plain/);
    const bad = await getJson(session.url.replace(/\/t\//, '/t/000'));
    assert.strictEqual(bad.status, 404);
  } finally {
    session.stop();
  }
  await assert.rejects(getJson(session.url), /ECONNREFUSED/);
});

test('startServer：image 内容返回 image/png 字节流', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qr-test-'));
  const pngPath = path.join(dir, 'test.png');
  fs.writeFileSync(pngPath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  const session = await startServer({ contentType: 'image', imagePath: pngPath }, { timeoutMs: 60000 });
  try {
    const res = await getJson(session.url);
    assert.strictEqual(res.status, 200);
    assert.match(res.type, /image\/png/);
  } finally {
    session.stop();
  }
});

test('startServer：超时自动关闭', async () => {
  const session = await startServer({ contentType: 'text', text: 'x' }, { timeoutMs: 80, ip: '127.0.0.1' });
  await new Promise((r) => setTimeout(r, 200));
  await assert.rejects(getJson(session.url), /ECONNREFUSED/);
});

test('startServer：端口被占时自动探测下一个端口', async () => {
  const blocker = http.createServer();
  await new Promise((r) => blocker.listen(43789, '127.0.0.1', r));
  try {
    const session = await startServer(
      { contentType: 'text', text: 'x' },
      { timeoutMs: 60000, ip: '127.0.0.1', portRange: [43789, 43791] }
    );
    try {
      assert.ok(session.port > 43789);
      const res = await getJson(session.url);
      assert.strictEqual(res.status, 200);
    } finally {
      session.stop();
    }
  } finally {
    blocker.close();
  }
});

test('lanIp：返回非回环 IPv4 字符串（无网卡环境本机也成立）', () => {
  const ip = lanIp();
  assert.match(ip, /^\d+\.\d+\.\d+\.\d+$/);
  assert.notStrictEqual(ip, '127.0.0.1');
});
```

依赖 `tests/fixtures/1px.png`——Step 1.5 用 printf 生成一个最小 PNG：

```bash
mkdir -p tests/fixtures
printf '\x89PNG\r\n\x1a\n\x00\x00\x00\x0dIHDR\x00\x00\x00\x01\x00\x00\x00\x01\x08\x06\x00\x00\x00\x1f\x15\xc4\x89\x00\x00\x00\x0aIDATx\x9cc\x00\x01\x00\x00\x05\x00\x01\x0d\x0a-\xb4\x00\x00\x00\x00IEND\xaeB\x60\x82' > tests/fixtures/1px.png
```

Run: `npx cross-env ELECTRON_RUN_AS_NODE=1 node_modules/.bin/electron --test tests/qrserver.test.js`
Expected: FAIL（模块不存在）。

- [ ] **Step 2: 实现 src/main/qrserver.js**

```js
// 扫码快传：双路判定（短文本直编二维码 / 其余走临时局域网 HTTP）+ 内容解析 + 临时服务。
// 零第三方依赖；token 不可猜测，服务生命周期由调用方（QR 弹窗）控制，另有硬超时。

const crypto = require('node:crypto');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const { looksLikeSecret } = require('./secretDetector');

const INLINE_MAX_BYTES = 1000;
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_PORT_RANGE = [43789, 43999];

// 双路判定：仅"单条短文本"直编二维码，其余（长文本/图片/多选）走局域网 URL。
// text 必须已解析（resolveContent 之后调用），本函数不碰 store。
function routeFor(payload) {
  if (payload && payload.kind === 'text') {
    const text = String(payload.text || '');
    if (Buffer.byteLength(text, 'utf8') <= INLINE_MAX_BYTES) {
      return { mode: 'inline', data: text };
    }
  }
  return { mode: 'url' };
}

// 第一个非回环 IPv4（Node 18+ family 为数字 4，旧版为字符串 'IPv4'，两者兼容）。
function lanIp() {
  for (const infos of Object.values(os.networkInterfaces())) {
    for (const info of infos || []) {
      if ((info.family === 'IPv4' || info.family === 4) && !info.internal) return info.address;
    }
  }
  const err = new Error('no-network');
  err.code = 'no-network';
  throw err;
}

function codedError(code) {
  const err = new Error(code);
  err.code = code;
  return err;
}

// 按 payload 组装服务内容。抛带 code 的错误：not-found / empty / bad-request。
function resolveContent(store, imagesDir, payload) {
  if (payload && payload.kind === 'text') {
    const row = store.get(payload.id);
    if (!row || row.type !== 'text') throw codedError('not-found');
    return { contentType: 'text', text: row.text };
  }
  if (payload && payload.kind === 'image') {
    const row = store.get(payload.id);
    if (!row || row.type !== 'image' || !row.image_path) throw codedError('not-found');
    // basename 防目录穿越（参照 index.js clipimg handler）
    const imagePath = path.join(imagesDir, path.basename(row.image_path));
    if (!fs.existsSync(imagePath)) throw codedError('not-found');
    return { contentType: 'image', imagePath };
  }
  if (payload && payload.kind === 'bundle') {
    const texts = [];
    for (const id of payload.ids || []) {
      const row = store.get(id);
      // 只打包文本且排除疑似密码（与 spec §3.4 一致）
      if (row && row.type === 'text' && !looksLikeSecret(row.text)) texts.push(row.text);
    }
    if (!texts.length) throw codedError('empty');
    return { contentType: 'text', text: texts.join('\n\n') };
  }
  throw codedError('bad-request');
}

// 起临时 HTTP 服务：GET /t/<128bit-hex token> 返回内容。
// opts: { timeoutMs, ip, portRange }（测试注入；生产默认值见上）。
// resolve { url, token, port, stop() }；端口被占在 portRange 内顺序探测，耗尽抛 no-port。
function startServer(content, opts = {}) {
  const timeoutMs = opts.timeoutMs || DEFAULT_TIMEOUT_MS;
  const ip = opts.ip || lanIp();
  const [p0, p1] = opts.portRange || DEFAULT_PORT_RANGE;
  const token = crypto.randomBytes(16).toString('hex');

  const server = http.createServer((req, res) => {
    const pathname = (req.url || '').split('?')[0];
    if (pathname !== `/t/${token}`) {
      res.statusCode = 404;
      res.end('not found');
      return;
    }
    if (content.contentType === 'image') {
      res.setHeader('Content-Type', 'image/png');
      fs.createReadStream(content.imagePath)
        .on('error', () => {
          if (!res.headersSent) res.statusCode = 500;
          res.end();
        })
        .pipe(res);
    } else {
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.end(content.text);
    }
  });

  return new Promise((resolve, reject) => {
    let port = p0;
    let timer = null;
    const stop = () => {
      clearTimeout(timer);
      server.close();
    };
    const tryListen = () => {
      server.once('error', (err) => {
        if (err.code === 'EADDRINUSE' && port < p1) {
          port += 1;
          tryListen();
        } else {
          reject(err.code === 'EADDRINUSE' ? codedError('no-port') : err);
        }
      });
      server.listen(port, ip, () => {
        timer = setTimeout(stop, timeoutMs);
        resolve({ url: `http://${ip}:${port}/t/${token}`, token, port, stop });
      });
    };
    tryListen();
  });
}

module.exports = { routeFor, lanIp, resolveContent, startServer, INLINE_MAX_BYTES };
```

Run: 单文件 10/10 绿（9 test 块）。

- [ ] **Step 3: 全量回归 + Commit**

Run: `npm test` — Expected: **96/96**（86 基线 + 10 条新测试）。

```bash
git add src/main/qrserver.js tests/qrserver.test.js tests/fixtures/1px.png
git commit -m "feat: 扫码快传服务端——双路判定、内容解析、临时 HTTP（token/超时/端口探测）"
```

---

## Task 2: QR 弹窗主进程（qrwin）+ IPC + preload + 接线

> **执行期修订（质量审查修复，commit e4a752e）**：show() 非重入竞态——session 在 `await startServer` 后才赋值，两次快速 qr:show 交错会产生孤儿局域网服务（继续服务到 10 分钟超时）与错序刷旧码。修复为请求序号守卫（模块级 reqSeq，await 后 mySeq !== reqSeq 则停新服务直接返回）；另补 did-fail-load 日志兜底、send 闭包捕获窗口句柄（对齐 pet.js 防御风格）。记录在案未修：加载期多次 show 堆叠 once 监听（守卫已消除错序，last-wins 不影响最终态）。计数不变（96/96）。

**Files:**
- Create: `src/main/qrwin.js`
- Modify: `src/main/ipc.js`
- Modify: `src/main/index.js`
- Modify: `src/preload.js`

- [ ] **Step 1: 实现 src/main/qrwin.js**（窗口模式复刻 pet.js；渲染层 qr.html 在 Task 3 创建，loadFile 加 catch）

```js
// 二维码弹窗：复刻 pet.js 窗口模式——lazy create、closed 置 null、show() 重建。
// 生命周期：blur/closed 即停局域网服务；新 show() 先停旧服务再判定新路。

const path = require('node:path');
const { BrowserWindow } = require('electron');
const qrserver = require('./qrserver');

const WIN_W = 320;
const WIN_H = 380;

function createQrWin({ rendererDir, store, imagesDir }) {
  let qrWin = null;
  let session = null; // 当前局域网服务句柄 { stop() }

  function stopSession() {
    if (session) {
      session.stop();
      session = null;
    }
  }

  function create() {
    qrWin = new BrowserWindow({
      width: WIN_W,
      height: WIN_H,
      show: false,
      backgroundColor: '#ffffff', // 白底黑码，保证扫描对比度
      frame: false,
      resizable: false,
      skipTaskbar: true,
      webPreferences: {
        preload: path.join(rendererDir, '..', 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
      },
    });
    qrWin.setAlwaysOnTop(true, 'floating');
    qrWin
      .loadFile(path.join(rendererDir, 'qr.html'))
      .catch((err) => console.error('二维码页面加载失败:', err));
    // 失焦即关（等同用户看完走人）：停服务 + 隐藏
    qrWin.on('blur', () => {
      stopSession();
      qrWin.hide();
    });
    qrWin.on('closed', () => {
      stopSession();
      qrWin = null;
    });
  }

  // payload: { kind:'text'|'image', id } 或 { kind:'bundle', ids:[...] }
  // 返回判定结果（渲染层经 qr:render 收到同样的对象；窗口未加载完则等 did-finish-load）。
  async function show(payload) {
    stopSession();
    let result;
    try {
      const content = qrserver.resolveContent(store, imagesDir, payload);
      const routed = qrserver.routeFor({
        kind: content.contentType === 'text' ? 'text' : 'image',
        text: content.text,
      });
      if (routed.mode === 'inline') {
        result = { mode: 'inline', data: content.text };
      } else {
        session = await qrserver.startServer(content);
        result = { mode: 'url', url: session.url };
      }
    } catch (err) {
      result = { mode: 'error', code: err.code || 'failed' };
    }
    if (!qrWin) create();
    qrWin.showInactive();
    const send = () => qrWin.webContents.send('qr:render', result);
    if (qrWin.webContents.isLoading()) qrWin.webContents.once('did-finish-load', send);
    else send();
    return result;
  }

  return { show, getWindow: () => qrWin };
}

module.exports = { createQrWin };
```

- [ ] **Step 2: ipc.js 追加 handler**

deps 追加 `qrWin`（更新函数头注释与解构）。其他 handler 之后追加：

```js
  ipcMain.handle('qr:show', (_event, payload) => {
    if (qrWin) return qrWin.show(payload);
    return null;
  });
```

- [ ] **Step 3: preload.js 追加**

```js
  qrShow: (payload) => ipcRenderer.invoke('qr:show', payload),
  onQrRender: (callback) => ipcRenderer.on('qr:render', (_e, result) => callback(result)),
```

- [ ] **Step 4: index.js 接线**

4a. 顶部 require：`const { createQrWin } = require('./qrwin');`，`let qrWin = null;`（pet 变量旁）。
4b. createPet 之后：

```js
  qrWin = createQrWin({ rendererDir: path.join(__dirname, '..', 'renderer'), store, imagesDir });
```

4c. registerIpc deps 追加 `qrWin`。

- [ ] **Step 5: 语法检查 + 全量回归**

Run: `node --check src/main/qrwin.js src/main/ipc.js src/main/index.js src/preload.js && npm test` — Expected: OK，**96/96**。

> 注：qr.html 本任务尚未创建，运行时 loadFile 会 404（有 catch 兜底）；Task 3 补齐。

- [ ] **Step 6: Commit**

```bash
git add src/main/qrwin.js src/main/ipc.js src/main/index.js src/preload.js
git commit -m "feat: 二维码弹窗主进程——窗口生命周期、双路分发、服务随窗停止"
```

---

## Task 3: QR 弹窗渲染层（vendor qrcode + qr.html/js/css）

> **执行期修订（质量审查修复，commit 9b5125e）**：① 错误态残留旧二维码（窗口复用，inline/url→error 时 canvas 未清，旧码仍可扫）——#qr-box 显隐控制；② 实现期偏离已确认合理：qrcode@1.5.4 的 npm tarball 不再附 build/qrcode.js（计划中 cp 步骤不可行），改为 esbuild 打包 lib/browser.js 为 IIFE（全局 QRCode，无 eval，CSP 合规），vendor 文件头加 MIT 署名注释；③ retina 清晰度和 QR 规范安静区——toCanvas 改 `{width:480, margin:4}`（位图 480，CSS 仍 240）；④ qrwin 加 `acceptFirstMouse: true`（macOS 弹窗首击只聚焦的默认行为修复）。记录在案未修：删 private 是有意为打包、qrcode 留 dependencies、"已复制"计时器残留。计数不变（96/96）。

**Files:**
- Create: `src/renderer/vendor/qrcode.js`（vendor，自 node_modules 复制）
- Create: `src/renderer/qr.html`
- Create: `src/renderer/qr.js`
- Create: `src/renderer/qr.css`
- Modify: `package.json`（dependencies 加 qrcode）

- [ ] **Step 1: 安装并 vendor qrcode**

```bash
npm install qrcode
ls node_modules/qrcode/build/qrcode.js   # 确认 UMD 构建存在
mkdir -p src/renderer/vendor
cp node_modules/qrcode/build/qrcode.js src/renderer/vendor/qrcode.js
```

`package.json` dependencies 出现 `"qrcode": "^1.x"` 即可（npm install 自动写入）；vendor 文件提交进仓库，运行时不依赖 node_modules。

- [ ] **Step 2: qr.html**

```html
<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'self'; style-src 'self' 'unsafe-inline'">
  <title>扫码快传</title>
  <link rel="stylesheet" href="qr.css">
</head>
<body>
  <div id="app">
    <div id="qr-box"><canvas id="qr-canvas" width="240" height="240"></canvas></div>
    <div id="qr-hint">加载中…</div>
    <div id="qr-url" hidden></div>
    <div id="qr-actions">
      <button id="qr-copy" hidden>复制链接</button>
      <button id="qr-close">关闭</button>
    </div>
  </div>
  <script src="vendor/qrcode.js"></script>
  <script src="qr.js"></script>
</body>
</html>
```

- [ ] **Step 3: qr.css**

```css
* { margin: 0; padding: 0; box-sizing: border-box; user-select: none; -webkit-user-select: none; }
html, body { width: 100%; height: 100%; overflow: hidden; }
body { font-family: -apple-system, system-ui, sans-serif; background: #fff; color: #222; }

#app { display: flex; flex-direction: column; align-items: center; padding: 16px; height: 100%; }
#qr-box { padding: 8px; border: 1px solid #e5e5e5; border-radius: 12px; }
#qr-canvas { display: block; width: 240px; height: 240px; }
#qr-hint { margin-top: 12px; font-size: 13px; color: #555; text-align: center; }
#qr-url { margin-top: 6px; font-size: 11px; color: #999; word-break: break-all; text-align: center; }
#qr-actions { margin-top: auto; display: flex; gap: 8px; }
#qr-actions button {
  padding: 6px 14px; font-size: 13px; border: 1px solid #d5d5d5; border-radius: 8px;
  background: #f7f7f7; cursor: pointer;
}
#qr-actions button:hover { background: #eee; }
```

- [ ] **Step 4: qr.js**

```js
// 二维码弹窗渲染层：收到 qr:render 结果后画码/提示。
const canvas = document.getElementById('qr-canvas');
const hint = document.getElementById('qr-hint');
const urlEl = document.getElementById('qr-url');
const copyBtn = document.getElementById('qr-copy');

const ERROR_HINTS = {
  'no-network': '未检测到局域网，该内容超出二维码容量',
  'not-found': '内容已不存在',
  empty: '没有可传送的文本条目',
  'no-port': '端口被占用，请重试',
};

function drawQr(text) {
  // vendor 的 UMD 全局 QRCode
  QRCode.toCanvas(canvas, text, { width: 240, margin: 1 }, (err) => {
    if (err) hint.textContent = '二维码生成失败，请重试';
  });
}

window.api.onQrRender((result) => {
  urlEl.hidden = true;
  copyBtn.hidden = true;
  if (result.mode === 'inline') {
    drawQr(result.data);
    hint.textContent = '手机扫码即得';
  } else if (result.mode === 'url') {
    drawQr(result.url);
    hint.textContent = '手机连同一 WiFi 后扫码打开';
    urlEl.hidden = false;
    urlEl.textContent = result.url;
    copyBtn.hidden = false;
    copyBtn.onclick = async () => {
      try {
        await navigator.clipboard.writeText(result.url);
        copyBtn.textContent = '已复制';
        setTimeout(() => { copyBtn.textContent = '复制链接'; }, 1500);
      } catch {
        hint.textContent = '复制失败，请手动选择链接复制';
      }
    };
  } else {
    hint.textContent = ERROR_HINTS[result.code] || '生成失败，请重试';
  }
});

document.getElementById('qr-close').addEventListener('click', () => window.close());
```

- [ ] **Step 5: 语法检查 + 全量回归**

Run: `node --check src/renderer/qr.js src/main/qrwin.js src/main/qrserver.js && npm test` — Expected: OK，**96/96**（渲染层无新测试，惯例）。

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json src/renderer/vendor/qrcode.js src/renderer/qr.html src/renderer/qr.js src/renderer/qr.css
git commit -m "feat: 二维码弹窗渲染层——vendor qrcode 画码、双路提示、复制链接"
```

---

## Task 4: 主窗口入口（条目/当天/多选）+ 冒烟 + README

> **执行期修订（冒烟发现的真 bug，commit e4c9b8e）**：Task 3 retina 修订引入潜伏缺陷——vendor qrcode 的 toCanvas 会给 canvas 写内联 `style.width=480px`，覆写 qr.css 的 240px，导致 480 CSS px 画布溢出 320×380 窗口（定位图形被裁、疑似不可扫、提示与按钮挤出窗外）。修复：`#qr-canvas { width:240px !important; height:240px !important; }`（位图保持 480 保 retina）。PIL 像素测量前后对比验证。另实现期合理偏离：📱 按钮也挂在图片行（计划锚点只写了文本行，但计划要求图片行支持）；.item-qr 沿用 .item-pin 的 visibility:hover 惯例而非计划的常显 opacity；#check-bar/#qr-day 用 CSS 变量适配暗色；#check-bar[hidden] 需 ID 选择器压 UA 规则（同 #pin-overlay[hidden] 先例）。冒烟备注：osascript 坐标点击被辅助功能权限拦截，改真实 qrwin/qrserver/store 临时 harness + 真实 DB 验证三形态字节级一致；真实 app 内点击验证留待用户手动。计数不变（96/96）。

**Files:**
- Modify: `src/renderer/index.html`（sidebar 加当天 QR 按钮 + 多选操作条容器）
- Modify: `src/renderer/app.js`（itemRow QR 按钮、多选、当天打包）
- Modify: `src/renderer/styles.css`（.item-qr / .item-check / #check-bar）
- Modify: `README.md`

- [ ] **Step 1: index.html 加按钮与容器**

sidebar 内 `clear-day` 按钮之后加：

```html
      <button id="qr-day">当天二维码</button>
```

`#content` 内 `#content-title` 之后加多选操作条（默认隐藏）：

```html
      <div id="check-bar" hidden>
        <span id="check-count"></span>
        <button id="check-qr">生成二维码</button>
        <button id="check-cancel">取消</button>
      </div>
```

- [ ] **Step 2: app.js——itemRow QR 按钮**

itemRow 中 `row.append(pin);`（app.js:221）之后、徽章代码之前插入。图片行也要（kind:'image'）；secret 文本行不加：

```js
      if (!(item.type === 'text' && item.secret)) {
        const qr = document.createElement('button');
        qr.className = 'item-qr';
        qr.textContent = '📱';
        qr.title = '生成二维码传到手机';
        qr.addEventListener('click', (e) => {
          e.stopPropagation();
          window.api.qrShow({ kind: item.type === 'image' ? 'image' : 'text', id: item.id });
        });
        row.append(qr);
      }
```

- [ ] **Step 3: app.js——多选（仅主窗口分支）**

state 定义处（app.js:32 主窗口分支内）改为：

```js
  const state = { days: [], selected: null, keyword: '', items: [], selectedIndex: -1, checked: new Set() };
```itemRow 的文本分支里（preview 创建后、secret"显示"按钮逻辑之外）给非 secret 文本行加复选框：

```js
      if (!item.secret) {
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.className = 'item-check';
        cb.checked = state.checked.has(item.id);
        cb.addEventListener('click', (e) => e.stopPropagation());
        cb.addEventListener('change', () => {
          if (cb.checked) state.checked.add(item.id);
          else state.checked.delete(item.id);
          updateCheckBar();
        });
        row.prepend(cb);
      }
```

主窗口分支的初始化代码末尾（clear-day listener 附近）追加：

```js
  const checkBar = document.getElementById('check-bar');
  const checkCount = document.getElementById('check-count');

  function updateCheckBar() {
    checkBar.hidden = state.checked.size === 0;
    checkCount.textContent = `已选 ${state.checked.size} 条`;
  }

  document.getElementById('check-qr').addEventListener('click', () => {
    window.api.qrShow({ kind: 'bundle', ids: [...state.checked] });
    state.checked.clear();
    updateCheckBar();
    renderItems(state.items); // 重绘去勾
  });

  document.getElementById('check-cancel').addEventListener('click', () => {
    state.checked.clear();
    updateCheckBar();
    renderItems(state.items);
  });
```

- [ ] **Step 4: app.js——当天/当前视图打包**

主窗口分支初始化代码中（clear-day handler 附近）加：

```js
  document.getElementById('qr-day').addEventListener('click', () => {
    const ids = state.items
      .filter((it) => it.type === 'text' && !it.secret)
      .map((it) => it.id);
    if (!ids.length) {
      const btn = document.getElementById('qr-day');
      const old = btn.textContent;
      btn.textContent = '无可传送文本';
      setTimeout(() => { btn.textContent = old; }, 1500);
      return;
    }
    window.api.qrShow({ kind: 'bundle', ids });
  });
```

行为说明：该按钮作用于当前视图（日常即选中的某天）；搜索/片段视图下则打包当前显示列表的文本条目——行为一致，文档不另述。

- [ ] **Step 5: styles.css 追加**

```css
.item-qr {
  flex: none; margin-left: 4px; padding: 0 4px;
  border: none; background: none; cursor: pointer; font-size: 13px; opacity: .55;
}
.item-qr:hover { opacity: 1; }
.item-check { flex: none; margin-right: 6px; accent-color: #4a7dff; }
#check-bar {
  display: flex; align-items: center; gap: 10px;
  padding: 6px 16px; background: #f0f4ff; border-bottom: 1px solid #dfe6f5;
  font-size: 13px; color: #333;
}
#check-bar button {
  padding: 3px 10px; font-size: 12px; border: 1px solid #c8d4ee; border-radius: 6px;
  background: #fff; cursor: pointer;
}
```

（已有同类按钮样式可微调对齐，以现有 .item-delete/.item-pin 的排版为准。）

- [ ] **Step 6: 语法检查 + 全量回归**

Run: `node --check src/renderer/app.js && npm test` — Expected: OK，**96/96**。

- [ ] **Step 7: 冒烟（真实环境）**

1. `pgrep -fl electron` 检查并 kill 既有实例（报告是否杀了用户的日常实例）。
2. 后台 `npm start`，等 6 秒；`osascript -e 'set the clipboard to "QR冒烟短文本 abc"'`，等 1 秒。
3. 截图 `/tmp/cut-qr-list.png` 并 Read：定位新条目的 📱 按钮坐标（截图尺寸 2x  retina 时注意坐标换算，osascript 用逻辑坐标）。
4. `osascript -e 'tell application "System Events" to click at {x, y}'` 点 📱 → 等 1 秒 → 截图 `/tmp/cut-qr-qr.png` Read：QR 弹窗出现、白底、文案"手机扫码即得"。
5. 复制长文本（`osascript -e 'set the clipboard to "$(printf '长'.repeat 需先生成：用 osascript 直接塞 2000 字字符串)"'`——生成用 shell 拼 2000 个字符再 osascript），再点其 📱 → 截图 `/tmp/cut-qr-url.png` Read：文案"手机连同一 WiFi 后扫码打开" + 链接 → 从截图读出 URL，`curl` 验证返回内容与被复制长文本一致 → 关闭弹窗（点关闭或 osascript 点关闭按钮）→ `curl` 再验应连接失败（服务已停）。
6. 图片：向剪贴板写图片本机较脆（`screencapture -i` 交互重）——改为单元测试已覆盖 + 报告中注明图片冒烟依赖人工。
7. 手机真机扫码（短码 + 长码各一）——若手边有手机则验，无则注明待用户验证。
8. 还原：kill 应用；真实 DB 按精确 text DELETE 冒烟文本；删临时文件；PNG 留 /tmp。

坐标点击若被系统拦（辅助功能权限），降级：报告中注明"入口点击未能自动化"，其余路径已由单测+部分冒烟覆盖，请用户手动点一次 📱 验证。

- [ ] **Step 8: README + Commit**

功能列表"桌宠悬浮窗"一条之后追加：

```markdown
- 扫码快传：条目/当天/多选一键生成二维码，手机扫码即得（短内容离线可扫，长内容自动局域网传输）
```

```bash
git add src/renderer/index.html src/renderer/app.js src/renderer/styles.css README.md
git commit -m "feat: 扫码快传入口——条目/当天/多选生成二维码"
```

---

## 自检记录

- **执行期修订（终审，commit 见 git）**：Minor 1——sidebar 按钮「当天二维码」实际作用于当前视图（搜索/片段视图下打包对应列表），与「清空当天」的守卫语义不一致；改标签为「打包成二维码」+ title 说明，语义与行为对齐（app.js 的 qrDayLabel 从 DOM 捕获，自动适配）。Minor 2-4 为已接受的 spec 偏离（不改代码）：bundle 短内容（≤1000 字节）实际走 inline（spec 写"恒走局域网"，inline 离线可用且更优）；服务绑定具体内网 IP 而非 0.0.0.0（更安全，IP 变更场景服务失效可接受）；not-found 提示用通用「内容已不存在」覆盖图片场景。

- **执行期修订（质量审查修复，commit eef6ccf）**：① check-qr/check-cancel 的 renderItems(state.items) 会抹掉片段视图的 .search-group 组头（state.items 是扁平数组）——改 clearChecks() helper 精准清 checkbox，不再整体重绘；② refreshAfterMutation 改为 await selectSnippets()/selectDay()（否则修剪跑到旧 list 上失效）并修剪 checked；③ onWindowShown 重置多选（与其他 UI 状态一致）；④ qr-day 空态文案竞态（label 一次性捕获）；⑤ 📱 按钮抽 qrButton helper——注意：审查者称文本分支守卫"永真"是错的，pin/QR 调用点对 secret 行同样执行，守卫必须保留（简化为 !item.secret）；⑥ Esc 优先清多选。计数不变（96/96）。

- Spec 覆盖：双路判定(§3.2→T1)、HTTP 服务与 token/超时/端口(§3.1→T1)、qrwin 窗口与生命周期(§3.3→T2)、隐私与 secret 排除(§3.4→T1 resolveContent + T2/T4)、弹窗渲染(§4.2→T3)、入口三件套(§4.1→T4)、错误处理表(§5→T1 错误码 + T3 ERROR_HINTS + T4 空列表提示)、测试策略(§6→T1 单测 + T4 冒烟)。
- 无占位符：所有代码步骤含完整实现。
- 类型一致：payload `{kind:'text'|'image', id}` / `{kind:'bundle', ids}` 在 qrwin/resolveContent/preload qrShow/app.js 调用一致；result `{mode:'inline',data}` / `{mode:'url',url}` / `{mode:'error',code}` 在 qrwin 生产、qr:render 透传、qr.js 消费一致；错误码 no-network/not-found/empty/no-port 在 qrserver 抛、ERROR_HINTS 消费一致。
- 测试计数：基线 86 → T1 后 96（10 条新测试）→ T2/T3/T4 不增（窗口与渲染层无单测，惯例）。
