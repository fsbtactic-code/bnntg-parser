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
    // null/undefined → канал неизвестный размер. Даём лёгкий бонус (×1.2)
    // т.к. неизвестные каналы скорее малые чем крупные
    if (!subscribers) return 1.2;
    const clamped = Math.max(subscribers, 100);
    const m = 1 + Math.log10(Math.max(10_000 / clamped, 1)) * 0.5;
    return Math.max(m, 0.1);
}

/**
 * Экспоненциальное затухание свежести с учетом моментума.
 * Период полураспада ≈ 42 минуты (при τ=60).
 * Теперь старение замедляется, если пост обладает аномальной скоростью (velRatio).
 *
 * @param {number} postDateMs
 * @param {number} velRatio - Отношение текущей скорости к средней по каналу
 * @returns {number} [0..1]
 */
function freshnessFactor(postDateMs, velRatio = 1) {
    const ageMin = Math.max((Date.now() - postDateMs) / 60000, 0);
    // Гравитационная свежесть: замедляем время для "горячих" постов
    // Кап momentumBonus=2 чтобы не дублировать бонус с RVI в CFS
    const momentumBonus = Math.max(0, Math.min(2, Math.log2(Math.max(1, velRatio))));
    const effectiveAgeMin = ageMin / (1 + momentumBonus);
    return Math.exp(-effectiveAgeMin / 60);
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

// ─── Post Snapshots (Dynamic Virality) ───────────────────────────────────────
const SNAPSHOTS_PATH = './post_snapshots.json';

function loadSnapshots() {
    try {
        if (!fs.existsSync(SNAPSHOTS_PATH)) return {};
        return JSON.parse(fs.readFileSync(SNAPSHOTS_PATH, 'utf8'));
    } catch (e) {
        return {};
    }
}

function saveSnapshots(snaps) {
    fs.writeFileSync(SNAPSHOTS_PATH, JSON.stringify(snaps));
}

function cleanOldSnapshots(snaps) {
    const now = Date.now();
    let changed = false;
    for (const key in snaps) {
        const history = snaps[key];
        if (!history || history.length === 0) {
            delete snaps[key]; changed = true; continue;
        }
        const lastSnap = history[history.length - 1];
        // Если последний снепшот был более 48 часов назад — чистим
        if (now - lastSnap.time > 48 * 60 * 60 * 1000) {
            delete snaps[key];
            changed = true;
        }
    }
    return changed;
}

function updateAndGetMomentum(channel, msgId, views, reactions) {
    const snaps = loadSnapshots();
    let changed = cleanOldSnapshots(snaps);
    
    const key = `${channel}_${msgId}`;
    if (!snaps[key]) snaps[key] = [];
    
    const history = snaps[key];
    const now = Date.now();
    
    let instVelocityViews = 0;
    let instVelocityReactions = 0;
    
    if (history.length > 0) {
        const last = history[history.length - 1];
        const timeDeltaMs = now - last.time;
        // Сохраняем снепшот, если прошло хотя бы 10 минут
        if (timeDeltaMs >= 10 * 60 * 1000) {
            const timeDeltaMin = timeDeltaMs / 60000;
            instVelocityViews = (views - last.views) / timeDeltaMin;
            instVelocityReactions = (reactions - last.reactions) / timeDeltaMin;
            
            history.push({ time: now, views, reactions });
            changed = true;
        } else {
            // Если прошло меньше 10 минут, считаем по предыдущему (если есть), не сохраняя новый
            if (history.length >= 2) {
                const prev = history[history.length - 2];
                const dMin = (now - prev.time) / 60000;
                instVelocityViews = (views - prev.views) / Math.max(dMin, 1);
                instVelocityReactions = (reactions - prev.reactions) / Math.max(dMin, 1);
            }
        }
    } else {
        history.push({ time: now, views, reactions });
        changed = true;
    }
    
    if (history.length > 5) snaps[key] = history.slice(-5);
    if (changed) saveSnapshots(snaps);
    
    return {
        instVelocityViews: Math.max(0, instVelocityViews),
        instVelocityReactions: Math.max(0, instVelocityReactions)
    };
}


/**
 * Главная функция расчёта Composite Final Score.
 *
 * @param {number} views
 * @param {number} reactions
 * @param {number} comments
 * @param {number} postDateMs
 * @param {Object|null} channelMem     — запись из loadMemory()[channel]
 * @param {string|number|null} rawSubs — строка "1.2K" или число
 * @param {Array|null} reactionResults — детализация реакций
 * @param {string|null} channelName    — username канала (для снепшотов)
 * @param {number|null} msgId          — ID сообщения (для снепшотов)
 * @returns {{ cfs: number, rvi: number, freshness: number, sizeM: number, momentumR: number, momentumV: number }}
 */
function calculateVirality(views, reactions, comments, postDateMs, channelMem = null, rawSubs = null, reactionResults = null, channelName = null, msgId = null, temporalFactor = 1.0) {
    if (!views || views === 0) return { cfs: 0, rvi: 0, freshness: 0, sizeM: 1, momentumR: 0, momentumV: 0 };

    let momentumR = 0;
    let momentumV = 0;
    if (channelName && msgId) {
        const mom = updateAndGetMomentum(channelName, msgId, views, reactions);
        momentumR = mom.instVelocityReactions;
        momentumV = mom.instVelocityViews;
    }

    const ageMin   = Math.max((Date.now() - postDateMs) / 60000, 0.5);
    
    // ── Адаптивное байесовское сглаживание ───────────────────────────────────
    // bayesianC зависит от размера канала: маленький пул → сильнее сглаживаем
    // Для 1000 просмотров: C=50 (почти не влияет). Для 100 просмотров: C=200 (умеренно).
    const bayesianC = Math.round(5000 / Math.max(views, 50));
    const priorER = (channelMem && channelMem.avg_er > 0) ? channelMem.avg_er : 0.03;
    const er = (reactions + comments * 1.5 + bayesianC * priorER) / (Math.max(views, 1) + bayesianC);
    
    const velocity = reactions / (ageMin + 5);
    // Нормализуем velocity по временному фактору:
    // если сейчас час-пик (tFactor=1.5) — «сырая» velocity завышена, делим на фактор
    // если ночь (tFactor=0.5) — velocity заниженная, делим и получаем «справедливую» цифру
    const adjVelocity = velocity / Math.max(temporalFactor, 0.1);

    // ── Сигнал комментариев ───────────────────────────────────────────────────
    // Комментарий = более сильный сигнал чем просмотр, добавляем его отдельно
    // Нормализуем: много комментариев при малых просмотрах → высокий сигнал
    const commentSignal = Math.log1p(comments) / Math.log1p(Math.max(views / 100, 1));

    // ── RVI ───────────────────────────────────────────────────────────────────
    let rvi;
    let velRatio = 1;
    if (channelMem && channelMem.post_count >= 5) {
        const erRatio  = channelMem.avg_er       > 0 ? er       / channelMem.avg_er       : 1;
        // Используем adjVelocity — velocity нормализованная по времени суток
        velRatio = channelMem.avg_velocity  > 0 ? adjVelocity / channelMem.avg_velocity  : 1;
        // Геометрическое среднее двух аномалий + небольшой вес комментариев
        rvi = Math.sqrt(erRatio * velRatio) * (1 + commentSignal * 0.1);
    } else {
        // Нет достаточной истории — консервативный абсолютный скор
        const erNorm = Math.sqrt(Math.min(er * 100, 9));
        const velNorm = Math.min(Math.log10(adjVelocity + 1) / Math.log10(10), 1.0);
        rvi = Math.min(erNorm * (0.7 + 0.3 * velNorm) * (1 + commentSignal * 0.1), 3.0);
    }

    // Моментум в velRatio для гравитационной свежести
    // Если мгновенная скорость больше средней — используем мгновенную
    if (channelMem && channelMem.avg_velocity > 0 && momentumR > velocity) {
        velRatio = Math.max(velRatio, momentumR / channelMem.avg_velocity);
    }

    // ── Size ──────────────────────────────────────────────────────────────────
    const subs = parseSubs(rawSubs);
    const sizeM = sizeMultiplier(subs);

    // ── Freshness ─────────────────────────────────────────────────────────────
    const fresh = freshnessFactor(postDateMs, velRatio);

    // ── Reaction Diversity ────────────────────────────────────────────────────
    const divBonus = reactionDiversityBonus(reactionResults);

    // ── Composite Final Score ─────────────────────────────────────────────────
    // CFS = RVI × sizeM × freshness × diversityBonus
    const cfs = rvi * sizeM * fresh * divBonus * 10_000;

    return {
        cfs:      Math.round(cfs),
        rvi:      Math.round(rvi * 100) / 100,
        freshness: Math.round(fresh * 100) / 100,
        sizeM:    Math.round(sizeM * 100) / 100,
        divBonus: Math.round(divBonus * 100) / 100,
        momentumR: Math.round(momentumR * 100) / 100,
        momentumV: Math.round(momentumV * 100) / 100
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

// ─── Micro-Viral Detection Engine ────────────────────────────────────────────
//
// Для каналов < 1000 подписчиков абсолютные числа (views, reactions) малы,
// но пост может быть вирусным ОТНОСИТЕЛЬНО нормы этого канала.
//
// MCVI (Micro Channel Viral Index) = насколько пост аномален для своего канала:
//   viewsRatio  = views / avg_views_канала    → в 3x больше обычного = сигнал
//   erRatio     = er / avg_er_канала          → в 2x больше реакций на просмотр = сигнал
//   velBonus    = velocity / avg_velocity     → рост быстрее обычного = бонус
//   freshness   = exp decay с τ=90мин        → чуть медленнее стареет (посты выходят редко)
//
// Результат: MCVI ≥ 2.0 считается вирусным для микроканала.

/**
 * @param {number} views
 * @param {number} reactions
 * @param {number} comments
 * @param {number} postDateMs
 * @param {Object|null} channelMem  — EMA-память канала (из loadMemory)
 * @param {Array|null} reactionResults
 * @param {string|null} channelName
 * @param {number|null} msgId
 * @returns {{ mcvi, viewsRatio, erRatio, freshness, momentumV }}
 */
function calculateMicroVirality(views, reactions, comments, postDateMs, channelMem = null, reactionResults = null, channelName = null, msgId = null) {
    if (!views || views === 0) return { mcvi: 0, viewsRatio: 0, erRatio: 0, freshness: 0, momentumV: 0 };

    let momentumV = 0;
    let momentumR = 0;
    if (channelName && msgId) {
        const mom = updateAndGetMomentum(channelName, msgId, views, reactions);
        momentumV = mom.instVelocityViews;
        momentumR = mom.instVelocityReactions;
    }

    const ageMin = Math.max((Date.now() - postDateMs) / 60000, 0.5);
    const er = (reactions + comments * 1.5) / Math.max(views, 1);
    const velocity = views / (ageMin + 10); // просмотры/мин (защита малой базой)

    // ── Относительные аномалии против нормы канала ───────────────────────
    const avgViews    = (channelMem && channelMem.avg_views    > 0) ? channelMem.avg_views    : views * 0.5;
    const avgER       = (channelMem && channelMem.avg_er       > 0) ? channelMem.avg_er       : 0.03;
    const avgVelocity = (channelMem && channelMem.avg_velocity > 0) ? channelMem.avg_velocity : 0.1;

    // Отношение просмотров: ключевой сигнал для микроканала
    const viewsRatio = views / Math.max(avgViews, 3);

    // Отношение ER: реакционность аномалия
    const erRatio = er / Math.max(avgER, 0.01);

    // Бонус мгновенной скорости (momentum):
    // Если пост набирает просмотры быстрее чем обычно — это прорыв
    const velRatio = momentumV > 0
        ? momentumV / Math.max(avgVelocity, 0.01)
        : velocity / Math.max(avgVelocity, 0.01);
    const velBonus = 1 + Math.log1p(Math.max(0, velRatio - 1)) * 0.3;

    // Геометрическое среднее ключевых аномалий (устойчиво к выбросам)
    const anomalyScore = Math.sqrt(viewsRatio * erRatio);

    // Свежесть: τ=90мин (микроканалы постят реже, свежесть важна дольше)
    const fresh = Math.exp(-ageMin / 90);

    // Бонус разнообразия реакций
    const divBonus = reactionDiversityBonus(reactionResults);

    // MCVI = аномалия × бонус скорости × свежесть × разнообразие
    const mcvi = anomalyScore * velBonus * fresh * divBonus;

    return {
        mcvi:       Math.round(mcvi * 100) / 100,
        viewsRatio: Math.round(viewsRatio * 100) / 100,
        erRatio:    Math.round(erRatio * 100) / 100,
        freshness:  Math.round(fresh * 100) / 100,
        momentumV:  Math.round(momentumV * 100) / 100,
        momentumR:  Math.round(momentumR * 100) / 100,
    };
}

// ─── Exports ─────────────────────────────────────────────────────────────────

module.exports = {
    calculateVirality,
    calculateMicroVirality,
    updateMemory,
    loadMemory,
    saveMemory,
    adaptiveThreshold,
    parseSubs,
    sizeMultiplier,
    freshnessFactor,
    reactionDiversityBonus,
};
