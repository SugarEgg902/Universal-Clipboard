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
