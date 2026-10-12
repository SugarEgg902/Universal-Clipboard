// 局域网共享剪贴板——主机端常驻 HTTP+SSE 服务。
// seq 即 clips 行 id（自增天然单调）；幂等键 (origin_device_id, origin_id)；
// 只绑指定局域网 IP；token 头鉴权；SSE 心跳 25s；广播 100ms 防抖。

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const TEXT_MAX_BYTES = 1024 * 1024;       // 1MB
const IMAGE_MAX_BYTES = 10 * 1024 * 1024; // 10MB，与本地图片上限一致
const HEARTBEAT_MS = 25000;
const DEBOUNCE_MS = 100;
const MAX_SSE_CLIENTS = 16;
const DEFAULT_PORT_RANGE = [43789, 43999];

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const len = Number(req.headers['content-length'] || 0);
    if (len > limit) {
      reject(Object.assign(new Error('payload-too-large'), { code: 413 }));
      return;
    }
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(Object.assign(new Error('payload-too-large'), { code: 413 }));
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

// 超限/坏请求的拒绝必须先排空请求体再回响应，
// 否则客户端仍在写 body 时连接被关，触发 EPIPE/ECONNRESET
function rejectAfterDrain(req, res, code) {
  res.statusCode = code;
  if (req.readableEnded) {
    res.end();
    return;
  }
  req.resume();
  req.once('end', () => res.end());
  req.once('error', () => res.end());
}

function sseWrite(res, obj) {
  res.write(`data: ${JSON.stringify(obj)}\n\n`);
}

