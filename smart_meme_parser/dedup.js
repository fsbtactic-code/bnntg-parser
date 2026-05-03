/**
 * dedup.js — Анти-баян на базе pHash.
 * Хранит хэши в JSON-файле вместо SQLite для совместимости на любой платформе.
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
 * @returns {boolean}
 */
async function isDuplicate(imageBuffer, threshold = 5) {
    try {
        // Для видео (mp4) Jimp не работает — пропускаем pHash, опираемся на ID-дедуп (channelId+messageId)
        const isVideo = imageBuffer.length > 4 &&
            (imageBuffer[0] === 0 && imageBuffer[4] === 0x66 && imageBuffer[5] === 0x74 && imageBuffer[6] === 0x79 && imageBuffer[7] === 0x70) ||
            (imageBuffer.slice(4,8).toString('ascii') === 'ftyp'); // mp4 signature
        if (isVideo) return false; // видео проверяем только по ID (см. saveToDatabase)

        const newHash = await getPHash(imageBuffer);
        for (const row of hashCache) {
            if (row.hash && hammingDistance(newHash, row.hash) <= threshold) return true;
        }
        return false;
    } catch (e) {
        console.error('❌ pHash error:', e.message);
        return false; // При ошибке не блокируем
    }
}

/**
 * Сохраняет хэш мема в базу анти-баяна.
 */
async function saveToDatabase(imageBuffer, messageId, channelId) {
    try {
        // Для видео используем ID-идентификатор вместо pHash
        let hash;
        try {
            hash = await getPHash(imageBuffer);
        } catch (e) {
            // видео или неподдерживаемый формат — используем ID
            hash = null;
        }
        const entry = { hash, messageId: String(messageId), channelId: String(channelId), ts: Date.now() };
        hashCache.push(entry);
        if (hashCache.length > 50000) hashCache = hashCache.slice(-50000);
        saveHashes(hashCache);
    } catch (e) {
        console.error('❌ saveToDatabase error:', e.message);
    }
}

module.exports = { isDuplicate, saveToDatabase };
