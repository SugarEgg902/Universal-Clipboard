// 桌宠渲染层：待机状态机 + 冒泡 + 拖拽/单击 + 菜单
window.addEventListener('unhandledrejection', () => {}); // fire-and-forget invoke 的 rejection 不刷屏

const mascot = document.getElementById('mascot');
const zzz = document.getElementById('zzz');
const bubbleLayer = document.getElementById('bubble-layer');

let lastClipAt = Date.now();
let state = 'idle'; // idle | action | hover | sleepy | excited
let actionTimer = null;
let dragging = false; // 拖拽中标记：整体 className 赋值不得剥掉 'dragging'

const IDLE_ACTIONS = ['blink', 'hop', 'look', 'stretch', 'flip', 'shuffle'];
// 每个动作的动画时长（与 pet.css 对齐），播完即移除 class，避免动画结束到移除之间的僵直空窗
const ACTION_MS = { blink: 500, hop: 600, flip: 800, look: 3000, stretch: 3200, shuffle: 3000 };
const SLEEPY_AFTER = 30 * 60 * 1000;

function applyClass(stateClass) {
  mascot.className = (dragging ? 'dragging ' : '') + stateClass;
}

function setState(next) {
  if (state === 'excited' && next !== 'idle') return; // excited 播完再切换
  state = next;
  applyClass(next === 'action' ? '' : next);
  zzz.hidden = next !== 'sleepy';
}

// 动作/excited 结束回退：指针仍悬在吉祥物上时回 hover 而非 idle
function backToIdle() {
  const hovered = mascot.matches(':hover');
  state = hovered ? 'hover' : 'idle';
  applyClass(hovered ? 'hover' : 'idle');
  zzz.hidden = true;
}

function playAction() {
  scheduleAction(); // 无论本轮是否播放都重新排程，否则 timer 在 sleepy/excited/hover 期间触发后调度永久死亡
  if (state !== 'idle') return;
  const name = IDLE_ACTIONS[Math.floor(Math.random() * IDLE_ACTIONS.length)];
  state = 'action';
  mascot.classList.add(name);
  setTimeout(() => {
    mascot.classList.remove(name);
    if (state === 'action') backToIdle();
  }, ACTION_MS[name]);
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
    applyClass('excited');
    setTimeout(() => {
      if (state !== 'excited') return; // 已被其他路径切换则不强行回退
      backToIdle();
    }, 950);
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

// 拖拽 vs 单击（4px 阈值）；Pointer Events + 指针捕获，窗口外松手也能收尾
// 仅左键，避免右键菜单同时触发开主窗口
let drag = null;
mascot.addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return;
  mascot.setPointerCapture(e.pointerId);
  drag = { x: e.screenX, y: e.screenY, moved: false };
  dragging = true;
  mascot.classList.add('dragging');
});
window.addEventListener('pointermove', (e) => {
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
window.addEventListener('pointerup', (e) => {
  if (!drag) return;
  if (e.button !== 0) return; // 左键按住时抬起右键不算结束
  dragging = false;
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
