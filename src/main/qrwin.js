// 二维码弹窗：复刻 pet.js 窗口模式——lazy create、closed 置 null、show() 重建。
// 生命周期：blur/closed 即停局域网服务；新 show() 先停旧服务再判定新路。

const path = require('node:path');
const { BrowserWindow } = require('electron');
const qrserver = require('./qrserver');

const WIN_W = 320;
const WIN_H = 380;

// 请求序号：show() 重入竞态守卫（后到的请求使前一个在途结果作废）
let reqSeq = 0;

function createQrWin({ rendererDir, store, imagesDir }) {
  let qrWin = null;
  let session = null; // 当前局域网服务句柄 { stop() }

  function stopSession() {
    if (session) {
      session.stop();
      session = null;
    }
  }

  function create() {
    qrWin = new BrowserWindow({
      width: WIN_W,
      height: WIN_H,
      show: false,
      backgroundColor: '#ffffff', // 白底黑码，保证扫描对比度
      frame: false,
      resizable: false,
      skipTaskbar: true,
      webPreferences: {
        preload: path.join(rendererDir, '..', 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
      },
    });
    qrWin.setAlwaysOnTop(true, 'floating');
    qrWin
      .loadFile(path.join(rendererDir, 'qr.html'))
      .catch((err) => console.error('二维码页面加载失败:', err));
    qrWin.webContents.on('did-fail-load', () => console.error('二维码页面加载失败'));
    // 失焦即关（等同用户看完走人）：停服务 + 隐藏
    qrWin.on('blur', () => {
      stopSession();
      qrWin.hide();
    });
    qrWin.on('closed', () => {
      stopSession();
      qrWin = null;
    });
  }

  // payload: { kind:'text'|'image', id } 或 { kind:'bundle', ids:[...] }
  // 返回判定结果（渲染层经 qr:render 收到同样的对象；窗口未加载完则等 did-finish-load）。
  async function show(payload) {
    const mySeq = ++reqSeq;
    stopSession();
    let result;
    let newSession = null;
    try {
      const content = qrserver.resolveContent(store, imagesDir, payload);
      const routed = qrserver.routeFor({
        kind: content.contentType === 'text' ? 'text' : 'image',
        text: content.text,
      });
      if (routed.mode === 'inline') {
        result = { mode: 'inline', data: content.text };
      } else {
        newSession = await qrserver.startServer(content);
        result = { mode: 'url', url: newSession.url };
      }
    } catch (err) {
      result = { mode: 'error', code: err.code || 'failed' };
    }
    // 竞态守卫：await 期间已有更新的请求 → 停掉新起的服务，不发送旧结果
    if (mySeq !== reqSeq) {
      if (newSession) newSession.stop();
      return result;
    }
    session = newSession;
    if (!qrWin) create();
    qrWin.showInactive();
    const win = qrWin;
    const send = () => win.webContents.send('qr:render', result);
    if (win.webContents.isLoading()) win.webContents.once('did-finish-load', send);
    else send();
    return result;
  }

  return { show, getWindow: () => qrWin };
}

module.exports = { createQrWin };
