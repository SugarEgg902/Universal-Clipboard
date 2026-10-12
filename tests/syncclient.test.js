const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { ClipStore } = require('../src/main/store');
const { startSyncServer } = require('../src/main/syncserver');
const { startSyncClient } = require('../src/main/syncclient');

const TOKEN = 'e2e-token';
const PORT_RANGE = [47000, 47050];

function pair() {
  const dirA = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-a-'));
  const dirB = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-b-'));
  const storeA = new ClipStore(':memory:', path.join(dirA, 'images')); // 主机
  const storeB = new ClipStore(':memory:', path.join(dirB, 'images')); // 客户端
  return { storeA, storeB, dirA, dirB };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('端到端：客户端本地复制 → 出现在主机库；主机本地复制 → 出现在客户端库', async () => {
  const { storeA, storeB } = pair();
  const srv = await startSyncServer({ store: storeA, imagesDir: null, token: TOKEN, deviceId: 'dev-host', ip: '127.0.0.1', portRange: PORT_RANGE });
  let lastSeq = 0;
  const client = startSyncClient({
    store: storeB, imagesDir: null, token: TOKEN, deviceId: 'dev-b',
    hostIp: '127.0.0.1', hostPort: srv.port,
    getLastSeq: () => lastSeq, setLastSeq: (n) => { lastSeq = n; },
    onStatus: () => {},
  });
  try {
    await sleep(600);
    const idB = storeB.insert('客户端的文本');
    storeB.markOrigin(idB, 'dev-b');
    client.pushLocal(idB);
    await sleep(1000);
    const day = new Date().toISOString().slice(0, 10);
    assert.ok(storeA.listByDay(day).some((r) => r.text === '客户端的文本'));
    const idA = storeA.insert('主机的文本');
    storeA.markOrigin(idA, 'dev-host');
    srv.pushLocal(idA);
    await sleep(1000);
    assert.ok(storeB.listByDay(day).some((r) => r.text === '主机的文本'));
    // 回声抑制：客户端没把自己那条再插一遍
    assert.strictEqual(storeB.listByDay(day).filter((r) => r.text === '客户端的文本').length, 1);
  } finally {
    client.stop();
    srv.stop();
  }
});

test('断线补拉：客户端掉线期间主机的新内容，重连后补到', async () => {
  const { storeA, storeB } = pair();
  const srv = await startSyncServer({ store: storeA, imagesDir: null, token: TOKEN, deviceId: 'dev-host', ip: '127.0.0.1', portRange: PORT_RANGE });
  let lastSeq = 0;
  const mk = () => startSyncClient({
    store: storeB, imagesDir: null, token: TOKEN, deviceId: 'dev-b',
    hostIp: '127.0.0.1', hostPort: srv.port,
    getLastSeq: () => lastSeq, setLastSeq: (n) => { lastSeq = n; },
    onStatus: () => {},
  });
  const client1 = mk();
  try {
    await sleep(600);
    client1.stop();
    await sleep(300);
    const id = storeA.insert('掉线期间的主机内容');
    storeA.markOrigin(id, 'dev-host');
    srv.pushLocal(id);
    await sleep(400);
    const client2 = mk();
    await sleep(1000);
    const day = new Date().toISOString().slice(0, 10);
    assert.ok(storeB.listByDay(day).some((r) => r.text === '掉线期间的主机内容'));
    client2.stop();
  } finally {
    client1.stop();
    srv.stop();
  }
});

test('null-origin 历史行：消费 seq 但不插入本地', async () => {
  const { storeA, storeB } = pair();
  // 主机先有一条无 origin 的旧历史（模拟同步开启前数据）
  storeA.insert('旧历史不该同步');
  const srv = await startSyncServer({ store: storeA, imagesDir: null, token: TOKEN, deviceId: 'dev-host', ip: '127.0.0.1', portRange: PORT_RANGE });
  let lastSeq = 0;
  const client = startSyncClient({
    store: storeB, imagesDir: null, token: TOKEN, deviceId: 'dev-b',
    hostIp: '127.0.0.1', hostPort: srv.port,
    getLastSeq: () => lastSeq, setLastSeq: (n) => { lastSeq = n; },
    onStatus: () => {},
  });
  try {
    await sleep(800);
    const day = new Date().toISOString().slice(0, 10);
    assert.ok(!storeB.listByDay(day).some((r) => r.text === '旧历史不该同步'));
    assert.ok(lastSeq >= 1); // seq 已消费（旧行 id=1）
  } finally {
    client.stop();
    srv.stop();
  }
});

test('图片端到端：客户端图片 → 主机 → 另一客户端收到字节一致的图片', async () => {
  const dirC = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-c-'));
  const storeC = new ClipStore(':memory:', path.join(dirC, 'images'));
  const { storeA, storeB } = pair();
  const srv = await startSyncServer({ store: storeA, imagesDir: null, token: TOKEN, deviceId: 'dev-host', ip: '127.0.0.1', portRange: PORT_RANGE });
  let seqB = 0;
  const clientB = startSyncClient({
    store: storeB, imagesDir: null, token: TOKEN, deviceId: 'dev-b',
    hostIp: '127.0.0.1', hostPort: srv.port, getLastSeq: () => seqB, setLastSeq: (n) => { seqB = n; }, onStatus: () => {},
  });
  let seqC = 0;
  const clientC = startSyncClient({
    store: storeC, imagesDir: path.join(dirC, 'images'), token: TOKEN, deviceId: 'dev-c',
    hostIp: '127.0.0.1', hostPort: srv.port, getLastSeq: () => seqC, setLastSeq: (n) => { seqC = n; }, onStatus: () => {},
  });
  try {
    await sleep(800);
    const buf = Buffer.from('real-png-payload');
    const idB = storeB.insertImage(buf, 7, 9);
    storeB.markOrigin(idB, 'dev-b');
    clientB.pushLocal(idB);
    await sleep(1500);
    const day = new Date().toISOString().slice(0, 10);
    const rowC = storeC.listByDay(day).find((r) => r.type === 'image');
    assert.ok(rowC, '客户端 C 应收到图片条目');
    const bytes = fs.readFileSync(path.join(dirC, 'images', rowC.image_path));
    assert.deepStrictEqual(bytes, buf);
  } finally {
    clientB.stop();
    clientC.stop();
    srv.stop();
  }
});

test('鉴权失败：错 token → onStatus 收到 error 且停止重试、不入库', async () => {
  const { storeA, storeB } = pair();
  const srv = await startSyncServer({ store: storeA, imagesDir: null, token: TOKEN, deviceId: 'dev-host', ip: '127.0.0.1', portRange: PORT_RANGE });
  const statuses = [];
  const client = startSyncClient({
    store: storeB, imagesDir: null, token: 'wrong-token', deviceId: 'dev-b',
    hostIp: '127.0.0.1', hostPort: srv.port,
    getLastSeq: () => 0, setLastSeq: () => {}, onStatus: (s) => statuses.push(s),
  });
  try {
    await sleep(1000);
    assert.ok(statuses.includes('error'));
    assert.strictEqual(storeA.countByDay(new Date().toISOString().slice(0, 10)), 0);
  } finally {
    client.stop();
    srv.stop();
  }
});

// 假主机：/health、/items（published 后才可见 seq1/seq2）、/image/1（imageOk 前 404）、/events
function startFakeHost() {
  const sseClients = new Set();
  const png = Buffer.from('fake-png-bytes');
  const state = { published: false, imageOk: false };
  const items = [
    { id: 1, text: '', created_at: Date.now(), type: 'image', image_path: 'a.png', width: 1, height: 1, origin_device_id: 'dev-host', origin_id: 11 },
    { id: 2, text: '第二条文本', created_at: Date.now(), type: 'text', image_path: null, width: null, height: null, origin_device_id: 'dev-host', origin_id: 12 },
  ];
  const server = http.createServer((req, res) => {
    if ((req.headers.authorization || '') !== `Bearer ${TOKEN}`) {
      res.statusCode = 401;
      res.end();
      return;
    }
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/health') {
      res.setHeader('Content-Type', 'application/json');
      res.end('{"ok":true}');
      return;
    }
    if (url.pathname === '/items') {
      const since = Number(url.searchParams.get('since') || 0);
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ items: state.published ? items.filter((i) => i.id > since) : [] }));
      return;
    }
    if (url.pathname === '/image/1') {
      if (!state.imageOk) { res.statusCode = 404; res.end(); return; }
      res.setHeader('Content-Type', 'image/png');
      res.end(png);
      return;
    }
    if (url.pathname === '/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
      sseClients.add(res);
      req.on('close', () => sseClients.delete(res));
      return;
    }
    res.statusCode = 404;
    res.end();
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        port: server.address().port,
        state,
        png,
        broadcast(obj) {
          for (const res of sseClients) res.write(`data: ${JSON.stringify(obj)}\n\n`);
        },
        stop() {
          for (const res of sseClients) res.end();
          sseClients.clear();
          server.close();
          if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
        },
      });
    });
  });
}

