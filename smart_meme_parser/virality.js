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
const clusters = require('./cluster_stats');

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
 * α адаптивна по кластеру:
 *   nano=0.30, micro=0.20, small=0.15, medium=0.10, bridge=0.08
 *
 * @param {Object|null} mem    — текущая запись памяти (null если первый раз)
 * @param {number} views
 * @param {number} reactions
 * @param {number} comments
 * @param {number} postDateMs
 * @param {number} [subscribers]  — для Reach Penetration
 * @param {string} [cluster]     — кластер канала
 * @returns {Object} обновлённая запись
 */
function updateMemory(mem, views, reactions, comments, postDateMs, subscribers = 0, cluster = 'bridge') {
    const α = clusters.clusterAlpha(cluster);
    const ageMin = Math.max((Date.now() - postDateMs) / 60000, 1);
    const er       = (reactions + comments * 1.5) / Math.max(views, 1);
    const velocity = reactions / (ageMin + 5);
    const effectiveViews = Math.max(views, 1);
    const rp = subscribers > 0 ? views / subscribers : 0;

    if (!mem || !mem.post_count) {
        // Холодный старт: используем кластерные priors
        const priors = clusters.getClusterPriors(cluster);
        return {
            avg_er:       er || priors.priorER,
            avg_velocity: velocity || priors.priorVelocity,
            avg_views:    effectiveViews || priors.priorViews,
            avg_rp:       rp || (priors.priorRP || 0.3),
            post_count:   1,
            last_updated: Date.now()
        };
    }

    return {
        avg_er:       α * er           + (1 - α) * mem.avg_er,
        avg_velocity: α * velocity     + (1 - α) * mem.avg_velocity,
        avg_views:    α * effectiveViews + (1 - α) * mem.avg_views,
        avg_rp:       rp > 0 ? (α * rp + (1 - α) * (mem.avg_rp || 0.3)) : (mem.avg_rp || 0.3),
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

// ─── Nano-Viral Detection Engine (< 300 подп.) ──────────────────────────────
//
// NCVI: Reach Penetration — главная метрика.
// views/subs > 1.0 → пост вышел за пределы аудитории → вирусный сигнал.

/**
 * @param {number} views
 * @param {number} reactions
 * @param {number} comments
 * @param {number} postDateMs
 * @param {Object|null} channelMem
 * @param {number} subscribers
 * @param {Array|null} reactionResults
 * @param {string|null} channelName
 * @param {number|null} msgId
 * @param {number} [temporalFactor]
 * @returns {{ ncvi, rpAnomaly, erAnomaly, freshness, momentumV, momentumR }}
 */
function calculateNanoVirality(views, reactions, comments, postDateMs, channelMem = null, subscribers = 0, reactionResults = null, channelName = null, msgId = null, temporalFactor = 1.0) {
    if (!views || views === 0) return { ncvi: 0, rpAnomaly: 0, erAnomaly: 0, freshness: 0, momentumV: 0, momentumR: 0 };

    let momentumV = 0, momentumR = 0;
    if (channelName && msgId) {
        const mom = updateAndGetMomentum(channelName, msgId, views, reactions);
        momentumV = mom.instVelocityViews;
        momentumR = mom.instVelocityReactions;
    }

    const ageMin = Math.max((Date.now() - postDateMs) / 60000, 0.5);
    const er = (reactions + comments * 1.5) / Math.max(views, 1);

    // Reach Penetration
    const subs = Math.max(subscribers, 50); // floor 50 для защиты от деления на ноль
    const rp = views / subs;
    const avgRP = (channelMem && channelMem.avg_rp > 0) ? channelMem.avg_rp : 0.3;
    const rpAnomaly = rp / Math.max(avgRP, 0.1);

    // ER аномалия
    const avgER = (channelMem && channelMem.avg_er > 0) ? channelMem.avg_er : 0.03;
    const erAnomaly = er / Math.max(avgER, 0.01);

    // Velocity с временной нормализацией
    const velocityRaw = reactions / (ageMin + 3);
    const adjVelocity = velocityRaw / Math.max(temporalFactor, 0.1);
    const avgVelocity = (channelMem && channelMem.avg_velocity > 0) ? channelMem.avg_velocity : 0.05;
    const velAnomaly = adjVelocity / Math.max(avgVelocity, 0.01);
    const velBonus = 1 + 0.2 * Math.log2(Math.max(velAnomaly, 1));

    // Геометрическое среднее RP × ER аномалий
    const anomaly = Math.sqrt(rpAnomaly * erAnomaly);

    // Свежесть τ=120 мин (nano постят редко)
    const fresh = Math.exp(-ageMin / 120);

    const divBonus = reactionDiversityBonus(reactionResults);

    const ncvi = anomaly * velBonus * fresh * divBonus;

    return {
        ncvi:       Math.round(ncvi * 100) / 100,
        rpAnomaly:  Math.round(rpAnomaly * 100) / 100,
        erAnomaly:  Math.round(erAnomaly * 100) / 100,
        freshness:  Math.round(fresh * 100) / 100,
        momentumV:  Math.round(momentumV * 100) / 100,
        momentumR:  Math.round(momentumR * 100) / 100,
    };
}

// ─── Micro-Viral Detection Engine v2 (300–999 подп.) ─────────────────────────
//
// MCVI v2: добавлен Reach Penetration к viewsRatio и erRatio.
// Кубический корень из трёх аномалий → устойчивее к выбросам.

/**
 * @param {number} views
 * @param {number} reactions
 * @param {number} comments
 * @param {number} postDateMs
 * @param {Object|null} channelMem
 * @param {number} subscribers
 * @param {Array|null} reactionResults
 * @param {string|null} channelName
 * @param {number|null} msgId
 * @param {number} [temporalFactor]
 * @returns {{ mcvi, viewsRatio, erRatio, rpAnomaly, freshness, momentumV, momentumR }}
 */
function calculateMicroVirality(views, reactions, comments, postDateMs, channelMem = null, subscribers = 0, reactionResults = null, channelName = null, msgId = null, temporalFactor = 1.0) {
    if (!views || views === 0) return { mcvi: 0, viewsRatio: 0, erRatio: 0, rpAnomaly: 0, freshness: 0, momentumV: 0, momentumR: 0 };

    let momentumV = 0, momentumR = 0;
    if (channelName && msgId) {
        const mom = updateAndGetMomentum(channelName, msgId, views, reactions);
        momentumV = mom.instVelocityViews;
        momentumR = mom.instVelocityReactions;
    }

    const ageMin = Math.max((Date.now() - postDateMs) / 60000, 0.5);
    const er = (reactions + comments * 1.5) / Math.max(views, 1);
    const velocity = views / (ageMin + 10);

    // ── Аномалии ──────────────────────────────────────────────────────────
    const avgViews    = (channelMem && channelMem.avg_views    > 0) ? channelMem.avg_views    : views * 0.5;
    const avgER       = (channelMem && channelMem.avg_er       > 0) ? channelMem.avg_er       : 0.03;
    const avgVelocity = (channelMem && channelMem.avg_velocity > 0) ? channelMem.avg_velocity : 0.1;

    const viewsRatio = views / Math.max(avgViews, 3);
    const erRatio    = er / Math.max(avgER, 0.01);

    // Reach Penetration (новое в v2)
    const subs = Math.max(subscribers, 300);
    const rp = views / subs;
    const avgRP = (channelMem && channelMem.avg_rp > 0) ? channelMem.avg_rp : 0.3;
    const rpAnomaly = rp / Math.max(avgRP, 0.1);

    // Velocity бонус (нормализован по времени)
    const adjVelocity = velocity / Math.max(temporalFactor, 0.1);
    const velRatio = momentumV > 0
        ? momentumV / Math.max(avgVelocity, 0.01)
        : adjVelocity / Math.max(avgVelocity, 0.01);
    const velBonus = 1 + Math.log1p(Math.max(0, velRatio - 1)) * 0.3;

    // Кубический корень из трёх аномалий (устойчив к выбросам одного компонента)
    const anomalyScore = Math.cbrt(viewsRatio * erRatio * rpAnomaly);

    const fresh = Math.exp(-ageMin / 90);
    const divBonus = reactionDiversityBonus(reactionResults);

    const mcvi = anomalyScore * velBonus * fresh * divBonus;

    return {
        mcvi:       Math.round(mcvi * 100) / 100,
        viewsRatio: Math.round(viewsRatio * 100) / 100,
        erRatio:    Math.round(erRatio * 100) / 100,
        rpAnomaly:  Math.round(rpAnomaly * 100) / 100,
        freshness:  Math.round(fresh * 100) / 100,
        momentumV:  Math.round(momentumV * 100) / 100,
        momentumR:  Math.round(momentumR * 100) / 100,
    };
}

// ─── Small Channel Viral Index (1000–2999 подп.) ─────────────────────────────
//
// SCVI: гибрид CFS (абсолютный) + кластерный Z-score (относительный).
// 60% абсолютный + 40% относительный.

/**
 * @param {number} views
 * @param {number} reactions
 * @param {number} comments
 * @param {number} postDateMs
 * @param {Object|null} channelMem
 * @param {string|number|null} rawSubs
 * @param {Array|null} reactionResults
 * @param {string|null} channelName
 * @param {number|null} msgId
 * @param {number} [temporalFactor]
 * @returns {{ scvi, cfsRaw, clusterAnomaly, freshness, momentumR, momentumV }}
 */
function calculateSmallVirality(views, reactions, comments, postDateMs, channelMem = null, rawSubs = null, reactionResults = null, channelName = null, msgId = null, temporalFactor = 1.0) {
    if (!views || views === 0) return { scvi: 0, cfsRaw: 0, clusterAnomaly: 0, freshness: 0, momentumR: 0, momentumV: 0 };

    // CFS component (reuse calculateVirality)
    const cfsResult = calculateVirality(views, reactions, comments, postDateMs, channelMem, rawSubs, reactionResults, channelName, msgId, temporalFactor);
    const cfsRaw = cfsResult.cfs;

    // Cluster Z-score component
    const er = (reactions + comments * 1.5) / Math.max(views, 1);
    const zScores = clusters.getClusterZScores('small', views, er);
    const clusterAnomaly = Math.max(0, (zScores.viewsZ + zScores.erZ) / 2);

    const ageMin = Math.max((Date.now() - postDateMs) / 60000, 0.5);
    const fresh = Math.exp(-ageMin / 75);

    // Композит: 60% CFS + 40% кластерная аномалия
    const scvi = 0.6 * cfsRaw + 0.4 * clusterAnomaly * 10000 * fresh;

    return {
        scvi:           Math.round(scvi),
        cfsRaw:         cfsRaw,
        clusterAnomaly: Math.round(clusterAnomaly * 100) / 100,
        freshness:      cfsResult.freshness,
        momentumR:      cfsResult.momentumR,
        momentumV:      cfsResult.momentumV,
        rvi:            cfsResult.rvi,
        sizeM:          cfsResult.sizeM,
    };
}

// ─── Medium Adapted CFS (3000–9999 подп.) ────────────────────────────────────
//
// Стандартный CFS с усиленным sizeMultiplier и кластерным Bayesian prior.

/**
 * @returns {{ cfs, rvi, freshness, sizeM, momentumR, momentumV }}
 */
function adaptedMediumCFS(views, reactions, comments, postDateMs, channelMem = null, rawSubs = null, reactionResults = null, channelName = null, msgId = null, temporalFactor = 1.0) {
    // Стандартный CFS
    const result = calculateVirality(views, reactions, comments, postDateMs, channelMem, rawSubs, reactionResults, channelName, msgId, temporalFactor);

    // Дополнительный sizeBoost для medium кластера
    const subs = parseSubs(rawSubs);
    if (subs && subs < 10000) {
        const mediumBoost = 1 + Math.log10(Math.max(5000 / Math.max(subs, 1000), 1)) * 0.6;
        result.cfs = Math.round(result.cfs * mediumBoost);
        result.sizeM = Math.round((result.sizeM * mediumBoost) * 100) / 100;
    }

    return result;
}

// ─── Exports ─────────────────────────────────────────────────────────────────

module.exports = {
    calculateVirality,
    calculateNanoVirality,
    calculateMicroVirality,
    calculateSmallVirality,
    adaptedMediumCFS,
    updateMemory,
    loadMemory,
    saveMemory,
    adaptiveThreshold,
    parseSubs,
    sizeMultiplier,
    freshnessFactor,
    reactionDiversityBonus,
};
