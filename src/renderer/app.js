window.addEventListener('unhandledrejection', (e) => console.error('IPC 调用失败:', e.reason));

const state = { days: [], selected: null, keyword: '', items: [], selectedIndex: -1 };

const drawersEl = document.getElementById('drawers');
const itemsEl = document.getElementById('items');
const titleEl = document.getElementById('content-title');
const searchEl = document.getElementById('search');
const clearBtn = document.getElementById('clear-day');

function toDateKey(ts) {
  const d = new Date(ts);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function formatTime(ts) {
  const d = new Date(ts);
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function truncate(text, max = 80) {
  return text.length > max ? text.slice(0, max) + '…' : text;
}

// 7 天外日期的搜索分组回退为 dateKey 本身
function labelFor(dateKey) {
  const found = state.days.find((d) => d.dateKey === dateKey);
  return found ? found.label : dateKey;
}

function renderDrawers() {
  drawersEl.innerHTML = '';
  for (const day of state.days) {
    const btn = document.createElement('button');
    btn.className = 'drawer' + (state.selected === day.dateKey && !state.keyword ? ' active' : '');
    const label = document.createElement('span');
    label.className = 'drawer-label';
    label.textContent = day.label;
    const count = document.createElement('span');
    count.className = 'drawer-count';
    count.textContent = day.count;
    btn.append(label, count);
    btn.addEventListener('click', () => selectDay(day.dateKey));
    drawersEl.appendChild(btn);
  }
}

async function refreshDays() {
  state.days = await window.api.listDays();
  renderDrawers();
}

async function selectDay(dateKey) {
  state.selected = dateKey;
  state.keyword = '';
  searchEl.value = '';
  renderDrawers();
  state.selectedIndex = -1;
  const items = await window.api.listByDay(dateKey);
  titleEl.textContent = `${labelFor(dateKey)} · ${items.length} 条`;
  renderItems(items);
}

function renderItems(items) {
  state.items = items;
  if (state.selectedIndex >= items.length) state.selectedIndex = items.length - 1;
  itemsEl.innerHTML = '';
  if (!items.length) {
    itemsEl.innerHTML = '<div class="empty">暂无剪贴记录</div>';
    return;
  }
  for (let i = 0; i < items.length; i++) {
    const row = itemRow(items[i]);
    if (i === state.selectedIndex) row.classList.add('selected');
    itemsEl.appendChild(row);
  }
}

function itemRow(item) {
  const row = document.createElement('div');
  row.className = 'item';

  const time = document.createElement('span');
  time.className = 'item-time';
  time.textContent = formatTime(item.created_at);

  if (item.type === 'image') {
    const thumb = document.createElement('img');
    thumb.className = 'item-thumb';
    thumb.src = item.thumb;
    thumb.alt = '';
    thumb.addEventListener('error', () => thumb.replaceWith(imageLabel(item)));
    thumb.addEventListener('click', () => window.api.copyClip(item.id));
    row.append(time, thumb);
  } else {
    const preview = document.createElement('span');
    preview.className = 'item-text';
    preview.textContent = truncate(item.text);
    preview.title = item.text;
    preview.addEventListener('click', () => window.api.copyClip(item.id));
    row.append(time, preview);
  }

  const del = document.createElement('button');
  del.className = 'item-delete';
  del.textContent = '×';
  del.title = '删除该条';
  del.addEventListener('click', async (e) => {
    e.stopPropagation();
    await window.api.deleteClip(item.id);
    refreshAfterMutation();
  });

  row.append(del);
  return row;
}

// 缩略图加载失败（文件缺失）时的占位
function imageLabel(item) {
  const label = document.createElement('span');
  label.className = 'item-text';
  label.textContent = `🖼 图片 · ${item.width}×${item.height}`;
  label.addEventListener('click', () => window.api.copyClip(item.id));
  return label;
}

async function refreshAfterMutation() {
  if (state.keyword) {
    await Promise.all([doSearch(), refreshDays()]);
  } else if (state.selected) {
    await refreshDays();
    selectDay(state.selected);
  }
}

async function doSearch() {
  state.selectedIndex = -1;
  renderDrawers();
  const rows = await window.api.search(state.keyword);
  titleEl.textContent = `搜索“${state.keyword}” · ${rows.length} 条`;
  itemsEl.innerHTML = '';
  if (!rows.length) {
    state.items = [];
    itemsEl.innerHTML = '<div class="empty">没有匹配的记录</div>';
    return;
  }
  const groups = new Map();
  for (const r of rows) {
    const key = toDateKey(r.created_at);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }
  // 扁平数组，顺序与下方分组渲染的文档顺序一致（供 Enter 复制按索引取数据）
  state.items = [];
  for (const group of groups.values()) state.items.push(...group);
  for (const [key, group] of groups) {
    const h = document.createElement('div');
    h.className = 'search-group';
    h.textContent = `${labelFor(key)} · ${group.length} 条`;
    itemsEl.appendChild(h);
    for (const item of group) itemsEl.appendChild(itemRow(item));
  }
}

searchEl.addEventListener('input', () => {
  state.keyword = searchEl.value.trim();
  if (state.keyword) doSearch();
  else if (state.selected) selectDay(state.selected);
});

clearBtn.addEventListener('click', async () => {
  if (!state.selected || state.keyword) return;
  await window.api.clearDay(state.selected);
  await refreshDays();
  selectDay(state.selected);
});

function moveSelection(delta) {
  const n = state.items.length;
  if (!n) return;
  state.selectedIndex = Math.min(Math.max(state.selectedIndex + delta, 0), n - 1);
  updateSelectionHighlight();
}

function updateSelectionHighlight() {
  const rows = itemsEl.querySelectorAll('.item');
  rows.forEach((el, i) => el.classList.toggle('selected', i === state.selectedIndex));
  const el = rows[state.selectedIndex];
  if (el) el.scrollIntoView({ block: 'nearest' });
}

function clearSearch() {
  searchEl.value = '';
  state.keyword = '';
  if (state.selected) selectDay(state.selected);
}

window.addEventListener('keydown', (e) => {
  const mod = e.metaKey || e.ctrlKey;

  if (mod && e.key.toLowerCase() === 'k') {
    e.preventDefault();
    searchEl.focus();
    searchEl.select();
    return;
  }

  if (e.key === 'Escape') {
    if (document.activeElement === searchEl && searchEl.value) {
      e.preventDefault();
      clearSearch();
      return;
    }
    if (state.keyword) {
      clearSearch();
      return;
    }
    window.api.hideWindow();
    return;
  }

  if (document.activeElement === searchEl) {
    // 输入框内：可打字、↑↓ 交给列表导航、Enter 复制选中项（无选中则惰性）
    if (e.key === 'Enter') {
      if (state.selectedIndex >= 0) {
        e.preventDefault();
        const item = state.items[state.selectedIndex];
        if (item) window.api.copyClip(item.id);
      }
      return;
    }
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
  }

  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    moveSelection(e.key === 'ArrowDown' ? 1 : -1);
    return;
  }

  if (e.key === 'Enter' && state.selectedIndex >= 0) {
    e.preventDefault();
    const item = state.items[state.selectedIndex];
    if (item) window.api.copyClip(item.id);
  }
});

// 窗口每次显示时重置到"今天"并聚焦搜索框
window.api.onWindowShown(() => {
  searchEl.value = '';
  state.keyword = '';
  refreshDays().then(() => {
    if (state.days.length) selectDay(state.days[0].dateKey);
  });
  searchEl.focus();
});

refreshDays().then(() => {
  if (state.days.length) selectDay(state.days[0].dateKey);
});
