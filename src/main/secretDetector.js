// 疑似密码启发式检测：长度 + 字符类 + 熵 + 排除规则（URL/路径/纯数字/含空白）。
// 纯函数，无副作用，供主进程入库拦截与读取侧打码共用。

const MIN_LEN = 16;
const MIN_CLASSES = 3;
const MIN_ENTROPY = 3.5; // bit/char

function charClasses(s) {
  let n = 0;
  if (/[a-z]/.test(s)) n++;
  if (/[A-Z]/.test(s)) n++;
  if (/[0-9]/.test(s)) n++;
  if (/[^a-zA-Z0-9]/.test(s)) n++;
  return n;
}

function shannonEntropy(s) {
  const counts = new Map();
  for (const ch of s) counts.set(ch, (counts.get(ch) || 0) + 1);
  let h = 0;
  for (const c of counts.values()) {
    const p = c / s.length;
    h -= p * Math.log2(p);
  }
  return h;
}

function looksLikeSecret(text) {
  // 不做 trim：含任何空白（含首尾换行）即不判定，交由下面的 \s 检查兜底
  const s = String(text);
  if (s.length < MIN_LEN) return false;
  if (/\s/.test(s)) return false;            // 密码一般无空白；句子/多行直接排除
  if (s.includes('://')) return false;       // URL
  if (s.startsWith('/')) return false;       // Unix 路径
  if (/^[A-Za-z]:[\\/]/.test(s)) return false; // Windows 路径
  if (/^\d+$/.test(s)) return false;         // 纯数字（订单号/卡号段）
  if (charClasses(s) < MIN_CLASSES) return false;
  if (shannonEntropy(s) < MIN_ENTROPY) return false;
  return true;
}

module.exports = { looksLikeSecret };
