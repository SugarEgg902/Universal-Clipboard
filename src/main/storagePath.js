// 存储位置：dataDir（config.json 指针）→ 实际 db/images 路径解析 + 可写探针。
// dataDir 为 null/空串 = 默认 userData；config.json 本身永远留在 userData。

const fs = require('node:fs');
const path = require('node:path');

function resolveDataPaths(userDataDir, dataDir, pathMod = path) {
  if (typeof dataDir === 'string' && dataDir.trim()) {
    // 剥尾部分隔符；但根路径（'/'、'D:\'）剥完会退化（'' → CWD、'D:' → 盘相对 CWD），此时保留原值
    const root = pathMod.parse(dataDir).root;
    let stripped = dataDir.replace(/[\\/]+$/, '');
    if (stripped === '' || (root && stripped === root.replace(/[\\/]+$/, ''))) {
      stripped = dataDir;
    }
    const abs = pathMod.resolve(stripped);
    return {
      dbPath: pathMod.join(abs, 'clipboard.db'),
      imagesDir: pathMod.join(abs, 'images'),
      effectiveDir: abs,
    };
  }
  return {
    dbPath: pathMod.join(userDataDir, 'clipboard.db'),
    imagesDir: pathMod.join(userDataDir, 'images'),
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
