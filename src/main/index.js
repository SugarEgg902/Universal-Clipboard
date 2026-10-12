const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { pathToFileURL } = require('node:url');
const {
  app, BrowserWindow, Tray, Menu, globalShortcut, nativeImage, clipboard, screen,
  protocol, net, dialog,
} = require('electron');
const { openStore } = require('./store');
const { ClipboardWatcher } = require('./watcher');
const { registerIpc } = require('./ipc');
const { looksLikeSecret } = require('./secretDetector');
const privacyConfig = require('./privacyConfig');
const { resolveDataPaths, probeWritable } = require('./storagePath');
const { createPalette } = require('./palette');
const { createPet, buildClipPayload } = require('./pet');
const { createQrWin } = require('./qrwin');
const { startSyncServer } = require('./syncserver');
const { startSyncClient } = require('./syncclient');
const { lanIp } = require('./qrserver');
const paster = require('./paster');

// 缩略图自定义协议：clipimg://thumb/<id>，仅允许返回 images 目录内的图片文件
// （主机名必须为 non-numeric：standard scheme 下纯数字主机会被 Chromium 归一化为 IPv4）
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'clipimg',
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true },
  },
]);

let win = null;
let tray = null;
let trayPetItem = null;
let store = null;
let dataPaths = null;
let watcher = null;
let palette = null;
let pet = null;
let qrWin = null;
let syncHandle = null;
let syncStatus = 'off'; // off | connecting | connected | disconnected | error
let syncTrayStatusItem = null;
let syncConnWin = null;

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
    // setLastSeq 节流：连续补拉时 1s 防抖写盘，stop 时 flush（崩溃丢 lastSeq 有 origin 幂等重放兜底）
    let seqTimer = null;
    let pendingSeq = null;
    const flushSeq = () => {
      if (seqTimer) { clearTimeout(seqTimer); seqTimer = null; }
      if (pendingSeq != null) { privacyConfig.setSync({ lastSeq: pendingSeq }); pendingSeq = null; }
    };
    const client = startSyncClient({
      store, imagesDir: dataPaths.imagesDir, token: s.token, deviceId: s.deviceId,
      hostIp: s.hostIp, hostPort: s.hostPort,
      getLastSeq: () => privacyConfig.getSync().lastSeq,
      setLastSeq: (n) => { pendingSeq = n; if (!seqTimer) seqTimer = setTimeout(flushSeq, 1000); },
      onStatus: (st) => { syncStatus = st; updateSyncTrayStatus(); },
    });
    const origStop = client.stop.bind(client);
    syncHandle = {
      pushLocal: client.pushLocal,
      stop: async () => { flushSeq(); await origStop(); },
    };
  }
}

// 托盘菜单的共享剪贴板分区：按角色返回不同条目（无角色 = 入口两项）
function syncSection() {
  const s = privacyConfig.getSync();
  if (s.role === 'host') {
    const addr = (syncHandle && syncHandle.port)
      ? `${privacyConfig.getSync().hostIp}:${syncHandle.port}` : '启动中…';
    return [
      { label: `共享主机：${addr}`, enabled: false },
      { label: '复制配对码', click: () => clipboard.writeText(privacyConfig.getSync().token || '') },
      { label: '重新生成配对码', click: () => {
          privacyConfig.setSync({ token: crypto.randomBytes(16).toString('hex') });
          startSync();
          createTray();
        } },
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
        privacyConfig.setSync({ role: 'host', token: crypto.randomBytes(16).toString('hex') });
        startSync();
        createTray();
      } },
    { label: '连接共享主机…', click: () => openSyncConnWin() },
  ];
}

