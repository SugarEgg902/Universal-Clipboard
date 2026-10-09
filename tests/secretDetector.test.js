const test = require('node:test');
const assert = require('node:assert');
const { looksLikeSecret } = require('../src/main/secretDetector');

test('典型随机密码判定为疑似密码', () => {
  assert.strictEqual(looksLikeSecret('Xy9#kQ2$vL8mP4!z'), true);
  assert.strictEqual(looksLikeSecret('aB3$dE7%fH2*jK9!mN'), true);
});

test('长度不足 16 不判定', () => {
  assert.strictEqual(looksLikeSecret('Xy9#kQ2$vL8mP4'), false); // 14 字符
});

test('无空格/换行要求：含空白即不判定', () => {
  assert.strictEqual(looksLikeSecret('hello world foo bar 123!'), false);
  assert.strictEqual(looksLikeSecret('Xy9#kQ2$vL8mP4!z\n'), false);
});

test('URL 排除', () => {
  assert.strictEqual(looksLikeSecret('https://example.com/very/long/path?a=b&c=d'), false);
});

test('文件路径排除', () => {
  assert.strictEqual(looksLikeSecret('/usr/local/bin/some-very-long-tool-name'), false);
  assert.strictEqual(looksLikeSecret('C:\\Program Files\\Some Very Long App Name'), false);
});

test('纯数字长串排除（订单号等）', () => {
  assert.strictEqual(looksLikeSecret('12345678901234567890'), false);
});

test('字符类不足 3 类不判定', () => {
  assert.strictEqual(looksLikeSecret('abcdefghijklmnop'), false); // 仅小写
  assert.strictEqual(looksLikeSecret('ABCDEFGHIJKLMNOP'), false); // 仅大写
  assert.strictEqual(looksLikeSecret('abc123def456ghi789'), false); // 小写+数字两类
});

test('低熵重复模式不判定（同 3 类但可预测）', () => {
  assert.strictEqual(looksLikeSecret('abababababababab1!'), false);
  assert.strictEqual(looksLikeSecret('aaaaaaaaaaaaaaaA1!'), false);
});

test('高熵 3 类以上无空白字符串判定为疑似密码', () => {
  assert.strictEqual(looksLikeSecret('kX9#pQ2$mV7nL4@zR'), true);
});

test('普通中文文本/英文句子不判定', () => {
  assert.strictEqual(looksLikeSecret('这是一段普通的中文文本内容用于测试检测器的误报率'), false);
  assert.strictEqual(looksLikeSecret('the quick brown fox jumps over the lazy dog'), false);
});

test('Shannon 熵边界：低熵与混合串', () => {
  assert.strictEqual(looksLikeSecret('aaaaaaaaaaaaaaaa1!'), false);
  assert.strictEqual(looksLikeSecret('aZ1!bY2@cX3#dW4$eV'), true);
});
