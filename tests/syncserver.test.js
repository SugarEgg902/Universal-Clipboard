const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { ClipStore } = require('../src/main/store');
const { startSyncServer } = require('../src/main/syncserver');

const TOKEN = 'test-token-abc';

function makeStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'syncsrv-'));
  return { store: new ClipStore(':memory:', path.join(dir, 'images')), dir };
}

async function req(port, method, p, { body, headers = {}, raw = false } = {}) {
  return new Promise((resolve, reject) => {
    // agent:false：跨用例复用同端口时禁用 keep-alive，避免复用到上个服务已关闭的 socket
    const r = http.request({ host: '127.0.0.1', port, path: p, method, headers, agent: false }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        resolve({ status: res.statusCode, body: raw ? buf : buf.toString('utf8') });
      });
    });
    r.on('error', reject);
    if (body) r.write(body);
    r.end();
  });
}

const jpost = (port, p, obj, token) =>
  req(port, 'POST', p, {
    body: JSON.stringify(obj),
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(JSON.stringify(obj)), Authorization: `Bearer ${token}` },
  });

test('鉴权：无 token / 错 token → 401，对 token → 200', async () => {
  const { store } = makeStore();
  const srv = await startSyncServer({ store, imagesDir: null, token: TOKEN, deviceId: 'dev-host', ip: '127.0.0.1', portRange: [46000, 46050] });
  try {
    assert.strictEqual((await req(srv.port, 'GET', '/health')).status, 401);
    assert.strictEqual((await req(srv.port, 'GET', '/health', { headers: { Authorization: 'Bearer wrong' } })).status, 401);
    const ok = await req(srv.port, 'GET', '/health', { headers: { Authorization: `Bearer ${TOKEN}` } });
    assert.strictEqual(ok.status, 200);
    assert.strictEqual(JSON.parse(ok.body).deviceId, 'dev-host');
  } finally {
    srv.stop();
  }
});

test('POST /clip：入库返回 seq（=行id），SSE 客户端收到广播', async () => {
  const { store } = makeStore();
  const srv = await startSyncServer({ store, imagesDir: null, token: TOKEN, deviceId: 'dev-host', ip: '127.0.0.1', portRange: [46000, 46050] });
  const events = [];
  const es = http.get({ host: '127.0.0.1', port: srv.port, path: '/events', agent: false, headers: { Authorization: `Bearer ${TOKEN}` } }, (res) => {
    let buf = '';
    res.on('data', (c) => {
      buf += c.toString('utf8');
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const frame = buf.slice(0, i); buf = buf.slice(i + 2);
        const m = frame.match(/^data: (.*)$/m);
        if (m) events.push(JSON.parse(m[1]));
      }
    });
  });
  await new Promise((r) => setTimeout(r, 300));
  try {
    const res = await jpost(srv.port, '/clip', { text: '同步文本', originDeviceId: 'dev-b', originId: 1 }, TOKEN);
    assert.strictEqual(res.status, 200);
    const { seq } = JSON.parse(res.body);
    assert.ok(seq >= 1);
    await new Promise((r) => setTimeout(r, 300));
    assert.strictEqual(events.length, 1);
    assert.strictEqual(events[0].seq, seq);
    assert.strictEqual(events[0].text, '同步文本');
    assert.strictEqual(events[0].originDeviceId, 'dev-b');
  } finally {
    es.destroy();
    srv.stop();
  }
});

test('幂等：同 origin 重复 POST 返回同 seq 不产生新行', async () => {
  const { store } = makeStore();
  const srv = await startSyncServer({ store, imagesDir: null, token: TOKEN, ip: '127.0.0.1', portRange: [46000, 46050] });
  try {
    const r1 = await jpost(srv.port, '/clip', { text: 'dup', originDeviceId: 'dev-b', originId: 9 }, TOKEN);
    const r2 = await jpost(srv.port, '/clip', { text: 'dup', originDeviceId: 'dev-b', originId: 9 }, TOKEN);
    assert.strictEqual(JSON.parse(r1.body).seq, JSON.parse(r2.body).seq);
    const day = new Date().toISOString().slice(0, 10);
    assert.strictEqual(store.countByDay(day), 1);
  } finally {
    srv.stop();
  }
});

test('内容去重仍回 ACK：同内容不同 origin → 返回已存在行 id 不产生新行', async () => {
  const { store } = makeStore();
  const srv = await startSyncServer({ store, imagesDir: null, token: TOKEN, ip: '127.0.0.1', portRange: [46000, 46050] });
  try {
    const r1 = await jpost(srv.port, '/clip', { text: '同内容', originDeviceId: 'dev-b', originId: 1 }, TOKEN);
    const r2 = await jpost(srv.port, '/clip', { text: '同内容', originDeviceId: 'dev-c', originId: 2 }, TOKEN);
    assert.strictEqual(JSON.parse(r1.body).seq, JSON.parse(r2.body).seq);
    const day = new Date().toISOString().slice(0, 10);
    assert.strictEqual(store.countByDay(day), 1);
  } finally {
    srv.stop();
  }
});

test('大小限制：文本 >1MB → 413', async () => {
  const { store } = makeStore();
  const srv = await startSyncServer({ store, imagesDir: null, token: TOKEN, ip: '127.0.0.1', portRange: [46000, 46050] });
  try {
    const big = JSON.stringify({ text: 'x'.repeat(1024 * 1024 + 1), originDeviceId: 'd', originId: 1 });
    const res = await req(srv.port, 'POST', '/clip', {
      body: big,
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(big), Authorization: `Bearer ${TOKEN}` },
    });
    assert.strictEqual(res.status, 413);
  } finally {
    srv.stop();
  }
});

