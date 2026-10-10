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
});
