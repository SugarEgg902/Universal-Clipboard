// 应用配置：userData/config.json 持久化，内存缓存，原子写（tmp+rename）。
// privacyMode: mask（默认，记录但打码）/ skip（完全不记录）。
// pet: 桌宠 { enabled, x, y, emoji }——x/y 为窗口坐标 null=默认角落，emoji 白名单限定。

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const PET_EMOJIS = ['📦', '🗃️', '🐱', '🐤'];
const DEFAULT_PET = { enabled: true, x: null, y: null, emoji: '📦' };
const DEFAULTS = { privacyMode: 'mask', dataDir: null };
const DEFAULT_SYNC = { role: null, token: null, hostIp: null, hostPort: null, deviceId: null, lastSeq: 0 };

let configPath = null;
let config = { ...DEFAULTS, pet: { ...DEFAULT_PET }, sync: { ...DEFAULT_SYNC } };

function sanitizePet(pet, base) {
  const src = pet && typeof pet === 'object' ? pet : {};
  const out = { ...DEFAULT_PET, ...(base || {}) };
  if (typeof src.enabled === 'boolean') out.enabled = src.enabled;
  if (src.emoji && PET_EMOJIS.includes(src.emoji)) out.emoji = src.emoji;
  for (const k of ['x', 'y']) {
    if (src[k] === null) { out[k] = null; continue; }      // null = 重置默认角落
    if (src[k] === undefined) continue;                     // 未提供 → 保留 base
    if (Number.isFinite(src[k])) out[k] = src[k];           // 负数合法（左侧/上方副屏坐标）
  }
  return out;
}

function sanitizeDataDir(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'string' && v.trim()) return v;
  return undefined; // 非法值 → init 时忽略（保持默认）
}

// sync 白名单清洗：base 提供原值（setSync 部分更新时保留未提供/非法字段）
function sanitizeSync(sync, base) {
  const src = sync && typeof sync === 'object' ? sync : {};
  const out = { ...DEFAULT_SYNC, ...(base || {}) };
  if (src.role === null || src.role === 'host' || src.role === 'client') out.role = src.role;
  for (const k of ['token', 'hostIp']) {
    if (typeof src[k] === 'string' && src[k].trim()) out[k] = src[k].trim();
  }
  if (Number.isInteger(src.hostPort) && src.hostPort >= 1024 && src.hostPort <= 65535) out.hostPort = src.hostPort;
  if (typeof src.deviceId === 'string' && src.deviceId.trim()) out.deviceId = src.deviceId.trim();
  if (Number.isInteger(src.lastSeq) && src.lastSeq >= 0) out.lastSeq = src.lastSeq;
  return out;
}

function write() {
  if (!configPath) return;
  try {
    const tmp = configPath + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(config, null, 2));
    fs.renameSync(tmp, configPath);
  } catch (err) {
    console.error('配置保存失败:', err);
  }
}

function init(userDataDir) {
  configPath = path.join(userDataDir, 'config.json');
  config = { ...DEFAULTS, pet: { ...DEFAULT_PET }, sync: { ...DEFAULT_SYNC } };
  try {
    const saved = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    if (saved.privacyMode === 'mask' || saved.privacyMode === 'skip') config.privacyMode = saved.privacyMode;
    if (sanitizeDataDir(saved.dataDir) !== undefined) config.dataDir = sanitizeDataDir(saved.dataDir);
    config.pet = sanitizePet(saved.pet);
    config.sync = sanitizeSync(saved.sync);
  } catch {
    // 文件不存在或损坏都回退默认
  }
  if (!config.sync.deviceId) {
    config.sync.deviceId = crypto.randomUUID();
    write(); // 首次生成即落盘（含配置文件不存在走 catch 的情况）
  }
}

function getMode() {
  return config.privacyMode;
}

function setMode(next) {
  if (next !== 'mask' && next !== 'skip') return;
  config.privacyMode = next;
  write();
}

function getPet() {
  return { ...config.pet };
}

function setPet(patch) {
  const defined = {};
  for (const [k, v] of Object.entries(patch || {})) {
    if (v !== undefined) defined[k] = v;
  }
  config.pet = sanitizePet({ ...config.pet, ...defined }, config.pet);
  write();
}

function getDataDir() {
  return config.dataDir;
}

// dir 为 null/空串/空白串 = 恢复默认；非字符串忽略本次写入；写入前 trim 归一
function setDataDir(dir) {
  if (typeof dir === 'string') dir = dir.trim();
  if (dir === null || dir === '') {
    config.dataDir = null;
    write();
    return;
  }
  if (typeof dir !== 'string') return;
  config.dataDir = dir;
  write();
}

function getSync() {
  return { ...config.sync };
}

// patch 部分更新；非法字段忽略（sanitizeSync 白名单 + base 保留原值）
function setSync(patch) {
  config.sync = sanitizeSync(patch, config.sync);
  write();
}

module.exports = { init, getMode, setMode, getPet, setPet, getDataDir, setDataDir, getSync, setSync, PET_EMOJIS };
