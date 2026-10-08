// 轮询系统剪贴板，文本变化时回调 onClip。
// readText/onClip 由调用方注入，便于测试；主进程注入 electron 的 clipboard.readText。
class ClipboardWatcher {
  constructor({ readText, onClip, intervalMs = 500 }) {
    if (typeof readText !== 'function' || typeof onClip !== 'function') {
      throw new Error('ClipboardWatcher 需要 readText 和 onClip 函数');
    }
    this.readText = readText;
    this.onClip = onClip;
    this.intervalMs = intervalMs;
    this.lastText = null;
    this.timer = null;
  }

  start() {
    if (this.timer) return;
    this.check(); // 启动时立即采样一次，捕获当前剪贴板
    this.timer = setInterval(() => this.check(), this.intervalMs);
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  check() {
    let text;
    try {
      text = this.readText();
    } catch (err) {
      console.error('剪贴板读取失败:', err); // 跳过本次轮询，仅记录日志
      return;
    }
    if (!text || !text.trim()) return;
    if (text !== this.lastText) {
      this.lastText = text;
      this.onClip(text);
    }
  }
}

module.exports = { ClipboardWatcher };
