// 局域网共享剪贴板——客户端：连接主机、断线补拉 + 实时 SSE、本地上传 + 补传队列。
// 回声抑制：origin_device_id === 本机 的条目只消费 seq 不插入；
// null-origin 条目是主机端同步开启前的历史，同样只消费 seq 不插入。
// SSE 入库串行化：一条失败则后续事件只排队不推进 lastSeq，等重连 pullSince 从断点重放。

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { TEXT_MAX_BYTES, IMAGE_MAX_BYTES } = require('./syncserver');

const RETRY_MIN_MS = 1000;
const RETRY_MAX_MS = 30000;
const FLUSH_INTERVAL_MS = 5000;
const REQ_TIMEOUT_MS = 10000;

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
  let esReq = null;
  let flushTimer = null;
  const stopCtrl = new AbortController(); // stop 时 abort 所有进行中 fetch
  let stopResolvers = [];                 // stop 时唤醒退避 sleep
  // SSE 入库串行链：保证按 seq 顺序落库；链断（applyBroken）后新事件仍入链但跳过，
  // 不推进 lastSeq——重连后 pullSince 从断点重放，避免「失败条目被跳过」造成永久丢失
  let applyChain = Promise.resolve();
  let applyBroken = false;

  const status = (s) => { try { onStatus && onStatus(s); } catch { /* 状态回调不致命 */ } };

  // 10s 超时 + stop 可中断（abort 后 fetch 立即 reject，race 随之结束）；
  // race 败方 promise 已被 race 订阅，不会触发 unhandledRejection
  function req(url, opts = {}) {
    return Promise.race([
      fetch(url, { ...opts, signal: stopCtrl.signal }),
      new Promise((_, reject) => {
        const t = setTimeout(() => reject(new Error('req-timeout')), REQ_TIMEOUT_MS);
        if (typeof t.unref === 'function') t.unref();
      }),
    ]);
  }

  // 退避 sleep：stop() 可立即唤醒，避免 stop 最坏拖满一个退避周期（30s）
  function interruptibleSleep(ms) {
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(t);
        stopResolvers = stopResolvers.filter((f) => f !== done);
        resolve();
      };
      const t = setTimeout(done, ms);
      if (typeof t.unref === 'function') t.unref();
      stopResolvers.push(done);
    });
  }

  async function pushRow(id) {
    const row = store.get(id);
    if (!row) return;
    if (row.type === 'image') {
      const filePath = path.join(imagesDir || store.imagesDir, path.basename(row.image_path));
      let buf;
      try {
        buf = fs.readFileSync(filePath);
      } catch (err) {
        // 本地文件丢失/不可读（行在文件丢）：重试无意义，标记 permanent 让队列跳过，
        // 否则该行堵在队首、后面的行永远传不出去
        throw Object.assign(new Error(`read-image ${err.code}`), { permanent: true });
      }
      const meta = Buffer.from(JSON.stringify({ originDeviceId: deviceId, originId: id, width: row.width, height: row.height })).toString('base64');
      const res = await req(`${base}/clip-image`, { method: 'POST', agent: false, headers: { ...headers, 'Content-Type': 'application/octet-stream', 'X-Meta': meta, 'Content-Length': buf.length }, body: buf });
      if (res.status === 401 || res.status === 403) throw Object.assign(new Error('unauthorized'), { fatal: true });
      if (res.status === 400) throw Object.assign(new Error('bad-request'), { fatal: true });
      if (!res.ok) throw new Error(`push image ${res.status}`);
      const { seq } = await res.json();
      if (seq != null) store.markSynced(id, seq);
    } else {
      const body = JSON.stringify({ text: row.text, originDeviceId: deviceId, originId: id });
      const res = await req(`${base}/clip`, { method: 'POST', agent: false, headers: { ...headers, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }, body });
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
        if (err.permanent) {
          console.error(`补传跳过本地文件不可读的行 ${id}:`, err.message);
          continue; // 打墓碑跳过，不毒化后续行
        }
        return; // 网络问题：等下一轮
      }
    }
  }

  // 远端条目落库并推进 lastSeq；回声/历史条目只推进 lastSeq；
  // 超限条目（恶意/失控主机防护）只消费不插入，防写满磁盘
  async function applyItem(item) {
    if (item.origin_device_id === deviceId) { setLastSeq(item.id); return; } // 回声
    if (!item.origin_device_id) { setLastSeq(item.id); return; } // 同步开启前的历史
    if (item.type === 'image') {
      const res = await req(`${base}/image/${item.id}`, { agent: false, headers });
      if (!res.ok) throw new Error(`fetch image ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length > IMAGE_MAX_BYTES) {
        console.error(`同步图片超限（${buf.length}B > ${IMAGE_MAX_BYTES}B），跳过 seq=${item.id}`);
        setLastSeq(item.id);
        return;
      }
      store.insertRemoteImage(buf, {
        width: item.width, height: item.height,
        originDeviceId: item.origin_device_id, originId: item.origin_id, hostSeq: item.id,
      });
      setLastSeq(item.id);
    } else {
      if (Buffer.byteLength(String(item.text ?? ''), 'utf8') > TEXT_MAX_BYTES) {
        console.error(`同步文本超限（>${TEXT_MAX_BYTES}B），跳过 seq=${item.id}`);
        setLastSeq(item.id);
        return;
      }
      store.insertRemoteText({
        text: item.text, originDeviceId: item.origin_device_id, originId: item.origin_id, hostSeq: item.id,
      });
      setLastSeq(item.id);
    }
  }

  // SSE 事件入串行链；链断后新事件只排队不推进 lastSeq（等重连 pullSince 重放）
  function enqueueApply(item) {
    applyChain = applyChain.then(async () => {
      if (stopped || applyBroken) return;
      try {
        await applyItem(item);
      } catch (err) {
        applyBroken = true;
        console.error('同步条目入库失败:', err);
        // 主动断开 SSE 触发重连，下一轮 pullSince 从断点重放，尽快自愈
        if (esRes) { try { esRes.destroy(); } catch { /* 已断 */ } }
      }
    });
  }

  // 断线补拉：按 since 游标循环翻页直到空页（服务端可能每页返回少于 limit，
  // 不能用「不满一页即停」判断）；游标不前进（服务端不按游标响应）时兜底跳出防死循环
  async function pullSince() {
    let since = getLastSeq();
    for (;;) {
      const res = await req(`${base}/items?since=${since}&limit=500`, { agent: false, headers });
      if (res.status === 401 || res.status === 403) throw Object.assign(new Error('unauthorized'), { fatal: true });
      if (!res.ok) throw new Error(`pull ${res.status}`);
      const { items } = await res.json();
      if (!items.length) break;
      for (const item of items) {
        if (stopped) return;
        await applyItem(item);
      }
      const lastId = items[items.length - 1].id;
      if (lastId <= since) break;
      since = lastId;
    }
  }

  // 建立 SSE：收到 200（服务端已把本连接加进广播听众）即 resolve { waitClosed }；
  // waitClosed 挂起至长连断开才 reject——调用方据此拆出「先订阅、后快照、再挂起」三步，
  // 消除「先快照后订阅」窗口内主机插入行的 TOCTOU 丢失
  function openSse() {
    return new Promise((resolve, reject) => {
      let rejectClosed;
      const waitClosed = new Promise((_, rej) => { rejectClosed = rej; });
      // 追平 pullSince 抛错时调用方不再 await waitClosed，预挂 catch 防 unhandledRejection
      // （正常路径 cycle 仍 await，拒绝照常传播）
      waitClosed.catch(() => { /* 见上 */ });
      const conn = http.get({ host: hostIp, port: hostPort, path: '/events', agent: false, headers }, (res) => {
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
              enqueueApply({
                id: ev.seq, type: ev.kind === 'image' ? 'image' : 'text', text: ev.text,
                width: ev.width, height: ev.height,
                origin_device_id: ev.originDeviceId, origin_id: ev.originId,
              });
            } catch (err) {
              console.error('同步事件解析失败:', err);
            }
          }
        });
        res.on('close', () => { esRes = null; rejectClosed(new Error('sse-closed')); });
        resolve({ waitClosed }); // 已订阅：此后的广播不会漏
      });
      esReq = conn; // stop 时 destroy，解决建连期挂死
      conn.on('error', (err) => { if (esReq === conn) esReq = null; reject(err); });
    });
  }

  async function cycle() {
    while (!stopped) {
      status('connecting');
      try {
        const health = await req(`${base}/health`, { agent: false, headers });
        if (health.status === 401 || health.status === 403) throw Object.assign(new Error('unauthorized'), { fatal: true });
        if (!health.ok) throw new Error(`health ${health.status}`);
        await pullSince(); // 断线补拉（翻页）
        applyBroken = false; // 断点已追平：SSE 链重置，此后入链事件恢复正常落库
        await flushUnsynced();
        const sse = await openSse(); // 先订阅：此之后的广播不再漏
        await pullSince(); // 后快照：追平「首拉→订阅」窗口内的插入（幂等键+唯一索引，重放安全）
        status('connected');
        retryMs = RETRY_MIN_MS;
        await sse.waitClosed; // 挂起至长连断开
      } catch (err) {
        if (stopped) return;
        if (esRes) { try { esRes.destroy(); } catch { /* 已断 */ } esRes = null; }
        if (err.fatal) {
          status('error');
          return; // 鉴权/数据错：不重试，等用户改配置
        }
        status('disconnected');
        await interruptibleSleep(retryMs);
        retryMs = Math.min(retryMs * 2, RETRY_MAX_MS);
      }
    }
  }

  flushTimer = setInterval(() => {
    if (stopped) return;
    flushUnsynced().catch((err) => {
      if (err && err.fatal) clearInterval(flushTimer); // 鉴权/数据错：停止自动补传，不再每 5s 空转
    });
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
      for (const f of stopResolvers) f(); // 唤醒退避 sleep
      stopResolvers = [];
      stopCtrl.abort(); // 中断进行中 fetch
      if (esRes) { try { esRes.destroy(); } catch { /* 已断 */ } }
      if (esReq) { try { esReq.destroy(); } catch { /* 已断 */ } }
      await cyclePromise.catch(() => { /* 循环退出即完成 */ });
    },
  };
}

module.exports = { startSyncClient };
