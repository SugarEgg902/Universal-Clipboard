const test = require('node:test');
const assert = require('node:assert');
const { looksLikeSecret } = require('../src/main/secretDetector');

test('典型随机密码判定为疑似密码', () => {
  assert.strictEqual(looksLikeSecret('Xy9#kQ2$vL8mP4!z'), true);
  assert.strictEqual(looksLikeSecret('aB3$dE7%fH2*jK9!mN'), true);
});

test('长度不足 10 不判定', () => {
  assert.strictEqual(looksLikeSecret('Xy9#kQ2'), false); // 7 字符
  assert.strictEqual(looksLikeSecret('Ab1!xyz'), false);
});

test('强密码形态：≥10 位 + 四类齐全 + 密码字符集', () => {
  assert.strictEqual(looksLikeSecret('Xy9#kQ2$vL8mP4'), true); // 原"不足 16 位不判"用例，现属强密码形态
  assert.strictEqual(looksLikeSecret('Tr0ub4dor&3'), true);
  assert.strictEqual(looksLikeSecret('Hello123!x'), true);
});

test('强密码规则不收录：冒号/等号更像日志与配置行', () => {
  assert.strictEqual(looksLikeSecret('Error:404!x'), false);
  assert.strictEqual(looksLikeSecret('token=Ab1!xYz9'), false);
});

test('强密码规则的熵门槛：重复模式不判定', () => {
  assert.strictEqual(looksLikeSecret('Aa1!aaaaaaaa'), false);
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

test('常见误报形态排除：日期/UUID/哈希/命名串', () => {
  assert.strictEqual(looksLikeSecret('2026-10-16-release-notes'), false); // 日期文件名
  assert.strictEqual(looksLikeSecret('Report2024-10-16-final'), false);  // 含日期
  assert.strictEqual(looksLikeSecret('550e8400-e29b-41d4-a716-446655440000'), false); // UUID
  assert.strictEqual(looksLikeSecret('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'), false); // sha256
  assert.strictEqual(looksLikeSecret('my-project_v2-final'), false);     // kebab/snake 命名
});

test('Shannon 熵边界：低熵与混合串', () => {
  assert.strictEqual(looksLikeSecret('aaaaaaaaaaaaaaaa1!'), false);
  assert.strictEqual(looksLikeSecret('aZ1!bY2@cX3#dW4$eV'), true);
});
