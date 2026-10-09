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

// 拖拽 vs 单击（4px 阈值）；仅左键，避免右键菜单同时触发开主窗口
let drag = null;
mascot.addEventListener('mousedown', (e) => {
  if (e.button !== 0) return;
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
