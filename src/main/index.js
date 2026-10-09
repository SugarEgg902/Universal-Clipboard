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
const { looksLikeSecret } = require('./secretDetector');
const privacyConfig = require('./privacyConfig');
const { createPalette } = require('./palette');
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
let store = null;
let watcher = null;
let palette = null;

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
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '打开剪贴板抽屉柜', click: showWindow },
    {
      label: '开机自启',
      type: 'checkbox',
      checked: app.getLoginItemSettings().openAtLogin,
      click: (item) => {
        app.setLoginItemSettings({ openAtLogin: item.checked });
      },
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
  ]));
  if (process.platform !== 'darwin') {
    tray.on('click', showWindow);
  }
}

app.whenReady().then(() => {
  const dbPath = path.join(app.getPath('userData'), 'clipboard.db');
  const imagesDir = path.join(app.getPath('userData'), 'images');
  store = openStore(dbPath, imagesDir);
  privacyConfig.init(app.getPath('userData'));

  palette = createPalette({ rendererDir: path.join(__dirname, '..', 'renderer') });

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
    hideApp: () => app.hide(),
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
        if (privacyConfig.getMode() === 'skip' && looksLikeSecret(String(text).trim())) {
          console.log('[隐私] 已跳过疑似密码内容（完全不记录模式）');
          return;
        }
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

  const paletteRegistered = globalShortcut.register('CommandOrControl+Shift+;', () => palette.show());
  if (!paletteRegistered) console.error('全局快捷键 CommandOrControl+Shift+; 注册失败');

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
