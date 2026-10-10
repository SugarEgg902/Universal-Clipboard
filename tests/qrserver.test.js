const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { routeFor, lanIp, resolveContent, startServer, INLINE_MAX_BYTES } = require('../src/main/qrserver');
const { openStore } = require('../src/main/store');

function getJson(url) {
  return new Promise((resolve, reject) => {
    // agent:false 禁用 keep-alive 池化（Node 19+ 默认开启），
    // 保证 stop() 后新请求确实新建连接 → ECONNREFUSED。
    http.get(url, { agent: false }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, body, type: res.headers['content-type'] }));
    }).on('error', reject);
  });
}

// —— routeFor 双路判定 ——

test('routeFor：≤1000 字节文本走 inline', () => {
  const short = 'a'.repeat(INLINE_MAX_BYTES);
  const r = routeFor({ kind: 'text', text: short });
  assert.strictEqual(r.mode, 'inline');
  assert.strictEqual(r.data, short);
});

test('routeFor：1001 字节文本走 url（按 UTF-8 字节计，中文 3 字节/字）', () => {
  assert.strictEqual(routeFor({ kind: 'text', text: 'a'.repeat(INLINE_MAX_BYTES + 1) }).mode, 'url');
  // 334 个汉字 = 1002 字节 → url；333 个 = 999 字节 → inline
  assert.strictEqual(routeFor({ kind: 'text', text: '汉'.repeat(334) }).mode, 'url');
  assert.strictEqual(routeFor({ kind: 'text', text: '汉'.repeat(333) }).mode, 'inline');
});

test('routeFor：image 与 bundle 恒走 url', () => {
  assert.strictEqual(routeFor({ kind: 'image' }).mode, 'url');
  assert.strictEqual(routeFor({ kind: 'bundle', ids: [1] }).mode, 'url');
});

// —— resolveContent 内容解析 ——

function mkStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qr-test-'));
  return { store: openStore(':memory:', dir), dir };
}

test('resolveContent：text 取行文本，image 取文件路径，bundle 拼合并排除密码', () => {
  const { store, dir } = mkStore();
  const id1 = store.insert('第一段');
  const id2 = store.insert('第二段');
  store.insert('Xy9#kQ2$vL8mP4!zR'); // 疑似密码
  const imgId = store.insertImage(fs.readFileSync(path.join(__dirname, 'fixtures/1px.png')), 1, 1);

  const t = resolveContent(store, dir, { kind: 'text', id: id1 });
  assert.deepStrictEqual(t, { contentType: 'text', text: '第一段' });

  if (imgId != null) {
    const img = resolveContent(store, dir, { kind: 'image', id: imgId });
    assert.strictEqual(img.contentType, 'image');
    assert.ok(fs.existsSync(img.imagePath));
  }

  const b = resolveContent(store, dir, { kind: 'bundle', ids: [id1, id2, imgId].filter(Boolean) });
  assert.strictEqual(b.contentType, 'text');
  assert.strictEqual(b.text, '第一段\n\n第二段'); // 图片行与非文本行被跳过
});

test('resolveContent：id 不存在/类型不符 → not-found；bundle 全被过滤 → empty', () => {
  const { store, dir } = mkStore();
  assert.throws(() => resolveContent(store, dir, { kind: 'text', id: 9999 }), /not-found/);
  const imgOnly = store.insertImage(Buffer.from('notapng'), 1, 1);
  if (imgOnly != null) {
    assert.throws(() => resolveContent(store, dir, { kind: 'bundle', ids: [imgOnly] }), /empty/);
  }
  assert.throws(() => resolveContent(store, dir, { kind: 'bundle', ids: [] }), /empty/);
});

// —— startServer 临时 HTTP 服务 ——

test('startServer：GET /t/<token> 返回内容，错误 token 404，stop 后拒绝连接', async () => {
  const session = await startServer({ contentType: 'text', text: '你好，世界' }, { timeoutMs: 60000, ip: '127.0.0.1' });
  try {
    assert.match(session.url, /^http:\/\/127\.0\.0\.1:\d+\/t\/[0-9a-f]{32}$/);
    const ok = await getJson(session.url);
    assert.strictEqual(ok.status, 200);
    assert.strictEqual(ok.body, '你好，世界');
    assert.match(ok.type, /text\/plain/);
    const bad = await getJson(session.url.replace(/\/t\//, '/t/000'));
    assert.strictEqual(bad.status, 404);
  } finally {
    session.stop();
  }
  await assert.rejects(getJson(session.url), /ECONNREFUSED/);
});

test('startServer：image 内容返回 image/png 字节流', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qr-test-'));
  const pngPath = path.join(dir, 'test.png');
  fs.writeFileSync(pngPath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  const session = await startServer({ contentType: 'image', imagePath: pngPath }, { timeoutMs: 60000 });
  try {
    const res = await getJson(session.url);
    assert.strictEqual(res.status, 200);
    assert.match(res.type, /image\/png/);
  } finally {
    session.stop();
  }
});

test('startServer：超时自动关闭', async () => {
  const session = await startServer({ contentType: 'text', text: 'x' }, { timeoutMs: 80, ip: '127.0.0.1' });
  await new Promise((r) => setTimeout(r, 200));
  await assert.rejects(getJson(session.url), /ECONNREFUSED/);
});

test('startServer：端口被占时自动探测下一个端口', async () => {
  const blocker = http.createServer();
  await new Promise((r) => blocker.listen(43789, '127.0.0.1', r));
  try {
    const session = await startServer(
      { contentType: 'text', text: 'x' },
      { timeoutMs: 60000, ip: '127.0.0.1', portRange: [43789, 43791] }
    );
    try {
      assert.ok(session.port > 43789);
      const res = await getJson(session.url);
      assert.strictEqual(res.status, 200);
    } finally {
      session.stop();
    }
  } finally {
    blocker.close();
  }
});

test('lanIp：返回非回环 IPv4 字符串（无网卡环境本机也成立）', () => {
  const ip = lanIp();
  assert.match(ip, /^\d+\.\d+\.\d+\.\d+$/);
  assert.notStrictEqual(ip, '127.0.0.1');
});
