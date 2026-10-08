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
      "SELECT id, text, created_at FROM clips WHERE text LIKE ? ESCAPE '\\' ORDER BY created_at DESC"
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

  // 跨全部历史搜索，LIKE 通配符（%, _）按字面匹配
  search(keyword) {
    const escaped = String(keyword).replace(/[\\%_]/g, (ch) => '\\' + ch);
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
  try {
    const store = new ClipStore(dbPath);
    store.db.prepare('SELECT COUNT(*) FROM clips').get(); // 触发损坏检测
    return store;
  } catch (err) {
    if (dbPath !== ':memory:' && fs.existsSync(dbPath)) {
      fs.renameSync(dbPath, dbPath + '.bak');
      return new ClipStore(dbPath);
    }
    throw err;
  }
}

module.exports = { ClipStore, openStore };
