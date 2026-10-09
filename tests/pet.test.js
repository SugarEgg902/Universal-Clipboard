const test = require('node:test');
const assert = require('node:assert');
const { buildClipPayload } = require('../src/main/pet');

test('buildClipPayload：普通文本截断 60 字', () => {
  const p = buildClipPayload({ kind: 'text', text: 'a'.repeat(100), secret: false });
  assert.strictEqual(p.kind, 'text');
  assert.strictEqual(p.preview.length, 60);
  assert.strictEqual(p.secret, false);
});

test('buildClipPayload：密码行预览为空串且 secret=true', () => {
  const p = buildClipPayload({ kind: 'text', text: 'Xy9#kQ2$vL8mP4!zR', secret: true });
  assert.strictEqual(p.preview, '');
  assert.strictEqual(p.secret, true);
});

test('buildClipPayload：图片带尺寸', () => {
  const p = buildClipPayload({ kind: 'image', width: 800, height: 600 });
  assert.strictEqual(p.kind, 'image');
  assert.strictEqual(p.preview, '800×600');
});

test('buildClipPayload：缺 text 视为空', () => {
  const p = buildClipPayload({ kind: 'text' });
  assert.strictEqual(p.preview, '');
  assert.strictEqual(p.secret, false);
});