// opts: { store, imagesDir, token, deviceId, ip, portRange }（portRange/ip 测试注入）
// resolve { port, ip, stop(), pushLocal(rowId) }；端口被占在 portRange 内递增探测，耗尽抛 no-port。
function startSyncServer(opts) {
  const { store, imagesDir, token, deviceId } = opts;
  const ip = opts.ip;
  const [p0, p1] = opts.portRange || DEFAULT_PORT_RANGE;
  const sseClients = new Set();
  let pending = [];
  let timer = null;
  let hbTimer = null;

  function flush() {
    timer = null;
    if (!pending.length) return;
    const events = pending;
    pending = [];
    for (const res of sseClients) {
      for (const ev of events) sseWrite(res, ev);
    }
  }

  function enqueueBroadcast(rowId) {
    const row = store.get(rowId);
    if (!row) return;
    // 旧行（未 markOrigin）origin_device_id/origin_id 为 null，原样传出（客户端契约已处理）
    const ev = row.type === 'image'
      ? { seq: row.id, kind: 'image', imageId: row.id, originDeviceId: row.origin_device_id, originId: row.origin_id, width: row.width, height: row.height }
      : { seq: row.id, kind: 'text', text: row.text, originDeviceId: row.origin_device_id, originId: row.origin_id };
    pending.push(ev);
    if (!timer) timer = setTimeout(flush, DEBOUNCE_MS);
  }

  const server = http.createServer(async (req, res) => {
    try {
      const auth = req.headers.authorization || '';
      if (auth !== `Bearer ${token}`) {
        res.statusCode = 401;
        res.end('unauthorized');
        return;
      }
      const url = new URL(req.url, 'http://x');
      const pathname = url.pathname;

      if (req.method === 'GET' && pathname === '/health') {
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ ok: true, deviceId }));
        return;
      }

      if (req.method === 'POST' && pathname === '/clip') {
        let body;
        try {
          body = JSON.parse((await readBody(req, TEXT_MAX_BYTES)).toString('utf8'));
        } catch (err) {
          rejectAfterDrain(req, res, err.code === 413 ? 413 : 400);
          return;
        }
        // 必填字段校验：非法输入 400（客户端不应重试）；校验过后的 null 一律视为去重命中 → ACK
        if (!body || typeof body.text !== 'string' || !body.text.trim()
          || !body.originDeviceId || body.originId == null) {
          res.statusCode = 400;
          res.end();
          return;
        }
        const r = store.insertRemoteText({
          text: body.text, originDeviceId: body.originDeviceId, originId: body.originId,
        });
        if (!r) {
          // 内容去重命中：仍回 ACK（当天已存在行 id），客户端才能清补传队列
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ seq: store.findTextIdToday(body.text) }));
          return;
        }
        if (r.inserted) enqueueBroadcast(r.id);
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ seq: r.id }));
        return;
      }

      if (req.method === 'POST' && pathname === '/clip-image') {
        let meta;
        try {
          meta = JSON.parse(Buffer.from(String(req.headers['x-meta'] || ''), 'base64').toString('utf8'));
          // 必填字段校验：非法输入 400；校验过后的 null 一律视为去重命中 → ACK
          if (!meta || typeof meta !== 'object' || !meta.originDeviceId || meta.originId == null) {
            throw new Error('bad-meta');
          }
        } catch {
          rejectAfterDrain(req, res, 400);
          return;
        }
        let buf;
        try {
          buf = await readBody(req, IMAGE_MAX_BYTES);
        } catch (err) {
          rejectAfterDrain(req, res, err.code === 413 ? 413 : 400);
          return;
        }
        const r = store.insertRemoteImage(buf, meta);
        if (!r) {
          // 内容去重命中：同样回 ACK（当天已存在行 id），不回 seq:null
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ seq: store.findImageIdToday(buf) }));
          return;
        }
        if (r.inserted) enqueueBroadcast(r.id);
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ seq: r.id }));
        return;
      }

      const imgMatch = pathname.match(/^\/image\/(\d+)$/);
      if (req.method === 'GET' && imgMatch) {
        const imgDir = imagesDir || store.imagesDir; // 主机图片实际落在 store 的 imagesDir
        const row = store.get(Number(imgMatch[1]));
        if (!row || row.type !== 'image' || !row.image_path || !imgDir) {
          res.statusCode = 404;
          res.end();
          return;
        }
        const imagePath = path.join(imgDir, path.basename(row.image_path));
        if (!fs.existsSync(imagePath)) {
          res.statusCode = 404;
          res.end();
          return;
        }
        res.setHeader('Content-Type', 'image/png');
        fs.createReadStream(imagePath)
          .on('error', () => { if (!res.headersSent) res.statusCode = 500; res.end(); })
          .pipe(res);
        return;
      }

      if (req.method === 'GET' && pathname === '/items') {
        const since = Number(url.searchParams.get('since') || 0);
        const limit = Math.min(Number(url.searchParams.get('limit') || 200), 500);
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ items: store.listSince(since, limit) }));
        return;
      }

      if (req.method === 'GET' && pathname === '/events') {
        if (sseClients.size >= MAX_SSE_CLIENTS) {
          res.statusCode = 503;
          res.end();
          return;
        }
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
        });
        res.write('retry: 3000\n\n');
        sseClients.add(res);
        req.on('close', () => sseClients.delete(res));
        return;
      }

      res.statusCode = 404;
      res.end();
    } catch (err) {
      // 兜底：store 同步调用（含 SQLITE_CONSTRAINT）等任何异常都不得炸出 handler
      console.error('syncserver 请求处理失败:', err);
      if (!res.headersSent) res.statusCode = 500;
      res.end();
    }
  });

  return new Promise((resolve, reject) => {
    let port = p0;
    const stop = () => {
      clearTimeout(timer);
      clearInterval(hbTimer);
      for (const res of sseClients) res.end();
      sseClients.clear();
      server.close();
      if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
    };
    const tryListen = () => {
      server.once('error', (err) => {
        if (err.code === 'EADDRINUSE' && port < p1) {
          port += 1;
          tryListen();
        } else {
          reject(err.code === 'EADDRINUSE' ? Object.assign(new Error('no-port'), { code: 'no-port' }) : err);
        }
      });
      server.listen(port, ip, () => {
        hbTimer = setInterval(() => {
          for (const res of sseClients) res.write(':ping\n\n');
        }, HEARTBEAT_MS);
        if (typeof hbTimer.unref === 'function') hbTimer.unref();
        resolve({ port, ip, stop, pushLocal: enqueueBroadcast });
      });
    };
    tryListen();
  });
}

module.exports = { startSyncServer, TEXT_MAX_BYTES, IMAGE_MAX_BYTES };
