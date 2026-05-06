/**
 * ═══════════════════════════════════════════════════════════════
 *  cluster_stats.js — Кластерная статистика малых каналов
 * ═══════════════════════════════════════════════════════════════
 *
 *  5 кластеров по размеру подписчиков:
 *    Nano   (< 300)       — первооткрыватели
 *    Micro  (300–999)     — растущие
 *    Small  (1000–2999)   — стабильные малые
 *    Medium (3000–9999)   — устоявшиеся
 *    Bridge (≥ 10000)     — стандартный режим
 *
 *  Для каждого кластера собираем в реальном времени:
 *    - mean/std для views, ER, velocity  (Welford's online algorithm)
 *    - медианы через reservoir sampling
 *    - кластерные priors для холодного старта EMA
 *
 *  Обновляется инкрементально за один проход, сохраняется в cluster_stats.json.
 *  Размер файла: ~1KB.
 */

'use strict';
const fs   = require('fs');
const path = require('path');

const STATS_PATH = path.join(__dirname, 'cluster_stats.json');

// ── Кластерные границы ──────────────────────────────────────────────────────

const CLUSTER_BOUNDS = {
    nano:   { min: 1,     max: 299   },
    micro:  { min: 300,   max: 999   },
    small:  { min: 1000,  max: 2999  },
    medium: { min: 3000,  max: 9999  },
    bridge: { min: 10000, max: Infinity },
};

/**
 * Определяет кластер канала по числу подписчиков.
 * @param {number} subs
 * @returns {'nano'|'micro'|'small'|'medium'|'bridge'}
 */
function getCluster(subs) {
    if (!subs || subs <= 0) return 'bridge'; // unknown → bridge (консервативно: лучше не потерять пост)
    if (subs < 300)   return 'nano';
    if (subs < 1000)  return 'micro';
    if (subs < 3000)  return 'small';
    if (subs < 10000) return 'medium';
    return 'bridge';
}

// ── Параметры кластеров ─────────────────────────────────────────────────────

/**
 * EMA α коэффициент для Channel Memory по кластеру.
 */
function clusterAlpha(cluster) {
    const alphas = { nano: 0.30, micro: 0.20, small: 0.15, medium: 0.10, bridge: 0.08 };
    return alphas[cluster] || 0.15;
}

/**
 * Лимит GetHistory по кластеру.
 */
function clusterHistoryLimit(cluster) {
    const limits = { nano: 100, micro: 80, small: 60, medium: 50, bridge: 50 };
    return limits[cluster] || 50;
}

/**
 * Множитель временного окна (расширяет hoursToCheck).
 */
function clusterTimeMultiplier(cluster) {
    const mults = { nano: 3.0, micro: 2.0, small: 1.5, medium: 1.0, bridge: 1.0 };
    return mults[cluster] || 1.0;
}

/**
 * Минимальные пороги для попадания в скоринг.
 */
function clusterMinThresholds(cluster) {
    const thresholds = {
        nano:   { minViews: 8,   minReactions: 1 },
        micro:  { minViews: 15,  minReactions: 2 },
        small:  { minViews: 50,  minReactions: 2 },
        medium: { minViews: 80,  minReactions: 3 },
        bridge: { minViews: 100, minReactions: 3 },
    };
    return thresholds[cluster] || thresholds.bridge;
}

/**
 * Квалификационный порог скора по кластеру.
 */
function clusterQualThreshold(cluster) {
    const thresholds = { nano: 2.0, micro: 1.8, small: 1.5, medium: 1.5, bridge: 1.5 };
    return thresholds[cluster] || 1.5;
}

/**
 * Период полураспада свежести (τ) по кластеру (минуты).
 */
function clusterFreshnessTau(cluster) {
    const taus = { nano: 120, micro: 90, small: 75, medium: 60, bridge: 60 };
    return taus[cluster] || 60;
}

// ── Welford's Online Algorithm ──────────────────────────────────────────────

function _defaultWelford() {
    return { n: 0, mean: 0, m2: 0 };
}

function welfordUpdate(state, value) {
    state.n++;
    const delta = value - state.mean;
    state.mean += delta / state.n;
    const delta2 = value - state.mean;
    state.m2 += delta * delta2;
}

function welfordStd(state) {
    if (state.n < 2) return 0;
    return Math.sqrt(state.m2 / state.n);
}

// ── Cluster Stats ───────────────────────────────────────────────────────────

function _defaultClusterStat() {
    return {
        channels: 0,
        views:    _defaultWelford(),
        er:       _defaultWelford(),
        velocity: _defaultWelford(),
        rp:       _defaultWelford(),  // Reach Penetration
        // Reservoir для медиан (храним до 100 значений)
        velSamples: [],
        erSamples:  [],
    };
}

let stats = null;

function _defaultStats() {
    return {
        nano:   _defaultClusterStat(),
        micro:  _defaultClusterStat(),
        small:  _defaultClusterStat(),
        medium: _defaultClusterStat(),
        bridge: _defaultClusterStat(),
        updatedAt: 0,
    };
}

