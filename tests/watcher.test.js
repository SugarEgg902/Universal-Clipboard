const test = require('node:test');
const assert = require('node:assert');
const { ClipboardWatcher } = require('../src/main/watcher');

function makeWatcher(readText) {
  const got = [];
  const w = new ClipboardWatcher({
    readText,
    onClip: (t) => got.push(t),
    intervalMs: 10,
  });
  return { w, got };
}

test('剪贴板文本变化时触发 onClip', () => {
  let current = 'a';
  const { w, got } = makeWatcher(() => current);
  w.check();
  current = 'b';
  w.check();
  current = 'b';
  w.check(); // 无变化，不触发
  assert.deepStrictEqual(got, ['a', 'b']);
});

test('空文本和纯空白不触发', () => {
  const { w, got } = makeWatcher(() => '   ');
  w.check();
  assert.deepStrictEqual(got, []);
});

test('readText 抛错时跳过并记录日志，下次恢复', () => {
  let fail = true;
  const got = [];
  const w = new ClipboardWatcher({
    readText: () => {
      if (fail) throw new Error('clipboard unavailable');
      return 'ok';
    },
    onClip: (t) => got.push(t),
    intervalMs: 10,
  });
  w.check();
  fail = false;
  w.check();
  assert.deepStrictEqual(got, ['ok']);
});

test('start/stop 控制轮询定时器', async () => {
  let current = 'x';
  const { w, got } = makeWatcher(() => current);
  w.start();
  current = 'y';
  await new Promise((r) => setTimeout(r, 40));
  w.stop();
  const countAfterStop = got.length;
  current = 'z';
  await new Promise((r) => setTimeout(r, 40));
  assert.deepStrictEqual(got, ['x', 'y']);
  assert.strictEqual(got.length, countAfterStop);
});

test('剪贴板含图片时触发 onImage（按 key 去重），不读取文本', () => {
  const got = [];
  let key = 'a';
  const w = new ClipboardWatcher({
    hasImage: () => true,
    readImage: () => ({ buffer: Buffer.from('png'), width: 1, height: 1, key }),
    readText: () => {
      throw new Error('不应读取文本');
    },
    onClip: () => {
      throw new Error('不应触发文本回调');
    },
    onImage: (img) => got.push(img.key),
    intervalMs: 10,
  });
  w.check();
  key = 'b';
  w.check();
  key = 'b';
  w.check();
  assert.deepStrictEqual(got, ['a', 'b']);
});

test('空图片缓冲区跳过', () => {
  const got = [];
  const w = new ClipboardWatcher({
    hasImage: () => true,
    readImage: () => ({ buffer: Buffer.alloc(0), width: 0, height: 0, key: 'a' }),
    readText: () => 'ignored',
    onClip: () => {},
    onImage: () => got.push('img'),
    intervalMs: 10,
  });
  w.check();
  assert.deepStrictEqual(got, []);
});

test('readImage 抛错时跳过并记录日志，下次恢复', () => {
  let fail = true;
  const got = [];
  const w = new ClipboardWatcher({
    hasImage: () => true,
    readImage: () => {
      if (fail) throw new Error('image unavailable');
      return { buffer: Buffer.from('ok'), width: 1, height: 1, key: 'k' };
    },
    readText: () => 'ignored',
    onClip: () => {},
    onImage: () => got.push('img'),
    intervalMs: 10,
  });
  w.check();
  fail = false;
  w.check();
  assert.deepStrictEqual(got, ['img']);
});