// 连接共享主机小窗（仿 qrwin 小窗模式：单例、closed 置 null）
function openSyncConnWin() {
  if (syncConnWin) { syncConnWin.focus(); return; }
  syncConnWin = new BrowserWindow({
    width: 340, height: 260, resizable: false, maximizable: false, minimizable: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  syncConnWin.loadFile(path.join(__dirname, '..', 'renderer', 'syncconn.html'));
  syncConnWin.on('closed', () => { syncConnWin = null; });
}

function createTray() {
  const iconPath = path.join(__dirname, '..', '..', 'assets', 'trayTemplate.png');
  const icon = nativeImage.createFromPath(iconPath);
  if (icon.isEmpty()) console.error('托盘图标加载失败: ' + iconPath);
  if (process.platform === 'darwin') icon.setTemplateImage(true);
  tray = new Tray(icon.isEmpty() ? nativeImage.createEmpty() : icon);
  tray.setToolTip('剪贴板抽屉柜');
  const menu = Menu.buildFromTemplate([
    { label: '打开剪贴板抽屉柜', click: showWindow },
    {
      label: '开机自启',
      type: 'checkbox',
      checked: app.getLoginItemSettings().openAtLogin,
      click: (item) => {
        app.setLoginItemSettings({ openAtLogin: item.checked });
      },
    },
    { type: 'separator' },
    { label: `存储位置：${dataPaths ? dataPaths.effectiveDir : ''}`, enabled: false },
    {
      label: '更改存储位置…',
      click: async () => {
        let res;
        try {
          // Linux 无 zenity/kdialog 时 showOpenDialog 会 reject；兜住避免主进程 unhandled rejection
          res = await dialog.showOpenDialog({
            title: '选择剪贴板数据存储目录',
            properties: ['openDirectory', 'createDirectory'],
          });
        } catch (err) {
          dialog.showErrorBox('无法打开选择对话框', err.message || '系统目录选择对话框不可用');
          return;
        }
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
    ...syncSection(),
    {
      id: 'pet-toggle',
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
    { type: 'separator' },
    { label: '退出', click: () => app.quit() },
  ]);
  // 菜单常驻（非每次 popup 重建），存引用供桌宠右键"禁用桌宠"同步勾选态
  trayPetItem = menu.getMenuItemById('pet-toggle');
  // client 角色的共享状态项同样常驻引用，连接状态变化时原地改 label
  syncTrayStatusItem = menu.getMenuItemById('sync-status');
  updateSyncTrayStatus();
  tray.setContextMenu(menu);
  if (process.platform !== 'darwin') {
    tray.on('click', showWindow);
  }
}

app.whenReady().then(() => {
  const userDataDir = app.getPath('userData');
  privacyConfig.init(userDataDir);
  let paths = resolveDataPaths(userDataDir, privacyConfig.getDataDir());
  try {
    // 自定义目录可能尚不存在（手改 config/目录被删）；先建目录再开库
    fs.mkdirSync(paths.effectiveDir, { recursive: true });
    store = openStore(paths.dbPath, paths.imagesDir);
  } catch (err) {
    // 自定义位置建库失败（只读/磁盘错误等）：回退默认路径，应用照常可用
    console.error('自定义存储位置建库失败，回退默认路径:', err);
    paths = resolveDataPaths(userDataDir, null);
    store = openStore(paths.dbPath, paths.imagesDir);
  }
  dataPaths = paths;
  const imagesDir = dataPaths.imagesDir;
  startSync(); // 按 config 的 sync.role 恢复共享主机/客户端（默认 off 时为空操作）

  palette = createPalette({ rendererDir: path.join(__dirname, '..', 'renderer') });

  pet = createPet({
    rendererDir: path.join(__dirname, '..', 'renderer'),
    getPetConfig: () => privacyConfig.getPet(),
    onMoved: (x, y) => privacyConfig.setPet({ x, y }),
  });

  qrWin = createQrWin({ rendererDir: path.join(__dirname, '..', 'renderer'), store, imagesDir });

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

  registerIpc({
    store,
    getWindow: () => win,
    imagesDir,
    getPaletteWindow: () => palette && palette.getWindow(),
    paster,
    hideApp: process.platform === 'darwin' ? () => app.hide() : null,
    pet,
    showWindow,
    showPalette: () => palette.show(),
    privacyConfig,
    setTrayPetChecked: (checked) => { if (trayPetItem) trayPetItem.checked = checked; },
    qrWin,
    // 连接窗口校验通过后：写配置（切 client 角色）→ 起同步 → 重建托盘菜单
    onSyncConnect: (cfg) => {
      privacyConfig.setSync({ role: 'client', hostIp: cfg.hostIp, hostPort: cfg.hostPort, token: cfg.token });
      startSync();
      createTray();
      return { ok: true };
    },
  });

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
        // 检测器本身不 trim（含空白即不判定是对多行内容的严格排除）；
        // 调用点 trim 以兜住"终端复制带尾换行的密码"这一常见形态。
        const trimmed = String(text).trim();
        const secret = looksLikeSecret(trimmed);
        if (privacyConfig.getMode() === 'skip' && secret) {
          console.log('[隐私] 已跳过疑似密码内容（完全不记录模式）');
          return;
        }
        const id = store.insert(text);
        if (id != null) {
          store.markOrigin(id, privacyConfig.getSync().deviceId);
          if (syncHandle) syncHandle.pushLocal(id);
        }
        if (id != null && pet) {
          pet.notifyClip(buildClipPayload({ kind: 'text', text: trimmed, secret }));
        }
      } catch (err) {
        console.error('剪贴板写入数据库失败:', err);
      }
    },
    onImage: (img) => {
      try {
        const id = store.insertImage(img.buffer, img.width, img.height);
        if (id != null) {
          store.markOrigin(id, privacyConfig.getSync().deviceId);
          if (syncHandle) syncHandle.pushLocal(id);
        }
        if (id != null && pet) {
          pet.notifyClip(buildClipPayload({ kind: 'image', width: img.width, height: img.height }));
        }
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

  const paletteRegistered = globalShortcut.register('CommandOrControl+Shift+;', () => palette.show());
  if (!paletteRegistered) console.error('全局快捷键 CommandOrControl+Shift+; 注册失败');

  if (privacyConfig.getPet().enabled) pet.show();

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
  stopSync();
});
