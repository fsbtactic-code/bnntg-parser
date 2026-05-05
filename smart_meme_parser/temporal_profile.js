/**
 * temporal_profile.js — Глобальный временной профиль активности.
 *
 * Решает проблему: пост с 500 просмотрами в 2 ночи ГОРАЗДО вирусней,
 * чем пост с 500 просмотрами в 19:00, когда рунет максимально активен.
 *
 * ── Как работает ─────────────────────────────────────────────────────────────
 *
 * Мы накапливаем за каждый проход:
 *   - hourly_velocity[0..23]: средняя скорость просмотров для каждого МСК-часа
 *   - dow_velocity[0..6]:     средняя скорость для каждого дня недели
 *
 * temporal_factor(hour, dow) = геометрическое среднее (hourlyFactor × dowFactor)
 *
 * Применение в формуле виральности:
 *   normalizedVelocity = instantVelocity / temporal_factor(hour, dow)
 *
 * Эффект:
 *   - Ночной пост 3 views/min при factor=0.4 → normalizedVelocity = 7.5
 *   - Вечерний пост 3 views/min при factor=1.5 → normalizedVelocity = 2.0
 *   → Ночной пост ПРАВИЛЬНО получает в 3.75x более высокую виральность
 *
 * ── Защита от нехватки данных ────────────────────────────────────────────────
 *
 * Пока семплов мало (< MIN_SAMPLES на слот) — factor = 1.0 (нейтральный).
 * Коэффициент применяется плавно через clamp [0.2, 5.0] для часов
 * и [0.5, 2.0] для дней недели — защита от выбросов.
 *
 * ── Хранение ─────────────────────────────────────────────────────────────────
 *
 * temporal_profile.json — накапливается бессрочно, растёт на 1KB/год.
 * Каждый проход добавляет семплы, профиль становится точнее.
 *
 * ── Размер ───────────────────────────────────────────────────────────────────
 *
 * Файл: ~2KB (24 float + 7 float + counts + global).
 * Память: <1KB (два массива по 24 и 7 элементов).
 */

'use strict';
const fs   = require('fs');
const path = require('path');

const PROFILE_PATH = path.join(__dirname, 'temporal_profile.json');

// МСК = UTC+3 (без учёта DST — в России DST отменён)
const MSK_OFFSET_H = 3;

// EMA-коэффициент обновления (медленный — для стабильности)
// α=0.05 → ~20 семплов определяют «норму» для данного слота
const EMA_ALPHA = 0.05;

// Минимум семплов до применения коррекции
const MIN_SAMPLES = 15;

// Дни недели на русском для отладки
const DOW_NAMES = ['Вс', 'Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб'];

// ─── Профиль ──────────────────────────────────────────────────────────────────

let profile = null;

function _defaultProfile() {
    return {
        hourly: {
            emaVelocity: new Array(24).fill(0), // средняя velocity по часам МСК
            count:       new Array(24).fill(0),  // кол-во семплов
        },
        dow: {
            emaVelocity: new Array(7).fill(0),  // средняя velocity по дням недели
            count:       new Array(7).fill(0),
        },
        globalAvgVelocity: 0, // EMA всех velocity
        totalSamples:      0,
        updatedAt:         0,
    };
}

function loadProfile() {
    try {
        if (!fs.existsSync(PROFILE_PATH)) {
            profile = _defaultProfile();
            return;
        }
        const raw = JSON.parse(fs.readFileSync(PROFILE_PATH, 'utf8'));
        // Восстанавливаем массивы (JSON не различает Array и Object для числовых ключей)
        profile = _defaultProfile();
        profile.hourly.emaVelocity = Array.from({ length: 24 }, (_, i) => raw.hourly?.emaVelocity?.[i] || 0);
        profile.hourly.count       = Array.from({ length: 24 }, (_, i) => raw.hourly?.count?.[i] || 0);
        profile.dow.emaVelocity    = Array.from({ length: 7  }, (_, i) => raw.dow?.emaVelocity?.[i] || 0);
        profile.dow.count          = Array.from({ length: 7  }, (_, i) => raw.dow?.count?.[i] || 0);
        profile.globalAvgVelocity  = raw.globalAvgVelocity || 0;
        profile.totalSamples       = raw.totalSamples || 0;
        profile.updatedAt          = raw.updatedAt || 0;

        const totalH = profile.hourly.count.reduce((a, b) => a + b, 0);
        console.log(`⏱ Temporal profile: ${totalH} семплов (часовой профиль готов на ${profile.hourly.count.filter(c => c >= MIN_SAMPLES).length}/24 слотах)`);
    } catch (e) {
        console.error('Temporal profile load error:', e.message);
        profile = _defaultProfile();
    }
}

function saveProfile() {
    try {
        profile.updatedAt = Date.now();
        fs.writeFileSync(PROFILE_PATH, JSON.stringify(profile));
    } catch (e) {
        console.error('Temporal profile save error:', e.message);
    }
}

// ─── Обновление ──────────────────────────────────────────────────────────────

/**
 * Обновляет временной профиль одним семплом.
 *
 * Вызывать для КАЖДОГО поста в проходе (включая не прошедшие фильтр),
 * чтобы накапливать как можно больше данных о нормальном поведении.
 *
 * @param {number} viewsPerMin  — скорость просмотров (views / ageMin)
 * @param {number} postDateMs   — unix timestamp публикации поста (мс)
 */
