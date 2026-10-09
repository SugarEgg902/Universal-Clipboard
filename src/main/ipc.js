const path = require('node:path');
const { ipcMain, clipboard, nativeImage } = require('electron');
const { getLast7Days, formatLabel } = require('./dates');
const { looksLikeSecret } = require('./secretDetector');

// 图片条目附带缩略图协议地址；文本条目 thumb 为 null
function withThumb(row) {
  return row.type === 'image'
    ? { ...row, text: '', thumb: `clipimg://thumb/${row.id}` }
    : { ...row, thumb: null };
}

// 读取侧判定疑似密码（不移民数据，模式切换后历史行为即刻一致）
function withSecret(row) {
  return row.type === 'text' && looksLikeSecret(row.text)
    ? { ...row, secret: true }
    : { ...row, secret: false };
}

const withMeta = (row) => withSecret(withThumb(row));

// 注册所有 IPC handler。deps: { store, getWindow, imagesDir, getPaletteWindow, paster, hideApp }
function registerIpc({ store, getWindow, imagesDir, getPaletteWindow, paster, hideApp }) {
  // 最近 7 天抽屉元数据：[{ dateKey, label, count }]
  // 注意：todayKey 从 getLast7Days()[0] 统一取得再传给 formatLabel，
  // 避免两个调用各自读取 Date.now() 跨午夜时标签不一致。
  ipcMain.handle('clipboard:listDays', () => {
    const days = getLast7Days();
    const todayKey = days[0];
    return days.map((dateKey) => ({
      dateKey,
      label: formatLabel(dateKey, todayKey),
      count: store.countByDay(dateKey),
    }));
  });

  ipcMain.handle('clipboard:listByDay', (_event, dateKey) =>
    store.listByDay(dateKey).map(withMeta)
  );

  // 跨全部历史搜索（仅文本条目）
  ipcMain.handle('clipboard:search', (_event, keyword) => store.search(keyword).map(withMeta));

  ipcMain.handle('clipboard:delete', (_event, id) => {
    store.delete(id);
    return true;
  });

  ipcMain.handle('clipboard:clearDay', (_event, dateKey) => {
    store.clearDay(dateKey);
    return true;
  });

  // 复制回剪贴板并隐藏窗口（文本写文本，图片写图片）
  ipcMain.handle('clipboard:copy', (_event, id) => {
    const row = store.get(id);
    if (!row) return false;
    if (row.type === 'image') {
      const imgPath = path.join(imagesDir, path.basename(row.image_path || ''));
      const img = nativeImage.createFromPath(imgPath);
      if (img.isEmpty()) return false;
      clipboard.writeImage(img);
    } else {
      clipboard.writeText(row.text);
    }
    const win = getWindow();
    if (win) win.hide();
    return true;
  });

  // ---- 片段库 ----

  // 分组片段列表：[{ name, items: [带 meta 的行] }]
  ipcMain.handle('clipboard:listSnippets', () =>
    store.listSnippets().map((g) => ({ name: g.name, items: g.items.map(withMeta) }))
  );

  // Pin（upsert）。触发词冲突/非法返回 { ok:false, error }，由渲染层内联展示
  // （pin 对不存在条目返回 false——映射为 not-found）
  ipcMain.handle('clipboard:pin', (_event, id, trigger, groupName) => {
    try {
      const ok = store.pin(id, trigger, groupName);
      return ok ? { ok: true } : { ok: false, error: '条目不存在' };
    } catch (err) {
      return { ok: false, error: String(err.message || err) };
    }
  });

  ipcMain.handle('clipboard:unpin', (_event, id) => {
    store.unpin(id);
    return { ok: true };
  });

  // 快速面板粘贴：写剪贴板 → 隐藏面板 → 模拟粘贴。
  // 粘贴失败时内容已在剪贴板，渲染层提示手动粘贴。
  // 错误信封统一为 { ok, error }：paste 的 error 是机器码（not-found/unsupported-type/unsupported-platform/paste-failed）
  ipcMain.handle('clipboard:pasteSnippet', async (_event, id) => {
    const row = store.get(id);
    if (!row) return { ok: false, error: 'not-found' };
    if (row.type !== 'text') return { ok: false, error: 'unsupported-type' };
    clipboard.writeText(row.text);
    const palette = getPaletteWindow && getPaletteWindow();
    if (palette) palette.hide();
    if (!paster) return { ok: false, error: 'unsupported-platform' };
    try {
      // 辞去激活并把前台还给之前的应用；稍等再注入按键（激活切换是异步投递的）
      if (hideApp) hideApp();
      await new Promise((r) => setTimeout(r, 80));
      return await paster.paste();
    } catch (err) {
      console.error('模拟粘贴失败:', err);
      return { ok: false, error: 'paste-failed' };
    }
  });

  ipcMain.handle('window:hide', () => {
    const win = getWindow();
    if (win) win.hide();
    const palette = getPaletteWindow && getPaletteWindow();
    if (palette) palette.hide();
  });
}

module.exports = { registerIpc };
