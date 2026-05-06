const express = require('express');
const fs = require('fs');
const path = require('path');
const cors = require('cors');

const app = express();
const PORT = 8333;
const CONFIG_PATH = path.join(__dirname, 'config.json');
const DISCOVERED_PATH = path.join(__dirname, 'discovered_channels.json');
const IGNORED_PATH = path.join(__dirname, 'ignored_channels.json');
const CHANNEL_CACHE_PATH = path.join(__dirname, 'channel_cache.json');

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));


function readConfig() {
    try { return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); }
    catch (e) { return { targetChannels: [] }; }
}
function writeConfig(cfg) {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 4));
}
function readDiscovered() {
    try {
        if (!fs.existsSync(DISCOVERED_PATH)) return [];
        return JSON.parse(fs.readFileSync(DISCOVERED_PATH, 'utf8'));
    } catch (e) { return []; }
}
function writeDiscovered(data) {
    fs.writeFileSync(DISCOVERED_PATH, JSON.stringify(data, null, 4));
}
function readIgnored() {
    try {
        if (!fs.existsSync(IGNORED_PATH)) return [];
        return JSON.parse(fs.readFileSync(IGNORED_PATH, 'utf8'));
    } catch (e) { return []; }
}
function writeIgnored(data) {
    fs.writeFileSync(IGNORED_PATH, JSON.stringify(data, null, 4));
}
function readCache() {
    try {
        if (!fs.existsSync(CHANNEL_CACHE_PATH)) return {};
        return JSON.parse(fs.readFileSync(CHANNEL_CACHE_PATH, 'utf8'));
    } catch (e) { return {}; }
}
function writeCache(data) {
    fs.writeFileSync(CHANNEL_CACHE_PATH, JSON.stringify(data, null, 2));
}


let browser = null;

async function getBrowser() {
    if (browser && browser.isConnected()) return browser;
    try {
        const { chromium } = require('playwright-core');
        browser = await chromium.launch({
            executablePath: '/usr/bin/chromium',
            headless: true,
            args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
        });
        console.log('🌐 Playwright browser started');
    } catch (e) {
        console.error('Failed to start playwright:', e.message);
        browser = null;
    }
    return browser;
}

