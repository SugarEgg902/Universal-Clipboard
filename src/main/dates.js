const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

function pad(n) {
  return String(n).padStart(2, '0');
}

// 本地日期 → 'YYYY-MM-DD'
function toDateKey(ts = Date.now()) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function parseDateKey(dateKey) {
  const [y, m, d] = dateKey.split('-').map(Number);
  return { y, m, d };
}

// 某 dateKey 对应的本地时间半开区间 [start, end)
function dayRange(dateKey) {
  const { y, m, d } = parseDateKey(dateKey);
  return [new Date(y, m - 1, d).getTime(), new Date(y, m - 1, d + 1).getTime()];
}

// 最近 7 天的 dateKey，[今天, 昨天, ..., 6天前]
function getLast7Days(now = Date.now()) {
  const today = new Date(now);
  const days = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(today.getFullYear(), today.getMonth(), today.getDate() - i);
    days.push(toDateKey(d.getTime()));
  }
  return days;
}

// 抽屉标签：今天 / 昨天 / 周几 M/D
function formatLabel(dateKey, todayKey = toDateKey()) {
  if (dateKey === todayKey) return '今天';
  const today = parseDateKey(todayKey);
  const yesterdayKey = toDateKey(new Date(today.y, today.m - 1, today.d - 1).getTime());
  if (dateKey === yesterdayKey) return '昨天';
  const { y, m, d } = parseDateKey(dateKey);
  const wd = WEEKDAYS[new Date(y, m - 1, d).getDay()];
  return `${wd} ${m}/${d}`;
}

module.exports = { toDateKey, dayRange, getLast7Days, formatLabel };
