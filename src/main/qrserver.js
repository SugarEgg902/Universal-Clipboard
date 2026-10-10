// 扫码快传：双路判定（短文本直编二维码 / 其余走临时局域网 HTTP）+ 内容解析 + 临时服务。
// 零第三方依赖；token 不可猜测，服务生命周期由调用方（QR 弹窗）控制，另有硬超时。

const crypto = require('node:crypto');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const { looksLikeSecret } = require('./secretDetector');

const INLINE_MAX_BYTES = 1000;
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_PORT_RANGE = [43789, 43999];

// 双路判定：仅"单条短文本"直编二维码，其余（长文本/图片/多选）走局域网 URL。
// text 必须已解析（resolveContent 之后调用），本函数不碰 store。
function routeFor(payload) {
  if (payload && payload.kind === 'text') {
    const text = String(payload.text || '');
    if (Buffer.byteLength(text, 'utf8') <= INLINE_MAX_BYTES) {
      return { mode: 'inline', data: text };
    }
  }
  return { mode: 'url' };
}

// 第一个非回环 IPv4（Node 18+ family 为数字 4，旧版为字符串 'IPv4'，两者兼容）。
function lanIp() {
  for (const infos of Object.values(os.networkInterfaces())) {
    for (const info of infos || []) {
      if ((info.family === 'IPv4' || info.family === 4) && !info.internal) return info.address;
    }
  }
  const err = new Error('no-network');
  err.code = 'no-network';
  throw err;
}

function codedError(code) {
  const err = new Error(code);
  err.code = code;
  return err;
}

// 按 payload 组装服务内容。抛带 code 的错误：not-found / empty / bad-request。
function resolveContent(store, imagesDir, payload) {
  if (payload && payload.kind === 'text') {
    const row = store.get(payload.id);
    if (!row || row.type !== 'text') throw codedError('not-found');
    return { contentType: 'text', text: row.text };
  }
  if (payload && payload.kind === 'image') {
    const row = store.get(payload.id);
    if (!row || row.type !== 'image' || !row.image_path) throw codedError('not-found');
    // basename 防目录穿越（参照 index.js clipimg handler）
    const imagePath = path.join(imagesDir, path.basename(row.image_path));
    if (!fs.existsSync(imagePath)) throw codedError('not-found');
    return { contentType: 'image', imagePath };
  }
  if (payload && payload.kind === 'bundle') {
    const texts = [];
    for (const id of payload.ids || []) {
      const row = store.get(id);
      // 只打包文本且排除疑似密码（与 spec §3.4 一致）
      if (row && row.type === 'text' && !looksLikeSecret(row.text)) texts.push(row.text);
    }
    if (!texts.length) throw codedError('empty');
    return { contentType: 'text', text: texts.join('\n\n') };
  }
  throw codedError('bad-request');
}

// 起临时 HTTP 服务：GET /t/<128bit-hex token> 返回内容。
// opts: { timeoutMs, ip, portRange }（测试注入；生产默认值见上）。
// resolve { url, token, port, stop() }；端口被占在 portRange 内顺序探测，耗尽抛 no-port。
function startServer(content, opts = {}) {
  const timeoutMs = opts.timeoutMs || DEFAULT_TIMEOUT_MS;
  const ip = opts.ip || lanIp();
  const [p0, p1] = opts.portRange || DEFAULT_PORT_RANGE;
  const token = crypto.randomBytes(16).toString('hex');

  const server = http.createServer((req, res) => {
    const pathname = (req.url || '').split('?')[0];
    if (pathname !== `/t/${token}`) {
      res.statusCode = 404;
      res.end('not found');
      return;
    }
    if (content.contentType === 'image') {
      res.setHeader('Content-Type', 'image/png');
      fs.createReadStream(content.imagePath)
        .on('error', () => {
          if (!res.headersSent) res.statusCode = 500;
          res.end();
        })
        .pipe(res);
    } else {
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.end(content.text);
    }
  });

  return new Promise((resolve, reject) => {
    let port = p0;
    let timer = null;
    const stop = () => {
      clearTimeout(timer);
      server.close();
      // Node 19+ 全局 agent 默认 keep-alive，需主动断开已建立的连接，
      // 否则 close() 挂起、后续请求经池化 socket 报 ECONNRESET 而非 ECONNREFUSED。
      if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
    };
    const tryListen = () => {
      server.once('error', (err) => {
        if (err.code === 'EADDRINUSE' && port < p1) {
          port += 1;
          tryListen();
        } else {
          reject(err.code === 'EADDRINUSE' ? codedError('no-port') : err);
        }
      });
      server.listen(port, ip, () => {
        timer = setTimeout(stop, timeoutMs);
        if (typeof timer.unref === 'function') timer.unref(); // 超时计时器不应拖住进程退出
        resolve({ url: `http://${ip}:${port}/t/${token}`, token, port, stop });
      });
    };
    tryListen();
  });
}

module.exports = { routeFor, lanIp, resolveContent, startServer, INLINE_MAX_BYTES };