function loadClusterStats() {
    try {
        if (!fs.existsSync(STATS_PATH)) {
            stats = _defaultStats();
            return;
        }
        const raw = JSON.parse(fs.readFileSync(STATS_PATH, 'utf8'));
        stats = _defaultStats();
        for (const cluster of ['nano', 'micro', 'small', 'medium', 'bridge']) {
            if (raw[cluster]) {
                const rc = raw[cluster];
                stats[cluster].channels = rc.channels || 0;
                // Восстанавливаем Welford state
                for (const field of ['views', 'er', 'velocity', 'rp']) {
                    if (rc[field]) {
                        stats[cluster][field] = {
                            n:    rc[field].n    || 0,
                            mean: rc[field].mean || 0,
                            m2:   rc[field].m2   || 0,
                        };
                    }
                }
                stats[cluster].velSamples = rc.velSamples || [];
                stats[cluster].erSamples  = rc.erSamples  || [];
            }
        }
        stats.updatedAt = raw.updatedAt || 0;
    } catch (e) {
        console.error('ClusterStats load error:', e.message);
        stats = _defaultStats();
    }
}

function saveClusterStats() {
    if (!stats) return;
    stats.updatedAt = Date.now();
    try {
        fs.writeFileSync(STATS_PATH, JSON.stringify(stats));
    } catch (e) {
        console.error('ClusterStats save error:', e.message);
    }
}

/**
 * Сбрасывает кластерную статистику перед каждым проходом.
 * Welford рассчитывается заново за проход.
 */
function resetPassStats() {
    stats = _defaultStats();
}

/**
 * Обновляет кластерную статистику одним постом.
 * Вызывать для КАЖДОГО поста (до фильтра), чтобы иметь точную кластерную норму.
 *
 * @param {string} cluster — 'nano'|'micro'|'small'|'medium'|'bridge'
 * @param {number} views
 * @param {number} reactions
 * @param {number} comments
 * @param {number} ageMin — возраст поста в минутах
 * @param {number} subscribers — подписчики канала
 */
function updateClusterPost(cluster, views, reactions, comments, ageMin, subscribers) {
    if (!stats || !stats[cluster]) return;
    const cs = stats[cluster];

    const er = (reactions + comments * 1.5) / Math.max(views, 1);
    const velocity = reactions / (ageMin + 5);
    const rp = subscribers > 0 ? views / subscribers : 0;

    welfordUpdate(cs.views, views);
    welfordUpdate(cs.er, er);
    welfordUpdate(cs.velocity, velocity);
    if (rp > 0) welfordUpdate(cs.rp, rp);

    // Reservoir sampling для медиан (максимум 200 значений)
    if (cs.velSamples.length < 200) {
        cs.velSamples.push(velocity);
    } else {
        const idx = Math.floor(Math.random() * (cs.views.n));
        if (idx < 200) cs.velSamples[idx] = velocity;
    }
    if (cs.erSamples.length < 200) {
        cs.erSamples.push(er);
    } else {
        const idx = Math.floor(Math.random() * (cs.views.n));
        if (idx < 200) cs.erSamples[idx] = er;
    }
}

/**
 * Инкрементирует счётчик каналов в кластере.
 */
function countClusterChannel(cluster) {
    if (!stats || !stats[cluster]) return;
    stats[cluster].channels++;
}

// ── Getters ──────────────────────────────────────────────────────────────────

function _median(arr) {
    if (!arr || arr.length === 0) return 0;
    const sorted = [...arr].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 !== 0
        ? sorted[mid]
        : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * Возвращает кластерные priors для холодного старта.
 * Используется когда у канала post_count < 3.
 */
function getClusterPriors(cluster) {
    if (!stats || !stats[cluster]) {
        return { priorER: 0.03, priorVelocity: 0.1, priorViews: 50 };
    }
    const cs = stats[cluster];
    return {
        priorER:       cs.er.n >= 5       ? cs.er.mean       : 0.03,
        priorVelocity: cs.velocity.n >= 5 ? cs.velocity.mean : 0.1,
        priorViews:    cs.views.n >= 5    ? cs.views.mean    : 50,
        priorRP:       cs.rp.n >= 5       ? cs.rp.mean       : 0.3,
        medianVelocity: _median(cs.velSamples) || 0.1,
        medianER:       _median(cs.erSamples)  || 0.03,
    };
}

/**
 * Возвращает Z-score поста относительно кластера.
 * @returns {{ viewsZ: number, erZ: number }}
 */
function getClusterZScores(cluster, views, er) {
    if (!stats || !stats[cluster]) return { viewsZ: 0, erZ: 0 };
    const cs = stats[cluster];
    const viewsStd = welfordStd(cs.views);
    const erStd    = welfordStd(cs.er);
    return {
        viewsZ: viewsStd > 0 ? (views - cs.views.mean) / viewsStd : 0,
        erZ:    erStd > 0    ? (er - cs.er.mean)       / erStd    : 0,
    };
}

/**
 * Возвращает сводку кластерной статистики для отчёта.
 */
function getClusterSummary() {
    if (!stats) return {};
    const summary = {};
    for (const cluster of ['nano', 'micro', 'small', 'medium', 'bridge']) {
        const cs = stats[cluster];
        summary[cluster] = {
            channels:    cs.channels,
            posts:       cs.views.n,
            avgViews:    Math.round(cs.views.mean),
            avgER:       Math.round(cs.er.mean * 10000) / 100,  // в %
            medianVel:   Math.round(_median(cs.velSamples) * 100) / 100,
            stdViews:    Math.round(welfordStd(cs.views)),
        };
    }
    return summary;
}

// ── Init ──────────────────────────────────────────────────────────────────────
loadClusterStats();

module.exports = {
    getCluster,
    clusterAlpha,
    clusterHistoryLimit,
    clusterTimeMultiplier,
    clusterMinThresholds,
    clusterQualThreshold,
    clusterFreshnessTau,
    resetPassStats,
    updateClusterPost,
    countClusterChannel,
    getClusterPriors,
    getClusterZScores,
    getClusterSummary,
    saveClusterStats,
    CLUSTER_BOUNDS,
};