test('GET /items?since：按 id 游标补拉', async () => {
  const { store } = makeStore();
  const a = store.insertRemoteText({ text: 'a1', originDeviceId: 'b', originId: 1, hostSeq: 1 });
  store.insertRemoteText({ text: 'a2', originDeviceId: 'b', originId: 2, hostSeq: 2 });
  const srv = await startSyncServer({ store, imagesDir: null, token: TOKEN, ip: '127.0.0.1', portRange: [46000, 46050] });
  try {
    const res = await req(srv.port, 'GET', `/items?since=${a.id}`, { headers: { Authorization: `Bearer ${TOKEN}` } });
    assert.strictEqual(res.status, 200);
    const { items } = JSON.parse(res.body);
    assert.strictEqual(items.length, 1);
    assert.strictEqual(items[0].text, 'a2');
  } finally {
    srv.stop();
  }
});

test('POST /clip-image + GET /image/<id>：二进制往返', async () => {
  const { store, dir } = makeStore();
  const srv = await startSyncServer({ store, imagesDir: path.join(dir, 'images'), token: TOKEN, ip: '127.0.0.1', portRange: [46000, 46050] });
  try {
    const buf = Buffer.from('png-bytes-here');
    const meta = Buffer.from(JSON.stringify({ originDeviceId: 'dev-b', originId: 3, width: 8, height: 6 })).toString('base64');
    const res = await req(srv.port, 'POST', '/clip-image', {
      body: buf,
      headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': buf.length, 'X-Meta': meta, Authorization: `Bearer ${TOKEN}` },
    });
    assert.strictEqual(res.status, 200);
    const { seq } = JSON.parse(res.body);
    const img = await req(srv.port, 'GET', `/image/${seq}`, { headers: { Authorization: `Bearer ${TOKEN}` }, raw: true });
    assert.strictEqual(img.status, 200);
    assert.deepStrictEqual(img.body, buf);
  } finally {
    srv.stop();
  }
});

test('POST /clip-image：X-Meta 非法 base64/坏 JSON → 400', async () => {
  const { store, dir } = makeStore();
  const srv = await startSyncServer({ store, imagesDir: path.join(dir, 'images'), token: TOKEN, ip: '127.0.0.1', portRange: [46000, 46050] });
  try {
    const buf = Buffer.from('png-bytes');
    const bad1 = await req(srv.port, 'POST', '/clip-image', {
      body: buf,
      headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': buf.length, 'X-Meta': '%%%not-base64-json%%%', Authorization: `Bearer ${TOKEN}` },
    });
    assert.strictEqual(bad1.status, 400);
    // base64 合法但 JSON 缺必填字段 → 400
    const badMeta = Buffer.from(JSON.stringify({ originId: 1 })).toString('base64');
    const bad2 = await req(srv.port, 'POST', '/clip-image', {
      body: buf,
      headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': buf.length, 'X-Meta': badMeta, Authorization: `Bearer ${TOKEN}` },
    });
    assert.strictEqual(bad2.status, 400);
    const day = new Date().toISOString().slice(0, 10);
    assert.strictEqual(store.countByDay(day), 0);
  } finally {
    srv.stop();
  }
});

test('SSE 连接数上限：第 17 个 /events 连接 → 503', async () => {
  const { store } = makeStore();
  const srv = await startSyncServer({ store, imagesDir: null, token: TOKEN, deviceId: 'dev-host', ip: '127.0.0.1', portRange: [46000, 46050] });
  const conns = [];
  try {
    for (let i = 0; i < 16; i++) {
      const c = http.get({ host: '127.0.0.1', port: srv.port, path: '/events', agent: false, headers: { Authorization: `Bearer ${TOKEN}` } }, () => {});
      conns.push(c);
    }
    await new Promise((r) => setTimeout(r, 300));
    const res = await req(srv.port, 'GET', '/events', { headers: { Authorization: `Bearer ${TOKEN}` } });
    assert.strictEqual(res.status, 503);
  } finally {
    for (const c of conns) c.destroy();
    srv.stop();
  }
});

test('主机本地条目 pushLocal 广播给 SSE 客户端', async () => {
  const { store } = makeStore();
  const srv = await startSyncServer({ store, imagesDir: null, token: TOKEN, deviceId: 'dev-host', ip: '127.0.0.1', portRange: [46000, 46050] });
  const events = [];
  const es = http.get({ host: '127.0.0.1', port: srv.port, path: '/events', agent: false, headers: { Authorization: `Bearer ${TOKEN}` } }, (res) => {
    let buf = '';
    res.on('data', (c) => {
      buf += c.toString('utf8');
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const frame = buf.slice(0, i); buf = buf.slice(i + 2);
        const m = frame.match(/^data: (.*)$/m);
        if (m) events.push(JSON.parse(m[1]));
      }
    });
  });
  await new Promise((r) => setTimeout(r, 300));
  try {
    const id = store.insert('主机本地复制');
    store.markOrigin(id, 'dev-host');
    srv.pushLocal(id);
    await new Promise((r) => setTimeout(r, 300));
    assert.strictEqual(events.length, 1);
    assert.strictEqual(events[0].originDeviceId, 'dev-host');
    assert.strictEqual(events[0].originId, id);
  } finally {
    es.destroy();
    srv.stop();
  }
});
