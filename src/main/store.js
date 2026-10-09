const fs = require('node:fs');
const crypto = require('node:crypto');
const path = require('node:path');
const Database = require('better-sqlite3');
const { toDateKey, dayRange } = require('./dates');
const { pinyin } = require('pinyin-pro');

// Me-Search：仅含 CJK 的行物化拼音（连续、无音调、小写），罗马查询时命中
const CJK_RE = /[一-鿿]/;
function hasCJK(text) {
  return CJK_RE.test(text);
}
function toPinyin(text) {
  return pinyin(text, { toneType: 'none', type: 'string', separator: '' }).toLowerCase();
}

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
        height INTEGER,
        pinned INTEGER NOT NULL DEFAULT 0,
        trigger_word TEXT,
        group_name TEXT,
        pinyin TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_created_at ON clips(created_at);
    `);
    if (imagesDir) fs.mkdirSync(imagesDir, { recursive: true });
    this.imagesDir = imagesDir;
    this.migrate();
    this.insertStmt = this.db.prepare('INSERT INTO clips (text, created_at, pinyin) VALUES (?, ?, ?)');
    this.existsStmt = this.db.prepare(
      'SELECT id FROM clips WHERE text = ? AND created_at >= ? AND created_at < ?'
    );
    this.listByDayStmt = this.db.prepare(
      'SELECT id, text, created_at, type, image_path, width, height, pinned, trigger_word, group_name FROM clips WHERE created_at >= ? AND created_at < ? ORDER BY created_at DESC'
    );
    this.searchTextStmt = this.db.prepare(
      "SELECT id, text, created_at, type, image_path, width, height, pinned, trigger_word, group_name, pinyin FROM clips WHERE type = 'text' AND text LIKE ? ESCAPE '\\' ORDER BY created_at DESC, id DESC LIMIT 500"
    );
    this.searchPinyinStmt = this.db.prepare(
      "SELECT id, text, created_at, type, image_path, width, height, pinned, trigger_word, group_name, pinyin FROM clips WHERE type = 'text' AND pinyin LIKE ? ESCAPE '\\' ORDER BY created_at DESC, id DESC LIMIT 500"
    );
    this.fuzzyScanStmt = this.db.prepare(
      "SELECT id, text, created_at, type, image_path, width, height, pinned, trigger_word, group_name, pinyin FROM clips WHERE type = 'text' ORDER BY created_at DESC, id DESC LIMIT 5000"
    );
    this.getStmt = this.db.prepare(
      'SELECT id, text, created_at, type, image_path, width, height, pinned, trigger_word, group_name FROM clips WHERE id = ?'
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
    this.pinStmt = this.db.prepare(
      'UPDATE clips SET pinned = 1, trigger_word = ?, group_name = ? WHERE id = ?'
    );
    this.unpinStmt = this.db.prepare(
      'UPDATE clips SET pinned = 0, trigger_word = NULL, group_name = NULL WHERE id = ?'
    );
    this.triggerConflictStmt = this.db.prepare(
      'SELECT id FROM clips WHERE pinned = 1 AND trigger_word IS NOT NULL AND lower(trigger_word) = lower(?) AND id != ?'
    );
    this.listSnippetsStmt = this.db.prepare(
      'SELECT id, text, created_at, type, image_path, width, height, pinned, trigger_word, group_name FROM clips WHERE pinned = 1 ORDER BY created_at DESC, id DESC'
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
    if (!cols.includes('pinned')) {
      this.db.exec('ALTER TABLE clips ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0');
    }
    if (!cols.includes('trigger_word')) {
      this.db.exec('ALTER TABLE clips ADD COLUMN trigger_word TEXT');
    }
    if (!cols.includes('group_name')) {
      this.db.exec('ALTER TABLE clips ADD COLUMN group_name TEXT');
    }
    if (!cols.includes('pinyin')) {
      this.db.exec('ALTER TABLE clips ADD COLUMN pinyin TEXT');
      this.backfillPinyin();
    }
    this.backfillPinyin(); // 幂等补扫：修复上次回填中断遗留的 NULL 行
  }

  // Me-Search 存量回填：pinyin 为 NULL 的文本行中含中文者补拼音（迁移一次性调用；测试可直接调用）
  // 事务化：原子提交，避免逐行 fsync
  backfillPinyin() {
    const rows = this.db.prepare(
      "SELECT id, text FROM clips WHERE type = 'text' AND pinyin IS NULL"
    ).all();
    if (!rows.length) return;
    const upd = this.db.prepare('UPDATE clips SET pinyin = ? WHERE id = ?');
    this.db.transaction(() => {
      for (const r of rows) {
        if (hasCJK(r.text)) upd.run(toPinyin(r.text), r.id);
      }
    })();
  }

  // 返回 lastInsertRowid；空白文本或当天重复时返回 null
  insert(text, now = Date.now()) {
    const trimmed = String(text).trim();
    if (!trimmed) return null;
    const [start, end] = dayRange(toDateKey(now));
    if (this.existsStmt.get(trimmed, start, end)) return null;
    return this.insertStmt.run(trimmed, now, hasCJK(trimmed) ? toPinyin(trimmed) : null).lastInsertRowid;
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

  // Me-Search：SQL 子串快路径（text + 罗马查询时的 pinyin）→ 候选 <20 且查询 ≥3 字符 → 最近 5000 行子序列兜底
  // 评分排序（substring > pinyin > fuzzy，同分新者先），返回 top 50，行附加 score/match_kind/match_pos/match_len
  search(keyword) {
    const kw = String(keyword).trim();
    if (!kw) return [];
    const lower = kw.toLowerCase();
    const escaped = lower.replace(/[\\%_]/g, (ch) => '\\' + ch);

    const byId = new Map();
    for (const r of this.searchTextStmt.all(`%${escaped}%`)) byId.set(r.id, r);
    if (/^[a-z0-9]+$/.test(lower)) {
      for (const r of this.searchPinyinStmt.all(`%${escaped}%`)) byId.set(r.id, r);
    }

    const scored = [];
    for (const r of byId.values()) {
      const s = scoreRow(r, lower);
      if (s) scored.push({ ...r, ...s });
    }

    if (scored.length < 20 && lower.length >= 3) {
      for (const r of this.fuzzyScanStmt.all()) {
        if (byId.has(r.id)) continue;
        const s = scoreRow(r, lower);
        if (s) scored.push({ ...r, ...s }); // 任意命中均收：补 SQL LIKE 仅 ASCII 折叠的缺口（如 'CAFÉ' vs 'café'）
      }
    }

    scored.sort((a, b) => b.score - a.score || b.created_at - a.created_at || b.id - a.id);
    return scored.slice(0, 50);
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

  // 触发词校验：空/null 合法（仅分组收藏）；否则 1-32 位字母数字连字符下划线
  normalizeTrigger(trigger) {
    if (trigger === null || trigger === undefined) return null;
    const t = String(trigger).trim();
    if (!t) return null;
    if (!/^[\w-]{1,32}$/.test(t)) throw new Error('触发词仅允许字母、数字、连字符、下划线（1-32 位）');
    return t;
  }

  // Pin 即 upsert：已 Pin 条目再调用 = 修改触发词/分组；条目不存在时幂等返回 false
  pin(id, trigger, groupName) {
    const row = this.getStmt.get(id);
    if (!row) return false;
    const t = this.normalizeTrigger(trigger);
    if (t && this.triggerConflictStmt.get(t, id)) throw new Error('触发词已被占用');
    const g = groupName ? String(groupName).trim().slice(0, 32) : null;
    this.pinStmt.run(t, g || null, id);
    return true;
  }

  unpin(id) {
    this.unpinStmt.run(id);
    return true;
  }

  // 所有片段按分组返回：[{ name, items }]，null 组名归为"未分组"
  // 组序 = 各组最新条目出现的先后（SQL 全局倒序后按组收敛）；组内 created_at 倒序，毫秒并列按 id 倒序
  listSnippets() {
    const rows = this.listSnippetsStmt.all();
    const byGroup = new Map();
    for (const r of rows) {
      const key = r.group_name || '未分组';
      if (!byGroup.has(key)) byGroup.set(key, []);
      byGroup.get(key).push(r);
    }
    return Array.from(byGroup, ([name, items]) => ({ name, items }));
  }
}

// Me-Search 评分：substring(100+位置加成) > pinyin(90+位置加成) > fuzzy(80−跨度惩罚)；无命中 null
function scoreRow(r, kw) {
  const text = r.text.toLowerCase();
  const pos = text.indexOf(kw);
  if (pos >= 0) {
    // match_pos/match_len 是小写化后文本的索引；toLowerCase 改变长度时（罕见，如 'İ'）会与原文漂移，消费方需自行处理
    return { score: 100 + Math.max(0, 50 - pos), match_kind: 'substring', match_pos: pos, match_len: kw.length };
  }
  if (r.pinyin) {
    const ppos = r.pinyin.indexOf(kw);
    if (ppos >= 0) {
      return { score: 90 + Math.max(0, 50 - ppos), match_kind: 'pinyin', match_pos: null, match_len: null };
    }
  }
  let ti = 0; let first = -1; let last = -1;
  for (const ch of kw) {
    const found = text.indexOf(ch, ti);
    if (found < 0) return null;
    if (first < 0) first = found;
    last = found;
    ti = found + 1;
  }
  const span = last - first + 1;
  return { score: Math.max(1, 80 - (span - kw.length) * 2), match_kind: 'fuzzy', match_pos: null, match_len: null };
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

module.exports = { ClipStore, openStore, toPinyin, hasCJK, scoreRow };