test('SSE 条目失败：lastSeq 停在失败点，重连后从断点重放', async () => {
  const host = await startFakeHost();
  const dirB = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-b-'));
  const storeB = new ClipStore(':memory:', path.join(dirB, 'images'));
  let lastSeq = 0;
  const client = startSyncClient({
    store: storeB, imagesDir: null, token: TOKEN, deviceId: 'dev-b',
    hostIp: '127.0.0.1', hostPort: host.port,
    getLastSeq: () => lastSeq, setLastSeq: (n) => { lastSeq = n; },
    onStatus: () => {},
  });
  try {
    await sleep(500); // 已连上（首拉为空：published=false）
    host.state.published = true;
    // 连发 seq1 图片（/image/1 仍 404，必失败）+ seq2 文本
    host.broadcast({ seq: 1, kind: 'image', imageId: 1, originDeviceId: 'dev-host', originId: 11, width: 1, height: 1 });
    host.broadcast({ seq: 2, kind: 'text', text: '第二条文本', originDeviceId: 'dev-host', originId: 12 });
    await sleep(700);
    // seq1 失败 → 链断：seq1 自身未消费（lastSeq 不到 1），seq2 也不许越过失败点推进
    assert.strictEqual(lastSeq, 0);
    // 主机侧图片恢复可拉：重连后 pullSince 从断点重放 seq1、seq2
    host.state.imageOk = true;
    await sleep(4000);
    assert.strictEqual(lastSeq, 2);
    const day = new Date().toISOString().slice(0, 10);
    assert.strictEqual(storeB.listByDay(day).filter((r) => r.text === '第二条文本').length, 1);
    const img = storeB.listByDay(day).find((r) => r.type === 'image');
    assert.ok(img, '重放后应有图片条目');
    assert.deepStrictEqual(fs.readFileSync(path.join(dirB, 'images', img.image_path)), host.png);
  } finally {
    client.stop();
    host.stop();
  }
});

test('stop 中断退避：连不上主机时 stop() 在 1s 内返回', async () => {
  // 占一个端口再释放，拿到确定无人监听的端口
  const probe = http.createServer();
  await new Promise((r) => probe.listen(0, '127.0.0.1', r));
  const freePort = probe.address().port;
  probe.close();
  const dirB = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-b-'));
  const storeB = new ClipStore(':memory:', path.join(dirB, 'images'));
  const client = startSyncClient({
    store: storeB, imagesDir: null, token: TOKEN, deviceId: 'dev-b',
    hostIp: '127.0.0.1', hostPort: freePort,
    getLastSeq: () => 0, setLastSeq: () => {}, onStatus: () => {},
  });
  await sleep(3500); // 经过 2-3 个退避周期（1s→2s→4s），此刻应停在长退避 sleep 里
  const t0 = Date.now();
  await client.stop();
  assert.ok(Date.now() - t0 < 1000, `stop 耗时不应拖满退避周期，实际 ${Date.now() - t0}ms`);
});
