/**
 * dedup.js — Анти-баян на базе pHash + SQLite (better-sqlite3).
 *
 * Схема БД:
 *   media_hashes   — уникальные хеши (первая находка)
 *   media_copies   — все каналы/посты где встречалась эта картинка
 *   processed_posts — быстрый lookup "этот channel+msgId уже обработан"
 *
 * Автоматически мигрирует старый hashes.json при первом запуске.
 */

const Database = require('better-sqlite3');
const Jimp     = require('jimp');
const fs       = require('fs');
const path     = require('path');

const DB_PATH   = path.join(__dirname, 'memes.db');
const JSON_PATH = path.join(__dirname, 'hashes.json');


const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');

db.exec(`
    CREATE TABLE IF NOT EXISTS media_hashes (
        id               INTEGER PRIMARY KEY AUTOINCREMENT,
        hash             TEXT    NOT NULL UNIQUE,
        first_channel    TEXT    NOT NULL,
        first_msg_id     TEXT    NOT NULL,
        first_seen_ts    INTEGER NOT NULL,
        hit_count        INTEGER DEFAULT 0,
        last_reported_ts INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS media_copies (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        hash        TEXT    NOT NULL,
        channel     TEXT    NOT NULL,
        msg_id      TEXT    NOT NULL,
        grouped_id  TEXT,
        seen_ts     INTEGER NOT NULL,
        UNIQUE(channel, msg_id)
    );
    CREATE INDEX IF NOT EXISTS idx_copies_hash ON media_copies(hash);

    CREATE TABLE IF NOT EXISTS processed_posts (
        channel      TEXT    NOT NULL,
        msg_id       TEXT    NOT NULL,
        processed_ts INTEGER NOT NULL,
        forwarded    INTEGER DEFAULT 0,
        PRIMARY KEY(channel, msg_id)
    );
`);

// Миграция: добавляем grouped_id если ещё нет (для существующих БД)
try { db.exec('ALTER TABLE media_copies ADD COLUMN grouped_id TEXT'); } catch(_) {}

// Загружаем только hash + channel+msgId — минимум нужного в памяти
let hashCache = db.prepare(
    'SELECT hash, first_channel, first_msg_id FROM media_hashes WHERE hash IS NOT NULL'
).all();


(function migrateFromJSON() {
    if (!fs.existsSync(JSON_PATH)) return;
    const existingCount = db.prepare('SELECT COUNT(*) as c FROM media_hashes').get().c;
    if (existingCount > 0) return; // уже мигрировали

    try {
        const raw  = JSON.parse(fs.readFileSync(JSON_PATH, 'utf8'));
        const list = Array.isArray(raw) ? raw : Object.values(raw);

        const insHash = db.prepare(`
            INSERT OR IGNORE INTO media_hashes(hash, first_channel, first_msg_id, first_seen_ts, hit_count, last_reported_ts)
            VALUES(?, ?, ?, ?, ?, ?)
        `);
        const insCopy = db.prepare(`
            INSERT OR IGNORE INTO media_copies(hash, channel, msg_id, seen_ts)
            VALUES(?, ?, ?, ?)
        `);
        const insProc = db.prepare(`
            INSERT OR IGNORE INTO processed_posts(channel, msg_id, processed_ts, forwarded)
            VALUES(?, ?, ?, 1)
        `);

        db.transaction(() => {
            for (const e of list) {
                if (!e.hash || !e.channelId || !e.messageId) continue;
                const ts = e.ts || Date.now();
                insHash.run(e.hash, String(e.channelId), String(e.messageId), ts, e.hitCount || 0, e.lastReportedAt || 0);
                insCopy.run(e.hash, String(e.channelId), String(e.messageId), ts);
                insProc.run(String(e.channelId), String(e.messageId), ts);

                if (Array.isArray(e.seenIn)) {
                    for (const s of e.seenIn) {
                        if (s.channel && s.msgId) {
                            insCopy.run(e.hash, String(s.channel), String(s.msgId), Date.now());
                            insProc.run(String(s.channel), String(s.msgId), Date.now());
                        }
                    }
                }
            }
        })();

        // Обновляем in-memory cache
        hashCache = db.prepare('SELECT hash, first_channel, first_msg_id FROM media_hashes WHERE hash IS NOT NULL').all();
        console.log(`✅ Мигрировано ${list.length} хешей из hashes.json → memes.db`);
    } catch (e) {
        console.error('Migration error:', e.message);
    }
})();


