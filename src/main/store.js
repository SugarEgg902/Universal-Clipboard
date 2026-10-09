const fs = require('node:fs');
const crypto = require('node:crypto');
const path = require('node:path');
const Database = require('better-sqlite3');
const { toDateKey, dayRange } = require('./dates');

class ClipStore {
  constructor(dbPath = ':memory:', imagesDir = null) {
    this.db = new Database(dbPath);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS clips (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        text TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        type TEXT NOT NULL DEFAULT 'text',
        image_path TEXT,
        width INTEGER,
        height INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_created_at ON clips(created_at);
    `);
    if (imagesDir) fs.mkdirSync(imagesDir, { recursive: true });
    this.imagesDir = imagesDir;
    this.migrate();
    this.insertStmt = this.db.prepare('INSERT INTO clips (text, created_at) VALUES (?, ?)');
    this.existsStmt = this.db.prepare(
      'SELECT id FROM clips WHERE text = ? AND created_at >= ? AND created_at < ?'
    );
    this.listByDayStmt = this.db.prepare(
      'SELECT id, text, created_at, type, image_path, width, height FROM clips WHERE created_at >= ? AND created_at < ? ORDER BY created_at DESC'
    );
    this.searchStmt = this.db.prepare(
      "SELECT id, text, created_at, type, image_path, width, height FROM clips WHERE type = 'text' AND text LIKE ? ESCAPE '\\' ORDER BY created_at DESC LIMIT 200"
    );
    this.getStmt = this.db.prepare(
      'SELECT id, text, created_at, type, image_path, width, height FROM clips WHERE id = ?'
    );
    this.deleteStmt = this.db.prepare('DELETE FROM clips WHERE id = ?');
    this.clearDayStmt = this.db.prepare('DELETE FROM clips WHERE created_at >= ? AND created_at < ?');
    this.countByDayStmt = this.db.prepare(
      'SELECT COUNT(*) AS n FROM clips WHERE created_at >= ? AND created_at < ?'
    );
    this.insertImageStmt = this.db.prepare(
      'INSERT INTO clips (text, created_at, type, image_path, width, height) VALUES (?, ?, ?, ?, ?, ?)'
    );
    this.imageExistsStmt = this.db.prepare(
      'SELECT id FROM clips WHERE image_path = ? AND created_at >= ? AND created_at < ?'
    );
    this.imageRefsStmt = this.db.prepare(
      'SELECT COUNT(*) AS n FROM clips WHERE image_path = ?'
    );
    this.dayImagesStmt = this.db.prepare(
      "SELECT image_path FROM clips WHERE type = 'image' AND created_at >= ? AND created_at < ?"
    );
  }

  // 旧库升级：按需补充图片相关列（带默认值，存量行视为文本）
  migrate() {
    const cols = this.db.prepare('PRAGMA table_info(clips)').all().map((c) => c.name);
    if (!cols.includes('type')) {
      this.db.exec("ALTER TABLE clips ADD COLUMN type TEXT NOT NULL DEFAULT 'text'");
    }
    if (!cols.includes('image_path')) {
      this.db.exec('ALTER TABLE clips ADD COLUMN image_path TEXT');
    }
    if (!cols.includes('width')) {
      this.db.exec('ALTER TABLE clips ADD COLUMN width INTEGER');
    }
    if (!cols.includes('height')) {
      this.db.exec('ALTER TABLE clips ADD COLUMN height INTEGER');
    }
  }

  // 返回 lastInsertRowid；空白文本或当天重复时返回 null
  insert(text, now = Date.now()) {
    const trimmed = String(text).trim();
    if (!trimmed) return null;
    const [start, end] = dayRange(toDateKey(now));
    if (this.existsStmt.get(trimmed, start, end)) return null;
    return this.insertStmt.run(trimmed, now).lastInsertRowid;
  }

  // 图片入库：sha256 哈希命名文件写入 imagesDir（同哈希复用同一文件），元数据入库。
  // 同一天内同图不重复记录；无 imagesDir 或写盘失败返回 null。
  insertImage(buffer, width, height, now = Date.now()) {
    if (!this.imagesDir || !Buffer.isBuffer(buffer) || !buffer.length) return null;
    const hash = crypto.createHash('sha256').update(buffer).digest('hex');
    const fileName = hash.slice(0, 16) + '.png';
    const [start, end] = dayRange(toDateKey(now));
    if (this.imageExistsStmt.get(fileName, start, end)) return null;
    try {
      const filePath = path.join(this.imagesDir, fileName);
      if (!fs.existsSync(filePath)) fs.writeFileSync(filePath, buffer);
    } catch (err) {
      console.error('图片写盘失败:', err);
      return null;
    }
    return this.insertImageStmt.run('', now, 'image', fileName, width ?? null, height ?? null)
      .lastInsertRowid;
  }

  listByDay(dateKey) {
    const [start, end] = dayRange(dateKey);
    return this.listByDayStmt.all(start, end);
  }

  // 跨全部历史搜索（最多 200 条），LIKE 通配符（%, _）按字面匹配；空白关键词返回空
  search(keyword) {
    const kw = String(keyword).trim();
    if (!kw) return [];
    const escaped = kw.replace(/[\\%_]/g, (ch) => '\\' + ch);
    return this.searchStmt.all(`%${escaped}%`);
  }

  get(id) {
    return this.getStmt.get(id);
  }

  delete(id) {
    const row = this.getStmt.get(id);
    if (!row) return;
    this.deleteStmt.run(id);
    if (row.type === 'image') this.removeImageFile(row.image_path);
  }

  // 无任何行再引用该图片文件时删除它
  removeImageFile(fileName) {
    if (!this.imagesDir || !fileName) return;
    if (this.imageRefsStmt.get(fileName).n > 0) return;
    try {
      fs.unlinkSync(path.join(this.imagesDir, fileName));
    } catch (err) {
      console.warn('图片文件删除失败:', err); // 行已删，文件残留，仅记录
    }
  }

  clearDay(dateKey) {
    const [start, end] = dayRange(dateKey);
    const images = this.dayImagesStmt.all(start, end);
    this.clearDayStmt.run(start, end);
    for (const { image_path } of images) this.removeImageFile(image_path);
  }

  countByDay(dateKey) {
    const [start, end] = dayRange(dateKey);
    return this.countByDayStmt.get(start, end).n;
  }
}

// 打开磁盘数据库；文件损坏时备份为 .bak 并重建
function openStore(dbPath, imagesDir = null) {
  // 先用独立句柄探测文件可用性；损坏时先关闭句柄再备份重建，
  // 避免重命名仍被打开的文件（Windows 会 EPERM/EBUSY）。
  // 注意：catch 先于 finally 执行，关闭必须发生在 catch 内的 rename 之前。
  let probe;
  try {
    probe = new Database(dbPath);
    probe.prepare('SELECT COUNT(*) FROM sqlite_master').get();
  } catch (err) {
    if (dbPath === ':memory:' || !fs.existsSync(dbPath)) throw err;
    try { probe.close(); } catch { /* 已关闭 */ }
    probe = null;
    fs.renameSync(dbPath, dbPath + '.bak');
  } finally {
    if (probe) {
      try { probe.close(); } catch { /* 已关闭 */ }
    }
  }
  return new ClipStore(dbPath, imagesDir);
}

module.exports = { ClipStore, openStore };
