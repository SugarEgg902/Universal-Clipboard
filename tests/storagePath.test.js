const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { resolveDataPaths, probeWritable } = require('../src/main/storagePath');

test('resolveDataPaths：dataDir 为 null 时用 userData 默认', () => {
  const p = resolveDataPaths('/Users/x/Library/Application Support/clipboard-drawer', null);
  assert.strictEqual(p.dbPath, path.join('/Users/x/Library/Application Support/clipboard-drawer', 'clipboard.db'));
  assert.strictEqual(p.imagesDir, path.join('/Users/x/Library/Application Support/clipboard-drawer', 'images'));
  assert.strictEqual(p.effectiveDir, '/Users/x/Library/Application Support/clipboard-drawer');
});

test('resolveDataPaths：自定义目录 + 尾部斜杠归一', () => {
  const p = resolveDataPaths('/ud', '/Volumes/D/data/');
  assert.strictEqual(p.effectiveDir, path.sep === '\\' ? '\\Volumes\\D\\data' : '/Volumes/D/data');
  assert.strictEqual(p.dbPath, path.join(p.effectiveDir, 'clipboard.db'));
  assert.strictEqual(p.imagesDir, path.join(p.effectiveDir, 'images'));
});

test('resolveDataPaths：相对路径 resolve 成绝对', () => {
  const p = resolveDataPaths('/ud', 'relative/dir');
  assert.ok(path.isAbsolute(p.effectiveDir));
});

test('probeWritable：正常目录可写（自动创建）', () => {
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sp-')), 'sub', 'data');
  const r = probeWritable(dir);
  assert.strictEqual(r.ok, true);
  assert.ok(fs.existsSync(dir));
});

test('probeWritable：文件路径当目录 → ok:false', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-'));
  const filePath = path.join(dir, 'afile');
  fs.writeFileSync(filePath, 'x');
  const r = probeWritable(filePath);
  assert.strictEqual(r.ok, false);
  assert.ok(r.error);
});

test('probeWritable：只读目录 → ok:false（POSIX chmod）', () => {
  if (process.platform === 'win32') return; // Windows 权限模型不同，跳过
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-'));
  fs.chmodSync(dir, 0o555);
  try {
    const r = probeWritable(path.join(dir, 'sub'));
    assert.strictEqual(r.ok, false);
  } finally {
    fs.chmodSync(dir, 0o755);
  }
});