async function getPHash(buffer) {
    // Жёсткая защита: Jimp крашает с "Could not find MIME for Buffer <null>"
    if (!buffer || !Buffer.isBuffer(buffer) || buffer.length < 100) {
        throw new Error('invalid buffer (null/empty/too small)');
    }
    const image = await Jimp.read(buffer);
    image.resize(16, 16).grayscale();
    let total = 0;
    const pixels = [];
    image.scan(0, 0, 16, 16, function(x, y, idx) {
        const v = this.bitmap.data[idx];
        total += v;
        pixels.push(v);
    });
    const avg = total / pixels.length;
    return pixels.map(p => p >= avg ? '1' : '0').join('');
}

function hammingDistance(h1, h2) {
    if (!h1 || !h2 || h1.length !== h2.length) return 9999;
    let d = 0;
    for (let i = 0; i < h1.length; i++) if (h1[i] !== h2[i]) d++;
    return d;
}


const stmtGetHash       = db.prepare('SELECT * FROM media_hashes WHERE hash = ?');
const stmtIncrHit       = db.prepare('UPDATE media_hashes SET hit_count = hit_count + 1 WHERE hash = ?');
const stmtInsCopy       = db.prepare('INSERT OR IGNORE INTO media_copies(hash, channel, msg_id, grouped_id, seen_ts) VALUES(?, ?, ?, ?, ?)');
const stmtInsProc       = db.prepare('INSERT OR IGNORE INTO processed_posts(channel, msg_id, processed_ts, forwarded) VALUES(?, ?, ?, ?)');
const stmtMarkForwarded = db.prepare('UPDATE processed_posts SET forwarded = 1 WHERE channel = ? AND msg_id = ?');
const stmtIsProcessed   = db.prepare('SELECT processed_ts FROM processed_posts WHERE channel = ? AND msg_id = ? LIMIT 1');
const stmtIsForwarded   = db.prepare('SELECT processed_ts FROM processed_posts WHERE channel = ? AND msg_id = ? AND forwarded = 1 LIMIT 1');
const stmtInsHash       = db.prepare(`
    INSERT OR IGNORE INTO media_hashes(hash, first_channel, first_msg_id, first_seen_ts)
    VALUES(?, ?, ?, ?)
`);
const stmtGetCopies     = db.prepare(`
    SELECT channel, msg_id, seen_ts
    FROM media_copies
    WHERE hash = ? AND channel != ?
    ORDER BY seen_ts
`);


/**
 * Проверяет, является ли картинка дублем.
 * Если дубль — инкрементирует hit_count, добавляет в media_copies.
 * Возвращает запись оригинала (с seenIn) или false.
 */
async function isDuplicate(imageBuffer, channel = null, msgId = null, threshold = 5, groupedId = null) {
    try {
        // Пропускаем видео (mp4/ftyp magic bytes)
        if (imageBuffer.length > 8 && imageBuffer.slice(4, 8).toString('ascii') === 'ftyp') {
            return false;
        }

        const newHash = await getPHash(imageBuffer);

        for (const row of hashCache) {
            if (row.hash && hammingDistance(newHash, row.hash) <= threshold) {
                stmtIncrHit.run(row.hash);

                if (channel && msgId) {
                    const gid = groupedId ? String(groupedId) : null;
                    stmtInsCopy.run(row.hash, String(channel), String(msgId), gid, Date.now());
                    stmtInsProc.run(String(channel), String(msgId), Date.now(), 0);
                }

                const full   = stmtGetHash.get(row.hash);
                const copies = stmtGetCopies.all(row.hash, full.first_channel);
                return { ...full, channelId: full.first_channel, messageId: full.first_msg_id,
                         hitCount: full.hit_count + 1,
                         seenIn: copies.map(c => ({ channel: c.channel, msgId: c.msg_id })) };
            }
        }
        return false;
    } catch (e) {
        console.error('❌ pHash error:', e.message);
        return false;
    }
}

