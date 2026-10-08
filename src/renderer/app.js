window.addEventListener('unhandledrejection', (e) => console.error('IPC 调用失败:', e.reason));

const state = { days: [], selected: null, keyword: '' };

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
  const items = await window.api.listByDay(dateKey);
  titleEl.textContent = `${labelFor(dateKey)} · ${items.length} 条`;
  renderItems(items);
}

function renderItems(items) {
  itemsEl.innerHTML = '';
  if (!items.length) {
    itemsEl.innerHTML = '<div class="empty">暂无剪贴记录</div>';
    return;
  }
  for (const item of items) itemsEl.appendChild(itemRow(item));
}

function itemRow(item) {
  const row = document.createElement('div');
  row.className = 'item';

  const time = document.createElement('span');
  time.className = 'item-time';
  time.textContent = formatTime(item.created_at);

  const preview = document.createElement('span');
  preview.className = 'item-text';
  preview.textContent = truncate(item.text);
  preview.title = item.text;
  preview.addEventListener('click', () => window.api.copyClip(item.id));

  const del = document.createElement('button');
  del.className = 'item-delete';
  del.textContent = '×';
  del.title = '删除该条';
  del.addEventListener('click', async (e) => {
    e.stopPropagation();
    await window.api.deleteClip(item.id);
    refreshAfterMutation();
  });

  row.append(time, preview, del);
  return row;
}

async function refreshAfterMutation() {
  if (state.keyword) {
    await doSearch();
  } else if (state.selected) {
    await refreshDays();
    selectDay(state.selected);
  }
}

async function doSearch() {
  renderDrawers();
  const rows = await window.api.search(state.keyword);
  titleEl.textContent = `搜索“${state.keyword}” · ${rows.length} 条`;
  itemsEl.innerHTML = '';
  if (!rows.length) {
    itemsEl.innerHTML = '<div class="empty">没有匹配的记录</div>';
    return;
  }
  const groups = new Map();
  for (const r of rows) {
    const key = toDateKey(r.created_at);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }
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

window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') window.api.hideWindow();
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
