const test = require('node:test');
const assert = require('node:assert');
const { toDateKey, dayRange, getLast7Days, formatLabel } = require('../src/main/dates');

test('toDateKey 返回本地日期 YYYY-MM-DD', () => {
  const ts = new Date(2026, 9, 8, 15, 4, 5).getTime();
  assert.strictEqual(toDateKey(ts), '2026-10-08');
});

test('dayRange 覆盖当天本地零点至次日零点', () => {
  const [start, end] = dayRange('2026-10-08');
  assert.strictEqual(new Date(start).getHours(), 0);
  assert.strictEqual(new Date(start).getMinutes(), 0);
  assert.strictEqual(new Date(start).getDate(), 8);
  assert.strictEqual(new Date(end).getDate(), 9);
});

test('getLast7Days 今天排第一，共 7 天', () => {
  const now = new Date(2026, 9, 8, 12, 0, 0).getTime();
  const days = getLast7Days(now);
  assert.strictEqual(days.length, 7);
  assert.strictEqual(days[0], '2026-10-08');
  assert.strictEqual(days[6], '2026-10-02');
});

test('formatLabel: 今天 / 昨天 / 周几+日期', () => {
  const today = '2026-10-08'; // 2026-10-08 是周四
  assert.strictEqual(formatLabel('2026-10-08', today), '今天');
  assert.strictEqual(formatLabel('2026-10-07', today), '昨天');
  assert.strictEqual(formatLabel('2026-10-06', today), '周二 10/6');
  assert.strictEqual(formatLabel('2026-10-04', today), '周日 10/4');
});
