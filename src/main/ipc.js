const path = require('node:path');
const { ipcMain, clipboard, nativeImage } = require('electron');
const { getLast7Days, formatLabel } = require('./dates');

// 图片条目附带缩略图协议地址；文本条目 thumb 为 null
function withThumb(row) {
  return row.type === 'image'
    ? { ...row, text: '', thumb: `clipimg://thumb/${row.id}` }
    : { ...row, thumb: null };
}

// 注册所有 IPC handler。deps: { store, getWindow, imagesDir }
function registerIpc({ store, getWindow, imagesDir }) {
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
    store.listByDay(dateKey).map(withThumb)
  );

  // 跨全部历史搜索（仅文本条目）
  ipcMain.handle('clipboard:search', (_event, keyword) => store.search(keyword));

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

  ipcMain.handle('window:hide', () => {
    const win = getWindow();
    if (win) win.hide();
  });
}

module.exports = { registerIpc };
