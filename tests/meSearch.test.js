const test = require('node:test');
const assert = require('node:assert');
const { ClipStore, toPinyin, hasCJK } = require('../src/main/store');

test('toPinyin：中文生成连续无音调小写拼音', () => {
  assert.strictEqual(toPinyin('收货地址'), 'shouhuodizhi');
});

test('toPinyin：非中文字符原样保留', () => {
  assert.strictEqual(toPinyin('abc123'), 'abc123');
});

test('hasCJK：判断含中文字符', () => {
  assert.strictEqual(hasCJK('收货地址'), true);
  assert.strictEqual(hasCJK('hello'), false);
  assert.strictEqual(hasCJK('地址abc'), true);
});

test('insert：中文文本入库时物化拼音列', () => {
  const store = new ClipStore();
  store.insert('收货地址是朝阳区');
  const row = store.db.prepare("SELECT pinyin FROM clips WHERE type='text'").get();
  assert.ok(row.pinyin.includes('shouhuodizhi'));
});

test('insert：纯 ASCII 文本 pinyin 列为 NULL', () => {
  const store = new ClipStore();
  store.insert('hello world');
  const row = store.db.prepare("SELECT pinyin FROM clips WHERE type='text'").get();
  assert.strictEqual(row.pinyin, null);
});

test('backfillPinyin：存量 NULL 中文行回填', () => {
  const store = new ClipStore();
  // 模拟存量行：绕过 insert() 直接写库，pinyin 为 NULL
  store.db.prepare('INSERT INTO clips (text, created_at) VALUES (?, ?)').run('数据库密码在此', 1700000000000);
  store.db.prepare('INSERT INTO clips (text, created_at) VALUES (?, ?)').run('ascii only', 1700000000001);
  store.backfillPinyin();
  const rows = store.db.prepare("SELECT text, pinyin FROM clips ORDER BY created_at").all();
  assert.ok(rows[0].pinyin.includes('shujukumima'));
  assert.strictEqual(rows[1].pinyin, null); // 无中文不回填
});
