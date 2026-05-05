/**
 * dedup.js — Анти-баян на базе pHash.
 * Хранит хэши в JSON-файле вместо SQLite для совместимости на любой платформе.
 * Добавлен hitCount — счётчик сколько раз мем найден как баян.
 */

const Jimp = require('jimp');
const fs = require('fs');
const path = require('path');

const HASHES_PATH = path.join(__dirname, 'hashes.json');

function loadHashes() {
    try {
        if (!fs.existsSync(HASHES_PATH)) return [];
        return JSON.parse(fs.readFileSync(HASHES_PATH, 'utf8'));
    } catch (e) { return []; }
}

function saveHashes(hashes) {
    fs.writeFileSync(HASHES_PATH, JSON.stringify(hashes));
}

// Держим в памяти для скорости
let hashCache = loadHashes();

/**
 * Вычисляет Perceptual Hash (pHash) 8×8 для картинки.
 * @param {Buffer} buffer
 * @returns {string} 64-символьная бинарная строка
 */
async function getPHash(buffer) {
    const image = await Jimp.read(buffer);
    image.resize(8, 8).grayscale();

    let total = 0;
    const pixels = [];
    image.scan(0, 0, image.bitmap.width, image.bitmap.height, function(x, y, idx) {
        const v = this.bitmap.data[idx];
        total += v;
        pixels.push(v);
    });

    const avg = total / pixels.length;
    return pixels.map(p => p >= avg ? '1' : '0').join('');
}

function hammingDistance(h1, h2) {
    let d = 0;
    for (let i = 0; i < 64; i++) if (h1[i] !== h2[i]) d++;
    return d;
}

/**
 * Проверяет, является ли картинка дубликатом (баяном).
 * @param {Buffer} imageBuffer
 * @param {number} threshold  — допустимая разница (default 5, т.е. схожесть >92%)
 * @returns {object|false} — matched entry (с channel/messageId/hitCount) или false
 */
async function isDuplicate(imageBuffer, channel = null, msgId = null, threshold = 5) {
    try {
        // Для видео (mp4) Jimp не работает — пропускаем pHash, опираемся на ID-дедуп
        const isVideo = imageBuffer.length > 4 &&
            (imageBuffer[0] === 0 && imageBuffer[4] === 0x66 && imageBuffer[5] === 0x74 && imageBuffer[6] === 0x79 && imageBuffer[7] === 0x70) ||
            (imageBuffer.slice(4,8).toString('ascii') === 'ftyp');
        if (isVideo) return false;

        const newHash = await getPHash(imageBuffer);
        for (const row of hashCache) {
            if (row.hash && hammingDistance(newHash, row.hash) <= threshold) {
                // Инкрементируем счётчик попаданий и сохраняем
                row.hitCount = (row.hitCount || 0) + 1;
                
                if (channel && msgId) {
                    row.seenIn = row.seenIn || [];
                    if (!row.seenIn.some(x => x.channel === channel && x.msgId === msgId)) {
                        row.seenIn.push({ channel, msgId });
                        // Ограничиваем историю 20 последними каналами, чтобы не раздувать базу
                        if (row.seenIn.length > 20) row.seenIn.shift();
                    }
                }
                
                saveHashes(hashCache);
                return row; // возвращаем matched entry с channel/messageId/hitCount
            }
        }
        return false;
    } catch (e) {
        console.error('❌ pHash error:', e.message);
        return false;
    }
}

/**
 * Сохраняет хэш мема в базу анти-баяна.
 */
async function saveToDatabase(imageBuffer, messageId, channelId) {
    try {
        let hash;
        try {
            hash = await getPHash(imageBuffer);
        } catch (e) {
            hash = null; // видео — используем ID-идентификатор
        }
        const entry = {
            hash,
            messageId: String(messageId),
            channelId: String(channelId),
            hitCount: 0,
            ts: Date.now()
        };
        hashCache.push(entry);
        if (hashCache.length > 50000) hashCache = hashCache.slice(-50000);
        saveHashes(hashCache);
    } catch (e) {
        console.error('❌ saveToDatabase error:', e.message);
    }
}

const REPORT_COOLDOWN_MS = 24 * 60 * 60 * 1000; // 24 часа

/**
 * Возвращает топ N самых копируемых мемов с учётом 24-часового кулдауна.
 *
 * Логика:
 *  - Если картинка уже была показана менее 24ч назад — пропускаем (даже если hitCount вырос).
 *  - Если прошло >24ч и картинка снова набрала новые попадания — показываем как новый баян.
 *  - При выдаче сбрасываем hitCount и ставим lastReportedAt = now.
 *
 * @param {number} topN
 * @returns {Array} — отсортированный массив записей (только те, что не в кулдауне)
 */
function getTopDuplicates(topN = 2) {
    const now = Date.now();

    const top = [...hashCache]
        .filter(e => {
            if (!e.hitCount || e.hitCount <= 0) return false;       // нет новых попаданий
            if (!e.channelId || !e.messageId) return false;          // нет источника
            // Пропускаем если показывали менее 24ч назад
            if (e.lastReportedAt && (now - e.lastReportedAt) < REPORT_COOLDOWN_MS) return false;
            return true;
        })
        .sort((a, b) => (b.hitCount || 0) - (a.hitCount || 0))
        .slice(0, topN);

    // Сбрасываем hitCount и ставим метку времени выдачи
    for (const t of top) {
        const row = hashCache.find(h => h === t);
        if (row) {
            row.hitCount = 0;
            row.lastReportedAt = now;
        }
    }

    if (top.length > 0) saveHashes(hashCache);

    return top;
}

const FORWARD_BLOCK_MS = 48 * 60 * 60 * 1000; // 48 часов

/**
 * Проверяет, был ли пост уже переслан (по channel+messageId) за последние 48ч.
 * Быстрая проверка без pHash — до downloadMedia.
 * Старые записи (>48ч) не блокируют — иначе популярные каналы вечно в бане.
 * pHash-дедупликация в isDuplicate() защищает от повторных картинок независимо.
 */
function isAlreadyForwarded(channelId, messageId) {
    const cutoff = Date.now() - FORWARD_BLOCK_MS;
    return hashCache.some(h =>
        h.channelId === String(channelId) &&
        h.messageId === String(messageId) &&
        (h.ts || 0) >= cutoff
    );
}

module.exports = { isDuplicate, saveToDatabase, getTopDuplicates, isAlreadyForwarded };
