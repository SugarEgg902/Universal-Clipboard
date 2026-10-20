const path = require('node:path');
const { ipcMain, clipboard, nativeImage, Menu } = require('electron');
const { getLast7Days, formatLabel } = require('./dates');
const { looksLikeSecret } = require('./secretDetector');

// 图片条目附带缩略图协议地址；文本条目 thumb 为 null
function withThumb(row) {
  return row.type === 'image'
    ? { ...row, text: '', thumb: `clipimg://thumb/${row.id}` }
    : { ...row, thumb: null };
}

// 读取侧判定疑似密码：force_secret 手动标记优先（1=强制打码 0=强制明文），
// null 回落启发式（不移民数据，模式切换后历史行为即刻一致）
function withSecret(row) {
  const auto = row.type === 'text' && looksLikeSecret(row.text);
  const secret = row.force_secret != null ? !!row.force_secret : auto;
  return secret ? { ...row, secret: true } : { ...row, secret: false };
}

const withMeta = (row) => withSecret(withThumb(row));

// 注册所有 IPC handler。deps: { store, getWindow, imagesDir, getPaletteWindow, paster, hideApp, pet, showWindow, showPalette, privacyConfig, setTrayPetChecked, qrWin, onSyncConnect }
function registerIpc({ store, getWindow, imagesDir, getPaletteWindow, paster, hideApp, pet, showWindow, showPalette, privacyConfig, setTrayPetChecked, qrWin, onSyncConnect }) {
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

  // 手动打码标记（null 恢复自动 / 1 强制打码 / 0 强制明文），非法值拒绝
  ipcMain.handle('clipboard:setSecret', (_event, id, value) => {
    const v = value === null ? null : value === 0 || value === 1 ? value : undefined;
    if (v === undefined) return false;
    return store.setSecretOverride(id, v);
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

  // ---- 桌宠 ----

  ipcMain.handle('pet:drag', (_event, dx, dy) => {
    if (pet) pet.applyDrag(Number(dx) || 0, Number(dy) || 0);
  });
  ipcMain.handle('pet:ignore-mouse', (_event, ignore) => {
    if (pet) pet.setIgnoreMouse(!!ignore);
  });
  ipcMain.handle('pet:drag-end', () => {
    if (pet) pet.persistPosition();
  });
  ipcMain.handle('pet:open-main', () => {
    if (showWindow) showWindow();
  });
  ipcMain.handle('pet:context-menu', () => {
    Menu.buildFromTemplate([
      { label: '打开主窗口', click: () => showWindow && showWindow() },
      { label: '快速粘贴面板', click: () => showPalette && showPalette() },
      { type: 'separator' },
      {
        label: '禁用桌宠',
        click: () => {
          privacyConfig.setPet({ enabled: false });
          if (pet) pet.hide();
          if (setTrayPetChecked) setTrayPetChecked(false); // 同步托盘 checkbox 勾选态
        },
      },
    ]).popup();
  });

  // ---- 扫码快传 ----

  ipcMain.handle('qr:show', (_event, payload) => {
    if (qrWin) return qrWin.show(payload);
    return null;
  });

  // ---- 局域网共享剪贴板 ----

  // 连接共享主机：先 health 校验（3s 超时），成功才交给 onSyncConnect 写配置并启动同步
  ipcMain.handle('sync-connect', async (_e, cfg) => {
    const c = cfg && typeof cfg === 'object' ? cfg : {};
    if (typeof c.hostIp !== 'string' || !Number.isInteger(c.hostPort) || typeof c.token !== 'string' || !c.token) {
      return { ok: false, error: '参数不完整' };
    }
    try {
      const res = await fetch(`http://${c.hostIp}:${c.hostPort}/health`, {
        headers: { Authorization: `Bearer ${c.token}` },
        signal: AbortSignal.timeout(3000),
      });
      if (!res.ok) return { ok: false, error: '配对码错误或主机不可达' };
    } catch {
      return { ok: false, error: '主机不可达（IP/端口/网络）' };
    }
    if (!onSyncConnect) return { ok: false, error: '当前版本不支持' };
    return onSyncConnect({ hostIp: c.hostIp.trim(), hostPort: c.hostPort, token: c.token.trim() });
  });
}

module.exports = { registerIpc };
