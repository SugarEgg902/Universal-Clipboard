const test = require('node:test');
const assert = require('node:assert');
const { ClipboardWatcher } = require('../src/main/watcher');

function makeWatcher(readText) {
  const got = [];
  const w = new ClipboardWatcher({ readText, onClip: (t) => got.push(t), intervalMs: 10 });
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

test('readText 抛错时静默跳过，下次恢复', () => {
  let fail = true;
  const { w, got } = makeWatcher(() => {
    if (fail) throw new Error('clipboard unavailable');
    return 'ok';
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
