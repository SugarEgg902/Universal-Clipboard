// 应用配置：userData/config.json 持久化，内存缓存，原子写（tmp+rename）。
// privacyMode: mask（默认，记录但打码）/ skip（完全不记录）。
// pet: 桌宠 { enabled, x, y, emoji }——x/y 为窗口坐标 null=默认角落，emoji 白名单限定。

const fs = require('node:fs');
const path = require('node:path');

const PET_EMOJIS = ['📦', '🗃️', '🐱', '🐤'];
const DEFAULT_PET = { enabled: true, x: null, y: null, emoji: '📦' };

let configPath = null;
let config = { privacyMode: 'mask', pet: { ...DEFAULT_PET } };

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
  config = { privacyMode: 'mask', pet: { ...DEFAULT_PET } };
  try {
    const saved = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    if (saved.privacyMode === 'mask' || saved.privacyMode === 'skip') config.privacyMode = saved.privacyMode;
    config.pet = sanitizePet(saved.pet);
  } catch {
    // 文件不存在或损坏都回退默认
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

module.exports = { init, getMode, setMode, getPet, setPet, PET_EMOJIS };
