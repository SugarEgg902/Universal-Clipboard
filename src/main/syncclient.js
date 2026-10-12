// 局域网共享剪贴板——客户端：连接主机、断线补拉 + 实时 SSE、本地上传 + 补传队列。
// 回声抑制：origin_device_id === 本机 的条目只消费 seq 不插入；
// null-origin 条目是主机端同步开启前的历史，同样只消费 seq 不插入。

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const RETRY_MIN_MS = 1000;
const RETRY_MAX_MS = 30000;
const FLUSH_INTERVAL_MS = 5000;

// opts: { store, imagesDir, token, deviceId, hostIp, hostPort,
//         getLastSeq(), setLastSeq(n), onStatus(status: 'connecting'|'connected'|'disconnected'|'error') }
// 返回 { pushLocal(id), stop() }
function startSyncClient(opts) {
  const { store, imagesDir, token, deviceId, hostIp, hostPort, getLastSeq, setLastSeq, onStatus } = opts;
  const base = `http://${hostIp}:${hostPort}`;
  // Connection: close——Electron/undici 的 fetch 不认 agent:false，全局 keep-alive 池
  // 会复用到「主机重启后已死」的 socket（同 host:port），导致首个请求失败；禁复用根治
  const headers = { Authorization: `Bearer ${token}`, Connection: 'close' };
  let stopped = false;
  let retryMs = RETRY_MIN_MS;
  let esRes = null;
  let flushTimer = null;

  const status = (s) => { try { onStatus && onStatus(s); } catch { /* 状态回调不致命 */ } };

  async function pushRow(id) {
    const row = store.get(id);
    if (!row) return;
    if (row.type === 'image') {
      const filePath = path.join(imagesDir || store.imagesDir, path.basename(row.image_path));
      const buf = fs.readFileSync(filePath);
      const meta = Buffer.from(JSON.stringify({ originDeviceId: deviceId, originId: id, width: row.width, height: row.height })).toString('base64');
      const res = await fetch(`${base}/clip-image`, { method: 'POST', agent: false, headers: { ...headers, 'Content-Type': 'application/octet-stream', 'X-Meta': meta, 'Content-Length': buf.length }, body: buf });
      if (res.status === 401 || res.status === 403) throw Object.assign(new Error('unauthorized'), { fatal: true });
      if (res.status === 400) throw Object.assign(new Error('bad-request'), { fatal: true });
      if (!res.ok) throw new Error(`push image ${res.status}`);
      const { seq } = await res.json();
      if (seq != null) store.markSynced(id, seq);
    } else {
      const body = JSON.stringify({ text: row.text, originDeviceId: deviceId, originId: id });
      const res = await fetch(`${base}/clip`, { method: 'POST', agent: false, headers: { ...headers, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }, body });
      if (res.status === 401 || res.status === 403) throw Object.assign(new Error('unauthorized'), { fatal: true });
      if (res.status === 400) throw Object.assign(new Error('bad-request'), { fatal: true });
      if (!res.ok) throw new Error(`push text ${res.status}`);
      const { seq } = await res.json();
      if (seq != null) store.markSynced(id, seq);
    }
  }

  async function flushUnsynced() {
    const ids = store.listUnsynced(deviceId);
    for (const id of ids) {
      if (stopped) return;
      try {
        await pushRow(id);
      } catch (err) {
        if (err.fatal) throw err;
        return; // 网络问题：等下一轮
      }
    }
  }

  // 返回 true 表示该条目需要插入（非回声、非历史）
  async function applyItem(item) {
    if (item.origin_device_id === deviceId) { setLastSeq(item.id); return; } // 回声
    if (!item.origin_device_id) { setLastSeq(item.id); return; } // 同步开启前的历史
    if (item.type === 'image') {
      const res = await fetch(`${base}/image/${item.id}`, { agent: false, headers });
      if (!res.ok) throw new Error(`fetch image ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      store.insertRemoteImage(buf, {
        width: item.width, height: item.height,
        originDeviceId: item.origin_device_id, originId: item.origin_id, hostSeq: item.id,
      });
      setLastSeq(item.id);
    } else {
      store.insertRemoteText({
        text: item.text, originDeviceId: item.origin_device_id, originId: item.origin_id, hostSeq: item.id,
      });
      setLastSeq(item.id);
    }
  }

  async function pullSince() {
    const res = await fetch(`${base}/items?since=${getLastSeq()}&limit=500`, { agent: false, headers });
    if (res.status === 401 || res.status === 403) throw Object.assign(new Error('unauthorized'), { fatal: true });
    if (!res.ok) throw new Error(`pull ${res.status}`);
    const { items } = await res.json();
    for (const item of items) {
      if (stopped) return;
      await applyItem(item);
    }
  }

  function connectSse() {
    return new Promise((resolve, reject) => {
      const req = http.get({ host: hostIp, port: hostPort, path: '/events', agent: false, headers }, (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          reject(Object.assign(new Error(`sse ${res.statusCode}`), { fatal: res.statusCode === 401 || res.statusCode === 403 }));
          return;
        }
        esRes = res;
        let buf = '';
        res.on('data', (c) => {
          buf += c.toString('utf8');
          let i;
          while ((i = buf.indexOf('\n\n')) >= 0) {
            const frame = buf.slice(0, i);
            buf = buf.slice(i + 2);
            const m = frame.match(/^data: (.*)$/m);
            if (!m) continue;
            try {
              const ev = JSON.parse(m[1]);
              applyItem({
                id: ev.seq, type: ev.kind === 'image' ? 'image' : 'text', text: ev.text,
                width: ev.width, height: ev.height,
                origin_device_id: ev.originDeviceId, origin_id: ev.originId,
              }).catch((err) => console.error('同步条目入库失败:', err));
            } catch (err) {
              console.error('同步事件解析失败:', err);
            }
          }
        });
        res.on('close', () => { esRes = null; reject(new Error('sse-closed')); });
        // 不 resolve：promise 挂起至长连断开（close→reject），调用方 await 即「挂到断线」
      });
      req.on('error', reject);
    });
  }

  async function cycle() {
    while (!stopped) {
      status('connecting');
      try {
        const health = await fetch(`${base}/health`, { agent: false, headers });
        if (health.status === 401 || health.status === 403) throw Object.assign(new Error('unauthorized'), { fatal: true });
        if (!health.ok) throw new Error(`health ${health.status}`);
        await pullSince();
        await flushUnsynced();
        status('connected');
        retryMs = RETRY_MIN_MS;
        await connectSse(); // 长连，断开则抛错进下一轮
      } catch (err) {
        if (stopped) return;
        if (esRes) { try { esRes.destroy(); } catch { /* 已断 */ } esRes = null; }
        if (err.fatal) {
          status('error');
          return; // 鉴权/数据错：不重试，等用户改配置
        }
        status('disconnected');
        await new Promise((r) => setTimeout(r, retryMs));
        retryMs = Math.min(retryMs * 2, RETRY_MAX_MS);
      }
    }
  }

  flushTimer = setInterval(() => {
    if (stopped) return;
    flushUnsynced().catch(() => { /* 下一轮 */ });
  }, FLUSH_INTERVAL_MS);
  if (typeof flushTimer.unref === 'function') flushTimer.unref();
  const cyclePromise = cycle();

  return {
    pushLocal(id) {
      pushRow(id).catch(() => { /* listUnsynced 兜底 */ });
    },
    async stop() {
      stopped = true;
      clearInterval(flushTimer);
      if (esRes) { try { esRes.destroy(); } catch { /* 已断 */ } }
      await cyclePromise.catch(() => { /* 循环退出即完成 */ });
    },
  };
}

module.exports = { startSyncClient };
