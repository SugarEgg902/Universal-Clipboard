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
