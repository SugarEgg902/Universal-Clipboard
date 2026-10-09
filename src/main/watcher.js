// 轮询系统剪贴板：含图片时走 onImage，否则走 onClip（文本）。
// hasImage/readImage/onImage 可选注入（默认无图片），便于测试；
// 主进程注入 electron clipboard 的对应操作。
class ClipboardWatcher {
  constructor({ hasImage, readImage, readText, onClip, onImage, intervalMs = 500 }) {
    if (typeof readText !== 'function' || typeof onClip !== 'function') {
      throw new Error('ClipboardWatcher 需要 readText 和 onClip 函数');
    }
    this.hasImage = hasImage || (() => false);
    this.readImage = readImage || (() => null);
    this.readText = readText;
    this.onClip = onClip;
    this.onImage = onImage || (() => {});
    this.intervalMs = intervalMs;
    this.lastSig = null;
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
    let sig = null;
    let payload = null;
    let handler = null;
    try {
      if (this.hasImage()) {
        const img = this.readImage();
        if (!img || !img.buffer || !img.buffer.length) return;
        sig = 'img:' + img.key;
        payload = img;
        handler = this.onImage;
      } else {
        const text = this.readText();
        if (!text || !text.trim()) return;
        sig = 'text:' + text;
        payload = text;
        handler = this.onClip;
      }
    } catch (err) {
      console.error('剪贴板读取失败:', err); // 跳过本次轮询，仅记录日志
      return;
    }
    if (sig !== this.lastSig) {
      this.lastSig = sig;
      handler(payload);
    }
  }
}

module.exports = { ClipboardWatcher };
