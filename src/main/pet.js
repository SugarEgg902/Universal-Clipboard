// 桌宠：常驻迷你窗口（无边框透明，不抢焦点，floating 置顶不压全屏）。
// 复刻 palette.js 管理模式：lazy create、closed 置 null、show() 重建。

const path = require('node:path');
const { BrowserWindow, screen } = require('electron');

const WIN_W = 200;
const WIN_H = 260;
// 透明区域点击穿透仅用于 macOS/Windows：Linux 不支持 forward 选项
// （ignore 后渲染层收不到移动事件，无法检测光标回到吉祥物上，会永久失去交互），
// 且 X11 下透明窗口本就以 alpha 通道决定输入形状，透明像素天然穿透。
const CLICK_THROUGH = process.platform === 'darwin' || process.platform === 'win32';

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
    // 24：默认角落距屏幕右/下缘的留边像素
    const defX = display.bounds.width - WIN_W - 24;
    const defY = display.bounds.height - WIN_H - 24;
    let x = defX;
    let y = defY;
    if (cfg.x != null && cfg.y != null) {
      x = cfg.x;
      y = cfg.y;
      // 校验保存的位置仍落在某块已连接显示器的可见区内，否则回退默认角落
      // （拔掉副屏后避免桌宠出现在屏外且无恢复路径）
      const b = screen.getDisplayNearestPoint({ x, y }).bounds;
      const visible = x >= b.x - WIN_W + 40 && x <= b.x + b.width - 40 && y >= b.y && y <= b.y + b.height - 40;
      if (!visible) { x = defX; y = defY; }
    }
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
    // 初始即穿透：200×260 窗口里只有 64×64 的吉祥物可交互，其余透明区域
    // 必须把点击让给下层窗口（否则桌宠周围一圈"点击没有反应"）。
    // 渲染层靠 forward 过来的移动事件做悬停检测，光标到吉祥物上时再关穿透。
    if (CLICK_THROUGH) petWin.setIgnoreMouseEvents(true, { forward: true });
    // 页面加载完成后回填已持久化的形象（pet.html 硬编码默认 📦；
    // 重建窗口也走 create()，此路径同时覆盖）
    petWin.webContents.on('did-finish-load', () => {
      petWin.webContents.send('pet:emoji', cfg.emoji);
    });
    petWin.loadFile(path.join(rendererDir, 'pet.html')).catch((err) => console.error('桌宠页面加载失败:', err));
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

  // 渲染层拖拽增量（dx,dy 可为负）；按当前位置最近的显示器钳制
  function applyDrag(dx, dy) {
    if (!petWin) return;
    const [cx, cy] = petWin.getPosition();
    const d = screen.getDisplayNearestPoint({ x: cx, y: cy }).bounds;
    // 40：钳制边距，保证至少 40px 留在屏内可被抓回。
    // x 轴下界为 d.x - WIN_W + 40（允许宠物大部分悬在左缘外），与 y 轴不允许越顶不对称——有意设计：
    // 贴左缘收纳是常见用法，而顶缘之上无法点击且无收纳价值。
    const nx = Math.min(Math.max(cx + dx, d.x - WIN_W + 40), d.x + d.width - 40);
    const ny = Math.min(Math.max(cy + dy, d.y), d.y + d.height - 40);
    // 必须取整：真实鼠标坐标是小数，setPosition 收到小数会被 Electron 参数校验
    // 拒绝（conversion failure）静默丢弃——渲染层 unhandledrejection 兜底不报错，
    // 表现为"拖拽完全没反应"。
    petWin.setPosition(Math.round(nx), Math.round(ny));
  }

  function persistPosition() {
    if (!petWin || !onMoved) return;
    const [x, y] = petWin.getPosition();
    onMoved(x, y);
  }

  function notifyClip(payload) {
    if (petWin) petWin.webContents.send('pet:clip', payload);
  }

  // 渲染层悬停检测后回调：ignore=true 透明区穿透，false 恢复交互（吉祥物上）。
  // 每次 ignore 都要重传 forward:true（该选项不随调用记忆）。
  function setIgnoreMouse(ignore) {
    if (petWin && CLICK_THROUGH) petWin.setIgnoreMouseEvents(ignore, { forward: true });
  }

  function setEmoji(emoji) {
    if (petWin) petWin.webContents.send('pet:emoji', emoji);
  }

  function getWindow() {
    return petWin;
  }

  return { show, hide, applyDrag, persistPosition, notifyClip, setEmoji, setIgnoreMouse, getWindow };
}

module.exports = { createPet, buildClipPayload };
