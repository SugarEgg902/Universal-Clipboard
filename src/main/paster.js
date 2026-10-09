// 平台粘贴适配层：把已在剪贴板的内容用 Cmd/Ctrl+V 模拟粘贴回之前的应用。
// macOS 用 AppleScript（需用户授予辅助功能权限，首次失败时渲染层引导）。
// 其余平台 v3 未实现，返回 unsupported-platform（内容已入剪贴板，可手动粘贴）。

const { execFile } = require('node:child_process');

const MACOS_PASTE_SCRIPT =
  'tell application "System Events" to keystroke "v" using command down';

function paste(platform = process.platform, execFileFn = execFile) {
  return new Promise((resolve) => {
    if (platform !== 'darwin') {
      resolve({ ok: false, error: 'unsupported-platform' });
      return;
    }
    // 2s 超时：System Events 卡死时不能让 IPC promise 永远挂起（超时即 err → paste-failed）
    execFileFn('osascript', ['-e', MACOS_PASTE_SCRIPT], { timeout: 2000 }, (err) => {
      if (err) {
        // 最常见原因是未授予辅助功能权限；保留详情便于排查
        console.error('osascript 失败:', err.message);
        resolve({ ok: false, error: 'paste-failed' });
        return;
      }
      resolve({ ok: true });
    });
  });
}

module.exports = { paste };
