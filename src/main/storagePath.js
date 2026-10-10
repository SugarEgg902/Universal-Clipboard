// 存储位置：dataDir（config.json 指针）→ 实际 db/images 路径解析 + 可写探针。
// dataDir 为 null/空串 = 默认 userData；config.json 本身永远留在 userData。

const fs = require('node:fs');
const path = require('node:path');

function resolveDataPaths(userDataDir, dataDir) {
  if (typeof dataDir === 'string' && dataDir.trim()) {
    const abs = path.resolve(dataDir.replace(/[\\/]+$/, ''));
    return {
      dbPath: path.join(abs, 'clipboard.db'),
      imagesDir: path.join(abs, 'images'),
      effectiveDir: abs,
    };
  }
  return {
    dbPath: path.join(userDataDir, 'clipboard.db'),
    imagesDir: path.join(userDataDir, 'images'),
    effectiveDir: userDataDir,
  };
}

// 探针：创建目录（不存在时）+ 写删探针文件。返回 { ok } 或 { ok:false, error }。
function probeWritable(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    const probe = path.join(dir, `.clipboard-drawer-probe-${process.pid}`);
    fs.writeFileSync(probe, 'ok');
    fs.unlinkSync(probe);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

module.exports = { resolveDataPaths, probeWritable };
