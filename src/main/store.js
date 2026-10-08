const fs = require('node:fs');
const Database = require('better-sqlite3');
const { toDateKey, dayRange } = require('./dates');

class ClipStore {
  constructor(dbPath = ':memory:') {
    this.db = new Database(dbPath);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS clips (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        text TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_created_at ON clips(created_at);
    `);
    this.insertStmt = this.db.prepare('INSERT INTO clips (text, created_at) VALUES (?, ?)');
    this.existsStmt = this.db.prepare(
      'SELECT id FROM clips WHERE text = ? AND created_at >= ? AND created_at < ?'
    );
    this.listByDayStmt = this.db.prepare(
      'SELECT id, text, created_at FROM clips WHERE created_at >= ? AND created_at < ? ORDER BY created_at DESC'
    );
    this.searchStmt = this.db.prepare(
      "SELECT id, text, created_at FROM clips WHERE text LIKE ? ESCAPE '\\' ORDER BY created_at DESC LIMIT 200"
    );
    this.getStmt = this.db.prepare('SELECT id, text, created_at FROM clips WHERE id = ?');
    this.deleteStmt = this.db.prepare('DELETE FROM clips WHERE id = ?');
    this.clearDayStmt = this.db.prepare('DELETE FROM clips WHERE created_at >= ? AND created_at < ?');
    this.countByDayStmt = this.db.prepare(
      'SELECT COUNT(*) AS n FROM clips WHERE created_at >= ? AND created_at < ?'
    );
  }

  // 返回 lastInsertRowid；空白文本或当天重复时返回 null
  insert(text, now = Date.now()) {
    const trimmed = String(text).trim();
    if (!trimmed) return null;
    const [start, end] = dayRange(toDateKey(now));
    if (this.existsStmt.get(trimmed, start, end)) return null;
    return this.insertStmt.run(trimmed, now).lastInsertRowid;
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
    this.deleteStmt.run(id);
  }

  clearDay(dateKey) {
    const [start, end] = dayRange(dateKey);
    this.clearDayStmt.run(start, end);
  }

  countByDay(dateKey) {
    const [start, end] = dayRange(dateKey);
    return this.countByDayStmt.get(start, end).n;
  }
}

// 打开磁盘数据库；文件损坏时备份为 .bak 并重建
function openStore(dbPath) {
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
  return new ClipStore(dbPath);
}

module.exports = { ClipStore, openStore };
