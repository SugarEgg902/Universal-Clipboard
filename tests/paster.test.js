const test = require('node:test');
const assert = require('node:assert');
const { paste } = require('../src/main/paster');

test('darwin 分支调用 osascript 模拟 Cmd+V（带 2s 超时）', async () => {
  const calls = [];
  const fakeExec = (cmd, args, opts, cb) => {
    calls.push({ cmd, args, opts });
    cb(null);
  };
  const res = await paste('darwin', fakeExec);
  assert.deepStrictEqual(res, { ok: true });
  assert.strictEqual(calls[0].cmd, 'osascript');
  assert.ok(calls[0].args[1].includes('keystroke "v"'));
  assert.ok(calls[0].args[1].includes('command down'));
  assert.strictEqual(calls[0].opts.timeout, 2000);
});

test('osascript 失败返回 paste-failed', async () => {
  const fakeExec = (_cmd, _args, _opts, cb) => cb(new Error('not allowed'));
  const res = await paste('darwin', fakeExec);
  assert.deepStrictEqual(res, { ok: false, error: 'paste-failed' });
});

test('非 darwin 平台返回 unsupported-platform 且不执行命令', async () => {
  const calls = [];
  const fakeExec = (cmd, args, opts, cb) => { calls.push({ cmd, args, opts }); cb(null); };
  const res = await paste('win32', fakeExec);
  assert.deepStrictEqual(res, { ok: false, error: 'unsupported-platform' });
  assert.strictEqual(calls.length, 0);
});
