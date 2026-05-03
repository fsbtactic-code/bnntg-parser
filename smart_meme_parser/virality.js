/**
 * ═══════════════════════════════════════════════════════════════
 *  BANANA MEME ENGINE · Virality Intelligence System v2.0
 * ═══════════════════════════════════════════════════════════════
 *
 *  Многоуровневая система оценки виральности постов.
 *  Главная идея: маленький канал с аномальной активностью
 *  важнее большого канала со средней активностью.
 *
 *  Уровни:
 *  1. Channel Memory (EMA)       — накопленная норма канала
 *  2. Relative Virality Index    — аномалия относительно нормы
 *  3. Size-Adjusted Score        — бонус малым каналам
 *  4. Exponential Freshness      — экспоненциальное затухание
 *  5. Reaction Diversity Bonus   — разнообразие типов реакций
 *  6. Adaptive Session Threshold — порог зависит от текущей сессии
 * ═══════════════════════════════════════════════════════════════
 */

const fs = require('fs');
const MEMORY_PATH = './channel_memory.json';

// ─── Channel Memory ──────────────────────────────────────────────────────────

/**
 * Загружает всю память каналов из файла.
 * @returns {Object} { channelName: { avg_er, avg_velocity, avg_views, post_count, last_updated } }
 */
function loadMemory() {
    try {
        if (!fs.existsSync(MEMORY_PATH)) return {};
        return JSON.parse(fs.readFileSync(MEMORY_PATH, 'utf8'));
    } catch (e) {
        return {};
    }
}

/**
 * Сохраняет обновлённую память на диск.
 */
function saveMemory(memory) {
    fs.writeFileSync(MEMORY_PATH, JSON.stringify(memory, null, 2));
}

/**
 * Обновляет EMA-память канала по одному посту.
 * α = 0.15 → учитываем примерно 6-7 последних наблюдений.
 *
 * @param {Object|null} mem    — текущая запись памяти (null если первый раз)
 * @param {number} views
 * @param {number} reactions
 * @param {number} comments
 * @param {number} postDateMs
 * @returns {Object} обновлённая запись
 */
function updateMemory(mem, views, reactions, comments, postDateMs) {
    const α = 0.15;
    const ageMin = Math.max((Date.now() - postDateMs) / 60000, 1);
    const er       = (reactions + comments * 1.5) / Math.max(views, 1);
    const velocity = reactions / (ageMin + 5);
    const effectiveViews = Math.max(views, 1);

    if (!mem || !mem.post_count) {
        return {
            avg_er:       er,
            avg_velocity: velocity,
            avg_views:    effectiveViews,
            post_count:   1,
            last_updated: Date.now()
        };
    }

    return {
        avg_er:       α * er           + (1 - α) * mem.avg_er,
        avg_velocity: α * velocity     + (1 - α) * mem.avg_velocity,
        avg_views:    α * effectiveViews + (1 - α) * mem.avg_views,
        post_count:   mem.post_count + 1,
        last_updated: Date.now()
    };
}

// ─── Core Scoring ────────────────────────────────────────────────────────────

/**
 * Конвертирует строку подписчиков ("1.2K", "500K", "3M") в число.
 */
function parseSubs(raw) {
    if (!raw || raw === '?' || raw === 'Unknown') return null;
    const s = String(raw).trim().replace(',', '.').toUpperCase();
    if (s.endsWith('M')) return parseFloat(s) * 1_000_000;
    if (s.endsWith('K')) return parseFloat(s) * 1_000;
    return parseFloat(s) || null;
}

/**
 * Мультипликатор размера: даёт бонус маленьким каналам.
 *
 * Формула: 1 + log₁₀(10000 / max(subs, 100)) × 0.5
 *   100 подп  → ×2.0   (малый канал, первооткрыватель)
 *   1 000     → ×1.65
 *   10 000    → ×1.0   (нейтральная точка)
 *   50 000    → ×0.63
 *   500 000   → ×0.15  (большой — абсолютные числа не впечатляют)
 *
 * @param {number|null} subscribers
 * @returns {number}
 */
function sizeMultiplier(subscribers) {
    const subs = subscribers || 10_000; // нет данных → нейтраль
    const clamped = Math.max(subs, 100);
    const m = 1 + Math.log10(Math.max(10_000 / clamped, 1)) * 0.5;
    return Math.max(m, 0.1); // нижний порог 0.1
}

/**
 * Экспоненциальное затухание свежести.
 * Период полураспада ≈ 42 минуты (при τ=60).
 *
 * 5 мин  → 0.92
 * 15 мин → 0.78
 * 30 мин → 0.61  ← наш 30-минутный порог
 * 60 мин → 0.37
 *
 * @param {number} postDateMs
 * @returns {number} [0..1]
 */
function freshnessFactor(postDateMs) {
    const ageMin = (Date.now() - postDateMs) / 60000;
    return Math.exp(-ageMin / 60);
}

/**
 * Бонус разнообразия реакций.
 * Если у поста много разных типов реакций — он цепляет широкую аудиторию.
 *
 * @param {Array} reactionResults  — массив { count, reaction } из Telegram API
 * @returns {number} множитель [1.0..1.5]
 */
