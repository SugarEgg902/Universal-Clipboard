// 疑似密码启发式检测：长度 + 字符类 + 熵 + 排除规则（URL/路径/纯数字/含空白）。
// 纯函数，无副作用，供主进程入库拦截与读取侧打码共用。

const MIN_LEN = 16;
const MIN_CLASSES = 3;
const MIN_ENTROPY = 3.5; // bit/char

// 强密码形态（高精度）：≥10 位 + 四种字符类齐全 + 中等熵。
// 字符集白名单只允许密码常用符号——含冒号/等号/分号等的更像日志串、配置行，排除。
const STRONG_MIN_LEN = 10;
const STRONG_MIN_ENTROPY = 3.0;
const STRONG_CHARSET = /^[A-Za-z0-9!@#$%^&*._\-~]+$/;

// 常见误报形态：日期、UUID、长十六进制（哈希）、kebab/snake 命名串
const DATE_RE = /\d{4}[-/]\d{1,2}[-/]\d{1,2}|\d{1,2}[-/]\d{1,2}[-/]\d{2,4}/;
const UUID_RE = /^[{]?[0-9a-fA-F]{8}-([0-9a-fA-F]{4}-){3}[0-9a-fA-F]{12}[}]?$/;
const HEX_RE = /^[0-9a-fA-F]{32,}$/;
const SLUG_RE = /^[a-z0-9]+([-_][a-z0-9]+){2,}$/;

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
  if (s.length < STRONG_MIN_LEN) return false; // 10 位以下自动判定误报太多，交手动标记
  if (/\s/.test(s)) return false;            // 密码一般无空白；句子/多行直接排除
  if (s.includes('://')) return false;       // URL
  if (s.startsWith('/')) return false;       // Unix 路径
  if (/^[A-Za-z]:[\\/]/.test(s)) return false; // Windows 路径
  if (/^\d+$/.test(s)) return false;         // 纯数字（订单号/卡号段）
  if (DATE_RE.test(s)) return false;         // 含日期（日志时间戳/日期文件名）
  if (UUID_RE.test(s)) return false;         // UUID 是标识符不是凭据
  if (HEX_RE.test(s)) return false;          // 长十六进制多为哈希/指纹
  if (SLUG_RE.test(s)) return false;         // kebab/snake 命名（2026-10-16-release-notes 等）

  const classes = charClasses(s);
  const entropy = shannonEntropy(s);
  // 强密码形态：四类齐全 + 密码字符集白名单（Tr0ub4dor&3、Xy9#kQ2$mV）
  if (
    s.length >= STRONG_MIN_LEN &&
    classes === 4 &&
    entropy >= STRONG_MIN_ENTROPY &&
    STRONG_CHARSET.test(s)
  ) {
    return true;
  }
  // 长随机串：≥16 位 + 3 类 + 高熵（token/密钥形态）
  if (s.length >= MIN_LEN && classes >= MIN_CLASSES && entropy >= MIN_ENTROPY) return true;
  return false;
}

module.exports = { looksLikeSecret };
