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
  if (icon.isEmpty()) console.error('托盘图标加载失败: ' + iconPath);
  if (process.platform === 'darwin') icon.setTemplateImage(true);
  tray = new Tray(icon.isEmpty() ? nativeImage.createEmpty() : icon);
  tray.setToolTip('剪贴板抽屉柜');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '打开剪贴板抽屉柜', click: showWindow },
    { type: 'separator' },
    { label: '退出', click: () => app.quit() },
  ]));
  if (process.platform !== 'darwin') {
    tray.on('click', showWindow);
  }
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