/**
 * Сохраняет новый хеш (уникальный пост) в БД.
 */
async function saveToDatabase(imageBuffer, messageId, channelId, groupedId = null) {
    try {
        let hash = null;
        try { hash = await getPHash(imageBuffer); } catch(_) {}

        const ts  = Date.now();
        const ch  = String(channelId);
        const mid = String(messageId);
        const gid = groupedId ? String(groupedId) : null;

        if (hash) {
            stmtInsHash.run(hash, ch, mid, ts);
            stmtInsCopy.run(hash, ch, mid, gid, ts);
            // Добавляем в in-memory cache если новый
            if (!hashCache.some(r => r.hash === hash)) {
                hashCache.push({ hash, first_channel: ch, first_msg_id: mid });
            }
        }

        stmtInsProc.run(ch, mid, ts, 0);
    } catch (e) {
        console.error('❌ saveToDatabase error:', e.message);
    }
}

/**
 * Пост уже обрабатывался (хешировался) — не нужно качать повторно.
 */
function isAlreadyProcessed(channelId, messageId) {
    return !!stmtIsProcessed.get(String(channelId), String(messageId));
}

/**
 * Пост уже пересылался в канал назначения (48ч блок).
 */
function isAlreadyForwarded(channelId, messageId) {
    const cutoff = Date.now() - 48 * 3600 * 1000;
    const row = stmtIsForwarded.get(String(channelId), String(messageId));
    return row ? row.processed_ts >= cutoff : false;
}

/**
 * Помечает пост как переслянный (после успешного форварда).
 */
function markAsForwarded(channelId, messageId) {
    stmtInsProc.run(String(channelId), String(messageId), Date.now(), 1);
    stmtMarkForwarded.run(String(channelId), String(messageId));
}

/**
 * Топ N самых копируемых мемов за последние 24ч (с кулдауном).
 */
function getTopDuplicates(topN = 5) {
    const now     = Date.now();
    const cooldown = 24 * 3600 * 1000;

    const rows = db.prepare(`
        SELECT h.*, COUNT(c.id) as copy_count
        FROM media_hashes h
        LEFT JOIN media_copies c ON c.hash = h.hash AND c.channel != h.first_channel
        WHERE h.hit_count >= 2
          AND (h.last_reported_ts = 0 OR h.last_reported_ts < ?)
        GROUP BY h.id
        ORDER BY h.hit_count DESC
        LIMIT ?
    `).all(now - cooldown, topN);

    const result = [];
    const updStmt = db.prepare('UPDATE media_hashes SET hit_count = 0, last_reported_ts = ? WHERE hash = ?');

    for (const row of rows) {
        const copies = stmtGetCopies.all(row.hash, row.first_channel);
        result.push({
            hash:          row.hash,
            channelId:     row.first_channel,
            messageId:     row.first_msg_id,
            ts:            row.first_seen_ts,
            hitCount:      row.hit_count,
            seenIn:        copies.map(c => ({ channel: c.channel, msgId: c.msg_id })),
            lastReportedAt: row.last_reported_ts || 0
        });
        updStmt.run(now, row.hash);
    }
    return result;
}

/**
 * Статистика: сколько раз каждый канал встречался в copies (для авто-добавления).
 */
function getSeenInStats() {
    const rows = db.prepare(`
        SELECT channel,
               COUNT(DISTINCT COALESCE(grouped_id, msg_id)) as cnt
        FROM media_copies
        GROUP BY channel
        ORDER BY cnt DESC
    `).all();
    const stats = {};
    for (const r of rows) stats[r.channel] = r.cnt;
    return stats;
}

module.exports = {
    isDuplicate,
    saveToDatabase,
    getTopDuplicates,
    isAlreadyForwarded,
    isAlreadyProcessed,
    markAsForwarded,
    getSeenInStats,
};
