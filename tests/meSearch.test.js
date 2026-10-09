const test = require('node:test');
const assert = require('node:assert');
const { ClipStore, toPinyin, hasCJK, scoreRow } = require('../src/main/store');

// 造行 helper：text + pinyin 可控
function row(text, pinyin = null, created_at = 1700000000000) {
  return { id: 1, text, pinyin, created_at, type: 'text' };
}

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

test('backfillPinyin：幂等——再次回填只补新出现的 NULL 中文行，其余不受影响', () => {
  const store = new ClipStore();
  store.db.prepare('INSERT INTO clips (text, created_at) VALUES (?, ?)').run('数据库密码在此', 1700000000000);
  store.backfillPinyin();
  const before = store.db.prepare('SELECT text, pinyin FROM clips ORDER BY created_at').all();
  // 再插一条绕过 insert() 的存量式 NULL 行
  store.db.prepare('INSERT INTO clips (text, created_at) VALUES (?, ?)').run('收货地址', 1700000000001);
  store.backfillPinyin();
  const after = store.db.prepare('SELECT text, pinyin FROM clips ORDER BY created_at').all();
  assert.strictEqual(after.length, 2);
  // 第一行保持原拼音（未被重复改写）
  assert.deepStrictEqual(after[0], before[0]);
  // 新行被补上拼音
  assert.strictEqual(after[1].pinyin, 'shouhuodizhi');
});

test('scoreRow：连续子串命中 = substring 档，位置越前分越高', () => {
  const early = scoreRow(row('hello world'), 'hello');
  const late = scoreRow(row('say hello now'), 'hello');
  assert.strictEqual(early.match_kind, 'substring');
  assert.strictEqual(early.match_pos, 0);
  assert.ok(early.score > late.score);
});

test('scoreRow：拼音列子串命中 = pinyin 档，无高亮坐标', () => {
  const s = scoreRow(row('收货地址', 'shouhuodizhi'), 'shouhuodizhi');
  assert.strictEqual(s.match_kind, 'pinyin');
  assert.strictEqual(s.match_pos, null);
});

test('scoreRow：子序列命中 = fuzzy 档，跨度越小分越高', () => {
  const tight = scoreRow(row('clipboard'), 'clp');
  const loose = scoreRow(row('c l i p'), 'clp');
  assert.strictEqual(tight.match_kind, 'fuzzy');
  assert.ok(tight.score > loose.score);
  assert.strictEqual(scoreRow(row('abc'), 'xyz'), null); // 无命中
});

test('search：拼音搜索中文行（罗马查询）', () => {
  const store = new ClipStore();
  store.insert('收货地址是朝阳区');
  const res = store.search('shouhuodizhi');
  assert.strictEqual(res.length, 1);
  assert.strictEqual(res[0].match_kind, 'pinyin');
});

test('search：模糊兜底——错拼子序列命中', () => {
  const store = new ClipStore();
  store.insert('please copy this clipboard content');
  const res = store.search('clipboad'); // 错拼，无子串/拼音命中 → fuzzy
  assert.strictEqual(res.length, 1);
  assert.strictEqual(res[0].match_kind, 'fuzzy');
});

test('search：模糊兜底不触发——快路径 ≥20 条', () => {
  const store = new ClipStore();
  for (let i = 0; i < 25; i++) store.insert(`hello item number ${i}`);
  store.insert('please copy this clipboard content');
  const res = store.search('hello');
  assert.strictEqual(res.filter((r) => r.match_kind === 'fuzzy').length, 0);
  assert.ok(res.length >= 20);
});

test('search：模糊兜底不触发——查询 <3 字符', () => {
  const store = new ClipStore();
  store.insert('clipboard');
  const res = store.search('cb');
  assert.strictEqual(res.filter((r) => r.match_kind === 'fuzzy').length, 0);
});

test('search：排序——substring 档高于 pinyin 档', () => {
  const store = new ClipStore();
  store.insert('数据库密码'); // pinyin 含 mima → pinyin 档
  store.insert('mima 明文记录'); // text 子串 → substring 档（应先出）
  const res = store.search('mima');
  assert.strictEqual(res[0].match_kind, 'substring');
  assert.ok(res.some((r) => r.match_kind === 'pinyin'));
});

test('search：同分新者先', () => {
  const store = new ClipStore();
  store.insert('hello older', 1700000000000);
  store.insert('hello newer', 1700000100000);
  const res = store.search('hello');
  assert.strictEqual(res[0].text, 'hello newer');
});
