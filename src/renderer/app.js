window.addEventListener('unhandledrejection', (e) => console.error('IPC 调用失败:', e.reason));

// 以下常量与纯函数两个模式共用（提升到分流之前，避免 TDZ/Annex B 提升陷阱）
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

// 快速粘贴面板模式：?palette=1 时整页切换为迷你面板，主窗口逻辑不执行
const IS_PALETTE = new URLSearchParams(location.search).get('palette') === '1';
if (IS_PALETTE) {
  initPalette();
} else {
  // ===== 主窗口逻辑 =====
  const state = { days: [], selected: null, keyword: '', items: [], selectedIndex: -1, checked: new Set() };

  const SNIPPETS_KEY = '__snippets__';
  state.snippetGroups = [];
  state.snippetCount = 0;

  // 7 天外日期的搜索分组回退为 dateKey 本身
  function labelFor(dateKey) {
    const found = state.days.find((d) => d.dateKey === dateKey);
    return found ? found.label : dateKey;
  }

  function renderDrawers() {
    drawersEl.innerHTML = '';
    const snip = document.createElement('button');
    snip.className = 'drawer snippets-drawer' + (state.selected === SNIPPETS_KEY && !state.keyword ? ' active' : '');
    const snipLabel = document.createElement('span');
    snipLabel.className = 'drawer-label';
    snipLabel.textContent = '片段';
    const snipCount = document.createElement('span');
    snipCount.className = 'drawer-count';
    snipCount.textContent = state.snippetCount;
    snip.append(snipLabel, snipCount);
    snip.addEventListener('click', () => selectSnippets());
    drawersEl.appendChild(snip);
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
    const [days, groups] = await Promise.all([window.api.listDays(), window.api.listSnippets()]);
    state.days = days;
    state.snippetGroups = groups;
    state.snippetCount = groups.reduce((n, g) => n + g.items.length, 0);
    renderDrawers();
  }

  async function selectDay(dateKey) {
    state.selected = dateKey;
    state.keyword = '';
    searchEl.value = '';
    renderDrawers();
    clearBtn.disabled = false;
    state.selectedIndex = -1;
    const items = await window.api.listByDay(dateKey);
    titleEl.textContent = `${labelFor(dateKey)} · ${items.length} 条`;
    renderItems(items);
  }

  async function selectSnippets() {
    state.selected = SNIPPETS_KEY;
    state.keyword = '';
    searchEl.value = '';
    renderDrawers();
    state.selectedIndex = -1;
    clearBtn.disabled = true;
    const groups = await window.api.listSnippets();
    state.snippetGroups = groups;
    state.snippetCount = groups.reduce((n, g) => n + g.items.length, 0);
    const total = groups.reduce((n, g) => n + g.items.length, 0);
    titleEl.textContent = `📌 片段 · ${total} 条`;
    itemsEl.innerHTML = '';
    if (!total) {
      state.items = [];
      itemsEl.innerHTML = '<div class="empty">还没有片段：在任意文本条目上点 📌 即可创建</div>';
      return;
    }
    state.items = [];
    for (const g of groups) {
      const h = document.createElement('div');
      h.className = 'search-group';
      h.textContent = `${g.name} · ${g.items.length} 条`;
      itemsEl.appendChild(h);
      for (const item of g.items) {
        state.items.push(item);
        itemsEl.appendChild(itemRow(item));
      }
    }
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
      row.append(qrButton(item));
    } else {
      const preview = document.createElement('span');
      preview.className = 'item-text';
      if (item.secret) {
        preview.classList.add('item-secret-mask');
        preview.textContent = '••••••••••';
        preview.title = '已隐藏的密码条目';
      } else {
        const text = item.text;
        let hlPos = -1;
        if (
          item.match_kind === 'substring' &&
          item.match_pos != null &&
          item.match_len != null &&
          text.length <= 200 // 超长文本不做高亮（截断窗口外的坐标无意义）
        ) {
          hlPos = item.match_pos;
        }
        if (hlPos >= 0) {
          const CONTEXT = 30;
          const winStart = Math.max(0, hlPos - CONTEXT);
          const before = document.createElement('span');
          before.textContent = (winStart > 0 ? '…' : '') + text.slice(winStart, hlPos);
          const hit = document.createElement('mark');
          hit.textContent = text.slice(hlPos, hlPos + item.match_len);
          const afterText = text.slice(hlPos + item.match_len);
          const after = document.createElement('span');
          after.textContent = truncate(afterText, CONTEXT); // truncate 自带截断省略号
          preview.append(before, hit, after);
          preview.title = text;
        } else {
          preview.textContent = truncate(text);
          preview.title = text;
        }
      }
      preview.addEventListener('click', () => window.api.copyClip(item.id));
      row.append(time, preview);

      if (!item.secret) {
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.className = 'item-check';
        cb.checked = state.checked.has(item.id);
        cb.addEventListener('click', (e) => e.stopPropagation());
        cb.addEventListener('change', () => {
          if (cb.checked) state.checked.add(item.id);
          else state.checked.delete(item.id);
          updateCheckBar();
        });
        row.prepend(cb);
      }

      if (item.secret) {
        const show = document.createElement('button');
        show.className = 'item-secret-show';
        show.textContent = '显示';
        show.addEventListener('click', (e) => {
          e.stopPropagation();
          if (show.textContent === '显示') {
            preview.textContent = truncate(item.text, 120);
            preview.title = item.text;
            preview.classList.remove('item-secret-mask');
            show.textContent = '隐藏';
          } else {
            preview.textContent = '••••••••••';
            preview.title = '已隐藏的密码条目';
            preview.classList.add('item-secret-mask');
            show.textContent = '显示';
          }
        });
        row.append(show);
      }

      // 手动打码开关：自动判不准时一次点击永久纠正。
      // 点击翻转当前生效状态（打码↔明文），已强制的条目再点一次恢复自动。
      const st = document.createElement('button');
      const forced = item.force_secret != null;
      st.className = 'item-secret-toggle' + (forced ? ' forced' : '');
      st.textContent = item.secret ? '🔒' : '🔓';
      st.title = forced
        ? (item.force_secret ? '已强制打码，点击恢复自动识别' : '已强制明文，点击恢复自动识别')
        : (item.secret ? '自动识别为密码，点击改为强制明文' : '未识别为密码，点击标为密码（打码）');
      st.addEventListener('click', async (e) => {
        e.stopPropagation();
        const next = item.force_secret == null ? (item.secret ? 0 : 1) : null;
        await window.api.setSecret(item.id, next);
        refreshAfterMutation();
      });
      row.append(st);

      const pin = document.createElement('button');
      pin.className = 'item-pin' + (item.pinned ? ' pinned' : '');
      pin.textContent = '📌';
      pin.title = item.pinned ? '修改/取消 Pin' : 'Pin 成片段';
      pin.addEventListener('click', (e) => {
        e.stopPropagation();
        openPinForm(item);
      });
      row.append(pin);

      if (!item.secret) row.append(qrButton(item));

      if (item.pinned && item.trigger_word) {
        const badge = document.createElement('span');
        badge.className = 'item-trigger';
        badge.textContent = `⌁ ${item.trigger_word}`;
        row.append(badge);
      }

      if (item.match_kind === 'pinyin') {
        const badge = document.createElement('span');
        badge.className = 'item-match-badge';
        badge.textContent = '拼音命中';
        row.append(badge);
      } else if (item.match_kind === 'fuzzy') {
        const badge = document.createElement('span');
        badge.className = 'item-match-badge';
        badge.textContent = '模糊命中';
        row.append(badge);
      }
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

  // 条目 QR 按钮：文本行（非密码）与图片行都挂；点击唤起二维码弹窗
  function qrButton(item) {
    const qr = document.createElement('button');
    qr.className = 'item-qr';
    qr.textContent = '📱';
    qr.title = '生成二维码传到手机';
    qr.addEventListener('click', (e) => {
      e.stopPropagation();
      window.api.qrShow({ kind: item.type === 'image' ? 'image' : 'text', id: item.id });
    });
    return qr;
  }

  // ---- Pin 表单弹层 ----
  const pinOverlay = document.createElement('div');
  pinOverlay.id = 'pin-overlay';
  pinOverlay.hidden = true;
  pinOverlay.innerHTML = `
  <div id="pin-form">
    <h3>Pin 成片段</h3>
    <label>触发词（可选，输入面板里敲这个词快速找到）
      <input id="pin-trigger" type="text" placeholder="如 addr" maxlength="32">
    </label>
    <label>分组（可选）
      <input id="pin-group" type="text" placeholder="如 工作" maxlength="32">
    </label>
    <p id="pin-error"></p>
    <div id="pin-buttons">
      <button type="button" id="pin-cancel">取消</button>
      <button type="button" id="pin-confirm" class="primary">确定</button>
      <button type="button" id="pin-remove">取消 Pin</button>
    </div>
  </div>`;
  document.body.appendChild(pinOverlay);

  let pinTargetId = null;

  function openPinForm(item) {
    pinTargetId = item.id;
    document.getElementById('pin-trigger').value = item.trigger_word || '';
    document.getElementById('pin-group').value = item.group_name || '';
    document.getElementById('pin-error').textContent = '';
    document.getElementById('pin-remove').style.display = item.pinned ? '' : 'none';
    pinOverlay.hidden = false;
    document.getElementById('pin-trigger').focus();
  }

  function closePinForm() {
    pinOverlay.hidden = true;
    pinTargetId = null;
  }

  document.getElementById('pin-cancel').addEventListener('click', closePinForm);
  pinOverlay.addEventListener('click', (e) => { if (e.target === pinOverlay) closePinForm(); });

  document.getElementById('pin-remove').addEventListener('click', async () => {
    if (pinTargetId == null) return;
    await window.api.unpinClip(pinTargetId);
    closePinForm();
    refreshAfterMutation();
  });

  document.getElementById('pin-confirm').addEventListener('click', async () => {
    if (pinTargetId == null) return;
    const trigger = document.getElementById('pin-trigger').value.trim();
    const group = document.getElementById('pin-group').value.trim();
    const res = await window.api.pinClip(pinTargetId, trigger || null, group || null);
    if (!res.ok) {
      document.getElementById('pin-error').textContent = res.error || '保存失败';
      return;
    }
    closePinForm();
    refreshAfterMutation();
  });

  async function refreshAfterMutation() {
    if (state.selected === SNIPPETS_KEY && !state.keyword) {
      await refreshDays();
      await selectSnippets();
    } else if (state.keyword) {
      await Promise.all([doSearch(), refreshDays()]);
    } else if (state.selected) {
      await refreshDays();
      await selectDay(state.selected);
    }
    // 删除/清空后修剪多选：已消失的 id 不再残留计数
    state.checked = new Set([...state.checked].filter((id) => state.items.some((it) => it.id === id)));
    if (typeof updateCheckBar === 'function') updateCheckBar();
  }

  async function doSearch() {
    state.selectedIndex = -1;
    renderDrawers();
    const rows = await window.api.search(state.keyword);
    titleEl.textContent = `搜索“${state.keyword}” · ${rows.length} 条`;
    itemsEl.innerHTML = '';
    state.items = rows; // IPC 已按评分排序，DOM 顺序与之一致（Enter 复制按索引取数据）
    if (!rows.length) {
      itemsEl.innerHTML = '<div class="empty">没有匹配的记录</div>';
      return;
    }
    for (const item of rows) itemsEl.appendChild(itemRow(item));
  }

  let searchTimer = null;
  searchEl.addEventListener('input', () => {
    state.keyword = searchEl.value.trim();
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      if (state.keyword) doSearch();
      else if (state.selected === SNIPPETS_KEY) selectSnippets();
      else if (state.selected) selectDay(state.selected);
    }, 150);
  });

  clearBtn.addEventListener('click', async () => {
    if (state.selected === SNIPPETS_KEY) return;
    if (!state.selected || state.keyword) return;
    await window.api.clearDay(state.selected);
    await refreshDays();
    selectDay(state.selected);
    // 清空当天后多选一并失效，立即重置操作条（绕过了 refreshAfterMutation 的修剪）
    state.checked.clear();
    updateCheckBar();
  });

  // ---- 扫码快传：多选操作条与当天打包 ----
  const checkBar = document.getElementById('check-bar');
  const checkCount = document.getElementById('check-count');

  function updateCheckBar() {
    checkBar.hidden = state.checked.size === 0;
    checkCount.textContent = `已选 ${state.checked.size} 条`;
  }

  // 清空多选：同步清掉所有复选框的勾（不重绘列表——重绘会抹掉片段视图的组头）
  function clearChecks() {
    state.checked.clear();
    updateCheckBar();
    itemsEl.querySelectorAll('.item-check').forEach((cb) => { cb.checked = false; });
  }

  document.getElementById('check-qr').addEventListener('click', () => {
    const ids = [...state.checked];
    window.api.qrShow({ kind: 'bundle', ids });
    clearChecks();
  });

  document.getElementById('check-cancel').addEventListener('click', () => {
    clearChecks();
  });

  const qrDayLabel = document.getElementById('qr-day').textContent;
  document.getElementById('qr-day').addEventListener('click', () => {
    const ids = state.items
      .filter((it) => it.type === 'text' && !it.secret)
      .map((it) => it.id);
    if (!ids.length) {
      const btn = document.getElementById('qr-day');
      btn.textContent = '无可传送文本';
      setTimeout(() => { btn.textContent = qrDayLabel; }, 1500);
      return;
    }
    window.api.qrShow({ kind: 'bundle', ids });
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
    clearTimeout(searchTimer);
    searchEl.value = '';
    state.keyword = '';
    if (state.selected === SNIPPETS_KEY) selectSnippets();
    else if (state.selected) selectDay(state.selected);
  }

  window.addEventListener('keydown', (e) => {
    const mod = e.metaKey || e.ctrlKey;

    if (!pinOverlay.hidden) {
      if (e.key === 'Escape') { closePinForm(); return; }
      if (e.key === 'Enter' && (document.activeElement.id === 'pin-trigger' || document.activeElement.id === 'pin-group')) {
        e.preventDefault();
        document.getElementById('pin-confirm').click();
        return;
      }
      return;
    }

    if (mod && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      searchEl.focus();
      searchEl.select();
      return;
    }

    if (e.key === 'Escape') {
      if (state.checked.size > 0) {
        clearChecks(); // 有选择时 Esc 只清多选，不清搜索不藏窗
        return;
      }
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
    clearTimeout(searchTimer);
    searchEl.value = '';
    state.keyword = '';
    state.checked.clear(); // 多选与其他 UI 状态一致随窗重置（列表随后重绘为无勾）
    if (typeof updateCheckBar === 'function') updateCheckBar();
    refreshDays().then(() => {
      if (state.days.length) selectDay(state.days[0].dateKey);
    });
    searchEl.focus();
  });

  refreshDays().then(() => {
    if (state.days.length) selectDay(state.days[0].dateKey);
  });
}

// initPalette 函数声明放在文件最末尾（函数声明提升，顶部调用安全）
function initPalette() {
  document.body.classList.add('palette');
  document.getElementById('content').insertBefore(searchEl, titleEl);
  searchEl.placeholder = '输入触发词或内容过滤…';
  const hint = document.createElement('div');
  hint.id = 'palette-hint';
  hint.hidden = true;
  document.body.appendChild(hint);
  let hintTimer = null;

  const pState = { groups: [], items: [], shown: [], selectedIndex: -1, keyword: '' };

  async function load() {
    pState.groups = await window.api.listSnippets();
    pState.items = pState.groups.flatMap((g) => g.items).filter((it) => it.type === 'text');
    render();
  }

  function render() {
    pState.selectedIndex = -1;
    const q = pState.keyword.toLowerCase();
    let shown = pState.items;
    if (q) {
      const byTrigger = pState.items.filter(
        (it) => it.trigger_word && it.trigger_word.toLowerCase().startsWith(q)
      );
      const byText = pState.items.filter(
        (it) => !(it.trigger_word && it.trigger_word.toLowerCase().startsWith(q)) &&
          it.text.toLowerCase().includes(q)
      );
      shown = [...byTrigger, ...byText];
    }
    pState.shown = shown;
    titleEl.textContent = q
      ? `片段 · ${shown.length}/${pState.items.length} 条`
      : `📌 片段 · ${pState.items.length} 条（↑↓ 选择，Enter 粘贴）`;
    itemsEl.innerHTML = '';
    if (!shown.length) {
      itemsEl.innerHTML = '<div class="empty">没有匹配的片段<br>在主窗口里对文本条目点 📌 创建</div>';
      return;
    }
    for (const item of shown) itemsEl.appendChild(paletteRow(item));
  }

  function paletteRow(item) {
    const row = document.createElement('div');
    row.className = 'item';
    const preview = document.createElement('span');
    preview.className = 'item-text';
    preview.textContent = item.secret ? '••••••••（密码条目）' : truncate(item.text, 90);
    preview.addEventListener('click', () => paste(item.id));
    row.append(preview);
    if (item.trigger_word) {
      const badge = document.createElement('span');
      badge.className = 'item-trigger';
      badge.textContent = `⌁ ${item.trigger_word}`;
      row.append(badge);
    }
    return row;
  }

  async function paste(id) {
    const res = await window.api.pasteSnippet(id);
    if (!res || !res.ok) {
      if (res && (res.error === 'not-found' || res.error === 'unsupported-type')) {
        hint.textContent = '该片段已不存在或类型不支持，请重新打开面板';
      } else if (res && res.error === 'paste-failed') {
        hint.textContent = '已复制到剪贴板，但模拟粘贴失败——请到 系统设置 → 隐私与安全性 → 辅助功能 授权后手动 Cmd+V';
      } else {
        hint.textContent = '已复制到剪贴板，请手动粘贴（Cmd/Ctrl+V）';
      }
      hint.hidden = false;
      clearTimeout(hintTimer);
      hintTimer = setTimeout(() => { hint.hidden = true; }, 5000);
    }
  }

  function move(delta) {
    const rows = itemsEl.querySelectorAll('.item');
    if (!rows.length) return;
    pState.selectedIndex = Math.min(
      Math.max(pState.selectedIndex + delta, 0), rows.length - 1
    );
    rows.forEach((el, i) => el.classList.toggle('selected', i === pState.selectedIndex));
    rows[pState.selectedIndex].scrollIntoView({ block: 'nearest' });
  }

  searchEl.addEventListener('input', () => {
    pState.keyword = searchEl.value.trim();
    render();
  });

  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { window.api.hideWindow(); return; }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      move(e.key === 'ArrowDown' ? 1 : -1);
      return;
    }
    if (e.key === 'Enter' && pState.selectedIndex >= 0) {
      e.preventDefault();
      const rows = itemsEl.querySelectorAll('.item');
      const target = rows[pState.selectedIndex];
      if (target) {
        const item = pState.shown[pState.selectedIndex];
        if (item) paste(item.id);
      }
    }
  });

  window.api.onWindowShown(() => {
    searchEl.value = '';
    pState.keyword = '';
    pState.selectedIndex = -1;
    load().then(() => searchEl.focus());
    searchEl.focus();
  });

  load().then(() => searchEl.focus());
}
