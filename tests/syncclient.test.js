const test = require('node:test');
const assert = require('node:assert');
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
