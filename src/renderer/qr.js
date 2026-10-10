// 二维码弹窗渲染层：收到 qr:render 结果后画码/提示。
const canvas = document.getElementById('qr-canvas');
const box = document.getElementById('qr-box');
const hint = document.getElementById('qr-hint');
const urlEl = document.getElementById('qr-url');
const copyBtn = document.getElementById('qr-copy');

const ERROR_HINTS = {
  'no-network': '未检测到局域网，该内容超出二维码容量',
  'not-found': '内容已不存在',
  empty: '没有可传送的文本条目',
  'no-port': '端口被占用，请重试',
};

function drawQr(text) {
  box.hidden = false;
  // vendor 的 UMD 全局 QRCode；位图 480px 供 retina，CSS 仍按 240px 布局
  QRCode.toCanvas(canvas, text, { width: 480, margin: 4 }, (err) => {
    if (err) hint.textContent = '二维码生成失败，请重试';
  });
}

window.api.onQrRender((result) => {
  urlEl.hidden = true;
  copyBtn.hidden = true;
  if (result.mode === 'inline') {
    drawQr(result.data);
    hint.textContent = '手机扫码即得';
  } else if (result.mode === 'url') {
    drawQr(result.url);
    hint.textContent = '手机连同一 WiFi 后扫码打开';
    urlEl.hidden = false;
    urlEl.textContent = result.url;
    copyBtn.hidden = false;
    copyBtn.onclick = async () => {
      try {
        await navigator.clipboard.writeText(result.url);
        copyBtn.textContent = '已复制';
        setTimeout(() => { copyBtn.textContent = '复制链接'; }, 1500);
      } catch {
        hint.textContent = '复制失败，请手动选择链接复制';
      }
    };
  } else {
    box.hidden = true; // 错误态清掉旧码，避免残留可扫的过期二维码
    hint.textContent = ERROR_HINTS[result.code] || '生成失败，请重试';
  }
});

document.getElementById('qr-close').addEventListener('click', () => window.close());
