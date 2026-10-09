// 隐私模式配置：userData/config.json 持久化，内存缓存，托盘菜单单选切换。
// mask（默认）：记录但打码；skip：完全不记录。

const fs = require('node:fs');
const path = require('node:path');

let configPath = null;
let mode = 'mask';

function init(userDataDir) {
  configPath = path.join(userDataDir, 'config.json');
  try {
    const saved = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    if (saved.privacyMode === 'mask' || saved.privacyMode === 'skip') mode = saved.privacyMode;
    else mode = 'mask';
  } catch {
    mode = 'mask'; // 文件不存在或损坏都回退默认
  }
}

function getMode() {
  return mode;
}

function setMode(next) {
  if (next !== 'mask' && next !== 'skip') return;
  mode = next;
  if (!configPath) return;
  try {
    fs.writeFileSync(configPath, JSON.stringify({ privacyMode: mode }, null, 2));
  } catch (err) {
    console.error('隐私配置保存失败:', err);
  }
}

module.exports = { init, getMode, setMode };
