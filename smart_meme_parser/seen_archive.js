/**
 * seen_archive.js — Сверхлёгкий бинарный архив уникальных pHash картинок.
 *
 * Формат файла seen_archive.bin:
 *   Каждая запись = 12 байт:
 *   [0..7]  Int64LE  — pHash картинки (64 бита)
 *   [8..11] UInt32LE — Unix timestamp первого появления (в секундах)
 *
 * Ёмкость:
 *   10 000 картинок = 120 KB
 *   100 000 картинок = 1.2 MB
 *   (против ~25 MB в JSON-формате)
 *
 * Lookup O(1) для точного совпадения (Map<BigInt, number>).
 * Fuzzy lookup O(n) через XOR+popcount — приемлемо до ~200k записей.
 *
 * Автоочистка: при старте удаляет записи старше maxKeepDays (default 30).
 * Фильтрация: checkAndRecord() возвращает firstSeenDaysAgo для принятия решения.
 */

'use strict';
const fs   = require('fs');
const path = require('path');
const Jimp = require('jimp');

const ARCHIVE_PATH = path.join(__dirname, 'seen_archive.bin');
const ENTRY_SIZE   = 12; // 8 + 4 bytes

// Hamming distance между двумя 64-битными BigInt
function hammingBigInt(a, b) {
    let diff = a ^ b;
    let count = 0;
    while (diff > 0n) { count += Number(diff & 1n); diff >>= 1n; }
    return count;
}

// Вычисляет dHash (Difference Hash) 64 бита. Гораздо точнее aHash.
async function computeHash(buffer) {
    const image = await Jimp.read(buffer);
    // Для dHash нужно 9x8
    image.resize(9, 8).grayscale();
    let hash = 0n;
    let bitIndex = 0n;
    
    for (let y = 0; y < 8; y++) {
        for (let x = 0; x < 8; x++) {
            const pLeft = image.bitmap.data[(y * 9 + x) * 4];
            const pRight = image.bitmap.data[(y * 9 + x + 1) * 4];
            if (pLeft > pRight) {
                hash |= (1n << bitIndex);
            }
            bitIndex++;
        }
    }
    return hash;
}

// ─── In-memory индекс: BigInt → unix seconds ─────────────────────────────────
// Инициализируется при первом require()
let archiveIndex = new Map(); // hash → firstSeenTimestamp (seconds)

function loadArchive() {
    try {
        if (!fs.existsSync(ARCHIVE_PATH)) {
            console.log('📦 seen_archive.bin не найден — будет создан при первой записи.');
            return;
        }
        const buf = fs.readFileSync(ARCHIVE_PATH);
        const count = Math.floor(buf.length / ENTRY_SIZE);
        for (let i = 0; i < count; i++) {
            const off = i * ENTRY_SIZE;
            const hash = buf.readBigInt64LE(off);
            const ts   = buf.readUInt32LE(off + 8);
            // Если хэш встречался несколько раз — оставляем САМЫЙ ранний timestamp
            if (!archiveIndex.has(hash) || archiveIndex.get(hash) > ts) {
                archiveIndex.set(hash, ts);
            }
        }
        console.log(`📦 Archive: загружено ${archiveIndex.size} уникальных картинок (${(buf.length/1024).toFixed(1)} KB)`);
    } catch (e) {
        console.error('Archive load error:', e.message);
    }
}

/**
 * Удаляет записи старше maxAgeDays и перезаписывает файл.
 * Вызывать при старте.
 */
function cleanupArchive(maxAgeDays = 30) {
    const cutoff = Math.floor(Date.now() / 1000) - maxAgeDays * 86400;
    let removed = 0;
    for (const [hash, ts] of archiveIndex) {
        if (ts < cutoff) { archiveIndex.delete(hash); removed++; }
    }
    if (removed > 0) {
        _rewriteFile();
        console.log(`🧹 Archive cleanup: удалено ${removed} записей старше ${maxAgeDays} дней`);
    }
}

function _rewriteFile() {
    const buf = Buffer.allocUnsafe(archiveIndex.size * ENTRY_SIZE);
    let off = 0;
    for (const [hash, ts] of archiveIndex) {
        buf.writeBigInt64LE(hash, off);
        buf.writeUInt32LE(ts, off + 8);
        off += ENTRY_SIZE;
    }
    fs.writeFileSync(ARCHIVE_PATH, buf);
}

function _appendEntry(hash, ts) {
    const entry = Buffer.allocUnsafe(ENTRY_SIZE);
    entry.writeBigInt64LE(hash, 0);
    entry.writeUInt32LE(ts, 8);
    fs.appendFileSync(ARCHIVE_PATH, entry);
}

/**
 * Главная функция: проверяет картинку в архиве и записывает если новая.
 *
 * @param {Buffer}  imageBuffer
 * @param {number}  threshold — порог Hamming (default 5, т.е. схожесть >92%)
 * @returns {Promise<{
 *   isNew: boolean,           — false если картинка уже была в архиве
 *   firstSeenTs: number,      — unix seconds первого появления (0 если новая)
 *   firstSeenDaysAgo: number, — дней с первого появления (0 если новая)
 *   hash: BigInt
 * }>}
 */
async function checkAndRecord(imageBuffer, threshold = 5) {
    // Видео — Jimp не умеет, пропускаем
    if (imageBuffer.length > 4 &&
        imageBuffer.slice(4, 8).toString('ascii') === 'ftyp') {
        return { isNew: true, firstSeenTs: 0, firstSeenDaysAgo: 0, hash: 0n };
    }

    let hash;
    try {
        hash = await computeHash(imageBuffer);
    } catch (e) {
        return { isNew: true, firstSeenTs: 0, firstSeenDaysAgo: 0, hash: 0n };
    }

    const nowSec = Math.floor(Date.now() / 1000);

    // 1. Точное совпадение (O(1))
    if (archiveIndex.has(hash)) {
        const ts = archiveIndex.get(hash);
        return {
            isNew:           false,
            firstSeenTs:     ts,
            firstSeenDaysAgo: Math.floor((nowSec - ts) / 86400),
            hash
        };
    }

    // 2. Fuzzy совпадение (O(n))
    for (const [storedHash, ts] of archiveIndex) {
        if (hammingBigInt(hash, storedHash) <= threshold) {
            return {
                isNew:           false,
                firstSeenTs:     ts,
                firstSeenDaysAgo: Math.floor((nowSec - ts) / 86400),
                hash
            };
        }
    }

    // 3. Новая картинка — записываем
    archiveIndex.set(hash, nowSec);
    _appendEntry(hash, nowSec);

    return { isNew: true, firstSeenTs: nowSec, firstSeenDaysAgo: 0, hash };
}

/**
 * Размер архива в памяти и на диске.
 */
function archiveStats() {
    const diskKB = fs.existsSync(ARCHIVE_PATH)
        ? (fs.statSync(ARCHIVE_PATH).size / 1024).toFixed(1)
        : '0';
    return { entries: archiveIndex.size, diskKB };
}

// Инициализируем при загрузке модуля
loadArchive();
// Автоочистка ОТКЛЮЧЕНА — архив хранит всю историю навсегда.
// Для ручной очистки: require('./seen_archive').cleanupArchive(30)

module.exports = { checkAndRecord, cleanupArchive, archiveStats };