async function scrapeChannelMeta(username) {
    const https = require('https');
    // Try simple fetch first (fast, no overhead)
    const meta = await new Promise((resolve) => {
        const req = https.get('https://t.me/s/' + username, {
            headers: { 'User-Agent': 'Mozilla/5.0 (compatible; TelegramBot/1.0)' }
        }, (res) => {
            let data = '';
            res.on('data', c => data += c);
            res.on('end', () => {
                const titleMatch = data.match(/<div class="tgme_channel_info_header_title[^>]*><span[^>]*>([^<]+)<\/span>/);
                const titleFb = data.match(/<meta property="og:title" content="([^"]+)">/);
                const descMatch = data.match(/<div class="tgme_channel_info_description">([\s\S]*?)<\/div>/);
                const subsMatch = data.match(/<span class="counter_value">([^<]+)<\/span>\s*<span class="counter_type">subscribers<\/span>/);
                resolve({
                    title: (titleMatch && titleMatch[1]) || (titleFb && titleFb[1].replace(/^Telegram: /, '')) || username,
                    description: descMatch ? descMatch[1].replace(/<[^>]+>/g, '').trim() : '',
                    subscribers: subsMatch ? subsMatch[1] : null
                });
            });
        });
        req.on('error', () => resolve({ title: username, description: '', subscribers: null }));
        req.setTimeout(8000, () => { req.destroy(); resolve({ title: username, description: '', subscribers: null }); });
    });

    // If simple fetch got subscribers, return it
    if (meta.subscribers) return meta;

    // Fall back to playwright for JS-rendered pages
    try {
        const b = await getBrowser();
        if (!b) return meta;
        const ctx = await b.newContext({ userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' });
        const page = await ctx.newPage();
        await page.goto('https://t.me/s/' + username, { waitUntil: 'domcontentloaded', timeout: 15000 });
        await page.waitForTimeout(2000);

        const result = await page.evaluate(() => {
            const title = document.querySelector('.tgme_channel_info_header_title span')?.innerText ||
                          document.querySelector('meta[property="og:title"]')?.content?.replace(/^Telegram: /, '') || '';
            const desc = document.querySelector('.tgme_channel_info_description')?.innerText?.trim() || '';
            const subsEl = Array.from(document.querySelectorAll('.counter_value'));
            const subsTypeEl = Array.from(document.querySelectorAll('.counter_type'));
            let subs = null;
            subsTypeEl.forEach((el, i) => {
                if (el.innerText?.toLowerCase().includes('subscriber')) subs = subsEl[i]?.innerText || null;
            });
            return { title, description: desc, subscribers: subs };
        });

        await ctx.close();
        return {
            title: result.title || meta.title,
            description: result.description || meta.description,
            subscribers: result.subscribers || meta.subscribers || '?'
        };
    } catch (e) {
        console.error('Playwright scrape error for', username, e.message);
        return { ...meta, subscribers: meta.subscribers || '?' };
    }
}


let metaCache = {}; // in-memory: { username: { title, description, subscribers, ts } }

function loadMetaCache() {
    const saved = readCache();
    // channel_cache.json stores { username: { rawSubs, description, ... } }
    // Merge into our metaCache format
    for (const [k, v] of Object.entries(saved)) {
        if (!metaCache[k]) {
            const subsVal = v.rawSubs || (v.subs > 0 ? String(v.subs) : null) || '?';
            metaCache[k] = {
                title: v.title || k,
                description: v.description || v.desc || '',
                subscribers: subsVal,
                ts: v.ts || 0
            };
        }
    }
}
loadMetaCache();

let enrichQueue = [];
let enrichRunning = false;

function queueEnrich(username, priority = false) {
    if (metaCache[username] && metaCache[username].subscribers && metaCache[username].subscribers !== '?' &&
        Date.now() - (metaCache[username].ts || 0) < 3600000) return; // fresh cache, skip
    if (!enrichQueue.includes(username)) {
        if (priority) enrichQueue.unshift(username);
        else enrichQueue.push(username);
    }
    runEnrichQueue();
}

async function runEnrichQueue() {
    if (enrichRunning) return;
    enrichRunning = true;
    while (enrichQueue.length > 0) {
        const username = enrichQueue.shift();
        console.log(`🔍 Enriching @${username}...`);
        try {
            const meta = await scrapeChannelMeta(username);
            metaCache[username] = { ...meta, ts: Date.now() };
            // Persist to channel_cache.json — preserve existing rawSubs if new scrape returned nothing
            const cache = readCache();
            const prev = cache[username] || {};
            const newRawSubs = (meta.subscribers && meta.subscribers !== '?' && meta.subscribers !== null)
                ? meta.subscribers
                : (prev.rawSubs || prev.subs || null);
            cache[username] = {
                ...prev,
                rawSubs: newRawSubs,
                description: meta.description || prev.description || '',
                title: meta.title || prev.title || username,
                ts: Date.now()
            };
            writeCache(cache);
            // Update discovered_channels.json entries too
            const disc = readDiscovered();
            if (Array.isArray(disc)) {
                let changed = false;
                for (const item of disc) {
                    if (item.username === username) {
                        if (meta.subscribers && meta.subscribers !== '?') item.subscribers = meta.subscribers;
                        if (meta.description) item.description = meta.description;
                        if (meta.title) item.title = meta.title;
                        changed = true;
                    }
                }
                if (changed) writeDiscovered(disc);
            }
        } catch (e) {
            console.error('Enrich error for', username, e.message);
        }
        await new Promise(r => setTimeout(r, 1500)); // polite delay
    }
    enrichRunning = false;
}

// On startup: enrich all active channels + all discovered with missing data
function scheduleStartupEnrich() {
    const config = readConfig();
    const discovered = readDiscovered();
    const all = new Set();
    (config.targetChannels || []).forEach(c => all.add(c));
    if (Array.isArray(discovered)) {
        discovered.forEach(item => { if (item.username) all.add(item.username); });
    }
    for (const u of all) queueEnrich(u);
    setTimeout(scheduleStartupEnrich, 30 * 60 * 1000); // re-enrich every 30 min
}
setTimeout(scheduleStartupEnrich, 3000); // Start after 3s to not block startup


app.get('/api/channels', (req, res) => {
    const config = readConfig();
    const channels = config.targetChannels || [];
    const tags = config.tags || {};
    const richChannels = channels.map(c => ({
        channel: c,
        title: metaCache[c] ? metaCache[c].title : c,
        description: metaCache[c] ? metaCache[c].description : '',
        subscribers: metaCache[c] ? metaCache[c].subscribers : '?',
        tags: tags[c] || []
    }));
    res.json({ channels: richChannels });
});

app.post('/api/channels', (req, res) => {
    let { channel } = req.body;
    if (!channel) return res.status(400).json({ error: 'Нет имени канала' });

    let clean = channel.trim();
    if (clean.includes('t.me/')) clean = clean.split('t.me/')[1].split('/')[0].split('?')[0];
    else if (clean.startsWith('@')) clean = clean.substring(1);

    const config = readConfig();
    if (!config.targetChannels) config.targetChannels = [];
    if (config.targetChannels.includes(clean)) return res.status(400).json({ error: 'Канал уже есть в списке' });

    config.targetChannels.push(clean);
    writeConfig(config);

    // Remove from discovered
    let disc = readDiscovered();
    if (Array.isArray(disc)) {
        disc = disc.filter(item => item.username !== clean);
        writeDiscovered(disc);
    }

    // Queue enrichment
    queueEnrich(clean, true);

    res.json({ success: true, channel: clean, total: config.targetChannels.length });
});

app.delete('/api/channels/:channel', (req, res) => {
    const toRemove = req.params.channel;
    const config = readConfig();
    if (!config.targetChannels) return res.status(404).json({ error: 'Список пуст' });
    config.targetChannels = config.targetChannels.filter(c => c !== toRemove);
    writeConfig(config);
    res.json({ success: true, total: config.targetChannels.length });
});

// Bulk add channels
app.post('/api/channels/bulk', (req, res) => {
    const { channels } = req.body;
    if (!Array.isArray(channels)) return res.status(400).json({ error: 'Нужен массив channels' });
    const config = readConfig();
    if (!config.targetChannels) config.targetChannels = [];
    let added = 0;
    let disc = readDiscovered();
    for (let c of channels) {
        let clean = c.trim().replace(/^@/, '');
        if (!clean || config.targetChannels.includes(clean)) continue;
        config.targetChannels.push(clean);
        if (Array.isArray(disc)) disc = disc.filter(item => item.username !== clean);
        queueEnrich(clean, false);
        added++;
    }
    writeConfig(config);
    writeDiscovered(disc);
    res.json({ success: true, added, total: config.targetChannels.length });
});


app.get('/api/discovered', (req, res) => {
    const raw = readDiscovered();
    if (!Array.isArray(raw)) return res.json({ discovered: [] });

    const ignored = readIgnored();
    const counts = {};
    const meta = {};

    for (const item of raw) {
        if (!item.username) continue;
        if (ignored.includes(item.username)) continue;
        counts[item.username] = (counts[item.username] || 0) + (item.repostCount || 1);
        if (!meta[item.username]) {
            meta[item.username] = {
                title: item.title || item.username,
                subscribers: item.subscribers || '?',
                description: item.description || '',
                tags: item.tags || []
            };
        } else {
            if (item.subscribers && item.subscribers !== 'Unknown' && item.subscribers !== '?') meta[item.username].subscribers = item.subscribers;
            if (item.description) meta[item.username].description = item.description;
            if (item.title) meta[item.username].title = item.title;
            // Merge tags
            if (item.tags && item.tags.length > 0) {
                meta[item.username].tags = [...new Set([...(meta[item.username].tags || []), ...item.tags])];
            }
        }
        // Override with fresh in-memory cache if available
        if (metaCache[item.username]) {
            const mc = metaCache[item.username];
            if (mc.subscribers && mc.subscribers !== '?') meta[item.username].subscribers = mc.subscribers;
            if (mc.description) meta[item.username].description = mc.description;
            if (mc.title && mc.title !== item.username) meta[item.username].title = mc.title;
        }
    }

    const list = Object.keys(counts).map(username => ({
        channel: username,
        title: meta[username].title,
        subscribers: meta[username].subscribers,
        description: meta[username].description,
        count: counts[username],
        tags: meta[username].tags || []
    })).sort((a, b) => b.count - a.count);

    res.json({ discovered: list });
});

// Ignore (blacklist) a single discovered channel
app.delete('/api/discovered/:channel', (req, res) => {
    const ch = req.params.channel;
    const ignored = readIgnored();
    if (!ignored.includes(ch)) { ignored.push(ch); writeIgnored(ignored); }
    let disc = readDiscovered();
    if (Array.isArray(disc)) { disc = disc.filter(i => i.username !== ch); writeDiscovered(disc); }
    res.json({ success: true });
});

// Bulk ignore
app.post('/api/discovered/bulk-ignore', (req, res) => {
    const { channels } = req.body;
    if (!Array.isArray(channels)) return res.status(400).json({ error: 'Нужен массив channels' });
    const ignored = readIgnored();
    let disc = readDiscovered();
    for (const ch of channels) {
        if (!ignored.includes(ch)) ignored.push(ch);
        if (Array.isArray(disc)) disc = disc.filter(i => i.username !== ch);
    }
    writeIgnored(ignored);
    writeDiscovered(disc);
    res.json({ success: true, total: channels.length });
});

// Trigger re-enrichment of discovered
app.post('/api/enrich', (req, res) => {
    const disc = readDiscovered();
    let count = 0;
    if (Array.isArray(disc)) {
        for (const item of disc) {
            if (item.username) { queueEnrich(item.username, false); count++; }
        }
    }
    res.json({ success: true, queued: count });
});


app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Banana Admin Panel running on port ${PORT}`);
});