function updateProfile(viewsPerMin, postDateMs) {
    if (!profile) return;
    if (!viewsPerMin || viewsPerMin <= 0 || !postDateMs) return;

    // Переводим в МСК-время
    const mskDate = new Date(postDateMs + MSK_OFFSET_H * 3600000);
    const hour    = mskDate.getUTCHours(); // 0-23 МСК
    const dow     = mskDate.getUTCDay();   // 0=Вс, 1=Пн, ..., 6=Сб

    // ── Часовое обновление (EMA) ──────────────────────────────────────────
    const hPrev = profile.hourly.emaVelocity[hour];
    const hN    = profile.hourly.count[hour];
    // При первом семпле → инициализируем напрямую; затем → EMA
    profile.hourly.emaVelocity[hour] = hN === 0
        ? viewsPerMin
        : EMA_ALPHA * viewsPerMin + (1 - EMA_ALPHA) * hPrev;
    profile.hourly.count[hour]++;

    // ── Обновление по дню недели (EMA) ───────────────────────────────────
    const dPrev = profile.dow.emaVelocity[dow];
    const dN    = profile.dow.count[dow];
    profile.dow.emaVelocity[dow] = dN === 0
        ? viewsPerMin
        : EMA_ALPHA * viewsPerMin + (1 - EMA_ALPHA) * dPrev;
    profile.dow.count[dow]++;

    // ── Глобальное среднее (ещё медленнее для стабильности) ──────────────
    profile.totalSamples++;
    const gAlpha = profile.totalSamples === 1 ? 1.0 : EMA_ALPHA * 0.5;
    profile.globalAvgVelocity = profile.totalSamples === 1
        ? viewsPerMin
        : gAlpha * viewsPerMin + (1 - gAlpha) * profile.globalAvgVelocity;
}

// ─── Применение поправки ──────────────────────────────────────────────────────

/**
 * Возвращает временной поправочный коэффициент для данного момента публикации.
 *
 * factor > 1.0 → «оживлённое» время (вечер, пятница) → просмотры выше нормы
 * factor < 1.0 → «тихое» время (ночь, вторник) → просмотры ниже нормы
 * factor = 1.0 → нет данных или слот не накопил MIN_SAMPLES
 *
 * @param {number} postDateMs
 * @returns {number}
 */
function getTemporalFactor(postDateMs) {
    if (!profile || !postDateMs || profile.globalAvgVelocity <= 0) return 1.0;

    const mskDate = new Date(postDateMs + MSK_OFFSET_H * 3600000);
    const hour    = mskDate.getUTCHours();
    const dow     = mskDate.getUTCDay();

    // ── Часовой фактор ──
    let hourlyFactor = 1.0;
    if (profile.hourly.count[hour] >= MIN_SAMPLES) {
        hourlyFactor = profile.hourly.emaVelocity[hour] / profile.globalAvgVelocity;
        // Clamp: не даём уходить в экстремумы (защита от выбросов на старте)
        hourlyFactor = Math.max(0.2, Math.min(5.0, hourlyFactor));
    }

    // ── Дневной фактор ──
    let dowFactor = 1.0;
    if (profile.dow.count[dow] >= MIN_SAMPLES) {
        dowFactor = profile.dow.emaVelocity[dow] / profile.globalAvgVelocity;
        dowFactor = Math.max(0.5, Math.min(2.0, dowFactor));
    }

    // ── Комбинированный: геометрическое среднее (чтобы не двойной счёт) ──
    const combined = Math.sqrt(hourlyFactor * dowFactor);
    return Math.round(combined * 1000) / 1000; // 3 знака
}

// ─── Отладка ──────────────────────────────────────────────────────────────────

/**
 * Возвращает читаемую таблицу часового профиля.
 */
function profileDebug() {
    if (!profile) return 'Profile not loaded';
    const g = profile.globalAvgVelocity;
    const lines = ['⏱ Hourly temporal profile (МСК):'];
    for (let h = 0; h < 24; h++) {
        const ema = profile.hourly.emaVelocity[h];
        const n   = profile.hourly.count[h];
        const f   = (g > 0 && n >= MIN_SAMPLES) ? (ema / g).toFixed(2) : '?';
        const bar = n >= MIN_SAMPLES ? '█'.repeat(Math.round(parseFloat(f) * 3 || 0)).slice(0, 15) : '···';
        lines.push(`  ${String(h).padStart(2,'0')}:xx  factor=${f}  samples=${n}  ${bar}`);
    }
    lines.push(`\n📅 DOW profile:`);
    for (let d = 0; d < 7; d++) {
        const ema = profile.dow.emaVelocity[d];
        const n   = profile.dow.count[d];
        const f   = (g > 0 && n >= MIN_SAMPLES) ? (ema / g).toFixed(2) : '?';
        lines.push(`  ${DOW_NAMES[d]}  factor=${f}  samples=${n}`);
    }
    lines.push(`\n🌐 Global avg velocity: ${g.toFixed(3)} views/min  |  Total samples: ${profile.totalSamples}`);
    return lines.join('\n');
}

/**
 * Краткая статистика для итогового отчёта.
 */
function profileStats() {
    if (!profile) return { totalSamples: 0, readyHours: 0, readyDays: 0 };
    return {
        totalSamples: profile.totalSamples,
        readyHours:   profile.hourly.count.filter(c => c >= MIN_SAMPLES).length,
        readyDays:    profile.dow.count.filter(c => c >= MIN_SAMPLES).length,
        globalAvg:    profile.globalAvgVelocity,
    };
}

// ── Init ──────────────────────────────────────────────────────────────────────
loadProfile();

module.exports = { updateProfile, getTemporalFactor, saveProfile, profileStats, profileDebug };
