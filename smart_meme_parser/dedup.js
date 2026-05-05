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
async function isDuplicate(imageBuffer, threshold = 5) {
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

/**
 * Возвращает топ N самых копируемых мемов (по hitCount) и сбрасывает их счётчик,
 * чтобы в следующем проходе не выдавать те же самые баяны.
 * @param {number} topN
 * @returns {Array} — отсортированный массив записей
 */
function getTopDuplicates(topN = 2) {
    const top = [...hashCache]
        .filter(e => e.hitCount > 0 && e.channelId && e.messageId)
        .sort((a, b) => (b.hitCount || 0) - (a.hitCount || 0))
        .slice(0, topN);
        
    // Сбрасываем счётчики у выданных, чтобы не спамить ими постоянно
    for (const t of top) {
        const row = hashCache.find(h => h === t);
        if (row) row.hitCount = 0;
    }
    
    if (top.length > 0) saveHashes(hashCache);
    
    return top;
}

/**
 * Проверяет, был ли пост уже переслан (по channel+messageId).
 * Быстрая проверка без pHash — до downloadMedia.
 */
function isAlreadyForwarded(channelId, messageId) {
    return hashCache.some(h => h.channelId === String(channelId) && h.messageId === String(messageId));
}

module.exports = { isDuplicate, saveToDatabase, getTopDuplicates, isAlreadyForwarded };