function reactionDiversityBonus(reactionResults) {
    if (!reactionResults || reactionResults.length === 0) return 1.0;
    const activeTypes = reactionResults.filter(r => r.count > 0).length;
    // Каждый дополнительный тип → +8%, максимум ×1.5
    return Math.min(1 + (activeTypes - 1) * 0.08, 1.5);
}

/**
 * Главная функция расчёта Composite Final Score.
 *
 * Алгоритм:
 *   1. Базовые метрики (ER, Velocity)
 *   2. RVI — аномалия относительно нормы канала
 *      (если памяти нет → fallback на абсолютный VI)
 *   3. Size Multiplier
 *   4. Freshness
 *   5. Diversity Bonus
 *
 * @param {number} views
 * @param {number} reactions
 * @param {number} comments
 * @param {number} postDateMs
 * @param {Object|null} channelMem     — запись из loadMemory()[channel]
 * @param {string|number|null} rawSubs — строка "1.2K" или число
 * @param {Array|null} reactionResults — детализация реакций
 * @returns {{ cfs: number, rvi: number, freshness: number, sizeM: number }}
 */
function calculateVirality(views, reactions, comments, postDateMs, channelMem = null, rawSubs = null, reactionResults = null) {
    if (!views || views === 0) return { cfs: 0, rvi: 0, freshness: 0, sizeM: 1 };

    const ageMin   = Math.max((Date.now() - postDateMs) / 60000, 0.5);
    const er       = (reactions + comments * 1.5) / Math.max(views, 1);
    const velocity = reactions / (ageMin + 5); // +5 мин защита от деления на ноль

    // ── RVI ───────────────────────────────────────────────────────────────
    let rvi;
    if (channelMem && channelMem.post_count >= 5) {
        // У канала достаточно истории (≥5 постов) — считаем реальную аномалию
        const erRatio  = channelMem.avg_er       > 0 ? er       / channelMem.avg_er       : 1;
        const velRatio = channelMem.avg_velocity  > 0 ? velocity / channelMem.avg_velocity  : 1;
        // Геометрическое среднее двух аномалий (устойчивее к выбросам)
        rvi = Math.sqrt(erRatio * velRatio);
    } else {
        // Нет достаточной истории — консервативный абсолютный скор
        // er нормируем: 1% ER (0.01) при 100 views → нейтраль ≈ 1.0
        // Формула: sqrt(er * 100) нормирует: er=0.01→1.0, er=0.04→2.0, er=0.09→3.0
        const erNorm = Math.sqrt(Math.min(er * 100, 9)); // max 3.0 при er≥9%
        // Velocity нормируем аналогично: log10(velocity+1) / log10(10) = log10(vel+1)
        // velocity=1 → 0.3, velocity=9 → 0.5, velocity=99 → 0.5 (log10)
        const velNorm = Math.min(Math.log10(velocity + 1) / Math.log10(10), 1.0);
        rvi = Math.min(erNorm * (0.7 + 0.3 * velNorm), 3.0); // жёсткий кап 3.0 при нет истории
    }


    // ── Size ──────────────────────────────────────────────────────────────
    const subs = parseSubs(rawSubs);
    const sizeM = sizeMultiplier(subs);

    // ── Freshness ─────────────────────────────────────────────────────────
    const fresh = freshnessFactor(postDateMs);

    // ── Reaction Diversity ────────────────────────────────────────────────
    const divBonus = reactionDiversityBonus(reactionResults);

    // ── Composite Final Score ─────────────────────────────────────────────
    const cfs = rvi * sizeM * fresh * divBonus * 10_000;

    return {
        cfs:      Math.round(cfs),
        rvi:      Math.round(rvi * 100) / 100,
        freshness: Math.round(fresh * 100) / 100,
        sizeM:    Math.round(sizeM * 100) / 100,
        divBonus: Math.round(divBonus * 100) / 100,
    };
}

// ─── Adaptive Session Threshold ──────────────────────────────────────────────

/**
 * Адаптивный порог публикации.
 * Считаем как СРЕДНЕЕ CFS по всем кандидатам × multiplier.
 *
 * multiplier = 1.5 → публикуем только то, что на 50% выше среднего.
 * Если кандидатов мало (< 5) — снижаем требования.
 *
 * @param {number[]} allScores — массив CFS всех кандидатов
 * @returns {number} порог
 */
function adaptiveThreshold(allScores) {
    if (!allScores || allScores.length === 0) return 0;
    const mean = allScores.reduce((s, v) => s + v, 0) / allScores.length;
    const multiplier = allScores.length < 5 ? 1.2 : 1.5;
    return mean * multiplier;
}

// ─── Exports ─────────────────────────────────────────────────────────────────

module.exports = {
    calculateVirality,
    updateMemory,
    loadMemory,
    saveMemory,
    adaptiveThreshold,
    parseSubs,
    sizeMultiplier,
    freshnessFactor,
    reactionDiversityBonus,
};
