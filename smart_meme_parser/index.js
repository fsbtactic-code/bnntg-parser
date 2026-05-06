// Inline .env loader (no npm package needed)
const fs = require('fs');
try {
    const envLines = fs.readFileSync(__dirname + '/.env', 'utf8').split('\n');
    for (const line of envLines) {
        const m = line.match(/^\s*([\w.-]+)\s*=\s*(.*)\s*$/);
        if (m) process.env[m[1]] = m[2].trim().replace(/^['"]|['"]$/g, '');
    }
} catch(e) {}

const { TelegramClient, Api } = require('telegram');
const { Logger } = require('telegram/extensions/Logger');
const { StringSession } = require('telegram/sessions');
const input = require('input');
const https = require('https');
const { calculateVirality, calculateNanoVirality, calculateMicroVirality, calculateSmallVirality, adaptedMediumCFS, updateMemory, loadMemory, saveMemory, adaptiveThreshold } = require('./virality');
const { isDuplicate, saveToDatabase, getTopDuplicates, isAlreadyForwarded, isAlreadyProcessed, markAsForwarded, getSeenInStats } = require('./dedup');
const archive  = require('./seen_archive');    // бинарный архив уникальных pHash (12 байт/картинка)
const temporal  = require('./temporal_profile'); // временной профиль (часовая/недельная нормализация)
const clusters  = require('./cluster_stats');   // кластерная статистика (nano/micro/small/medium/bridge)

// Защита от падений из-за таймаутов внутри gramjs
process.on('unhandledRejection', (reason, promise) => {
    console.error('Unhandled Rejection:', reason);
});
process.on('uncaughtException', (err) => {
    console.error('Uncaught Exception:', err);
});

// Все записи в config.json проходят через updateConfig() — читаем свежий файл,
// применяем функцию-мутатор, пишем обратно. Очередь гарантирует serialization.
const CONFIG_FILE = './config.json';
let _cfgMutexQueue = Promise.resolve();
function updateConfig(mutatorFn) {
    _cfgMutexQueue = _cfgMutexQueue.then(async () => {
        try {
            const raw = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
            const result = await mutatorFn(raw);
            if (result !== false) {
                fs.writeFileSync(CONFIG_FILE, JSON.stringify(result || raw, null, 4));
            }
        } catch(e) {
            console.error('updateConfig error:', e.message);
        }
    });
    return _cfgMutexQueue;
}


const BOT_TOKEN  = process.env.BOT_TOKEN;
const BOT_CHAT   = process.env.BOT_CHANNEL_ID; // -1003958213144


function botSendMessage(chatId, text, replyToMsgId) {
    if (!BOT_TOKEN) return Promise.resolve();
    return new Promise((resolve) => {
        const body = JSON.stringify({
            chat_id: chatId,
            text,
            parse_mode: 'HTML',
            ...(replyToMsgId ? { reply_to_message_id: replyToMsgId } : {})
        });
        const req = https.request({
            hostname: 'api.telegram.org',
            path: `/bot${BOT_TOKEN}/sendMessage`,
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
        }, (res) => {
            let d = '';
            res.on('data', c => d += c);
            res.on('end', () => resolve(JSON.parse(d)));
        });
        req.on('error', (e) => { console.error('Bot API error:', e.message); resolve(null); });
        req.write(body);
        req.end();
    });
}

const ADMIN_TG_ID = '1961690631';
let logBuffer = [];

function tgLog(msg, isError = false) {
    // Игнорируем спам-логи, иначе бот отлетит за спам (600+ каналов)
    if (msg.includes('Парсинг канала:')) return;
    if (msg.includes('Найден новый потенциальный канал')) return;

    const timestamp = new Date().toLocaleTimeString('ru');
    logBuffer.push(`[${timestamp}] ${msg}`);
    
    if (isError || logBuffer.length >= 10) {
        // Экранируем HTML чтобы не сломать парсер
        const cleanLogs = logBuffer.join('\n').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        const text = (isError ? "🚨 <b>ОШИБКА ПАРСЕРА</b>\n\n" : "📜 <b>Логи парсера (10 событий)</b>\n\n") +
                     "<pre>" + cleanLogs + "</pre>";
        
        botSendMessage(ADMIN_TG_ID, text).catch(()=>{});
        logBuffer = []; // очищаем буфер
    }
}

// Заменяем оригинальные console.log и console.error
const origLog = console.log;
const origError = console.error;

console.log = function(...args) {
    origLog.apply(console, args);
    const msg = args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ');
    tgLog(msg);
};

console.error = function(...args) {
    origError.apply(console, args);
    const msg = args.map(a => typeof a === 'object' ? JSON.stringify(a, Object.getOwnPropertyNames(a)) : String(a)).join(' ');
    tgLog(msg, true);
};

// Загружаем конфиг
const config = JSON.parse(fs.readFileSync('./config.json', 'utf8'));

const ENTITY_CACHE_PATH = './entity_cache.json';
let entityCache = {};
try { if (fs.existsSync(ENTITY_CACHE_PATH)) entityCache = JSON.parse(fs.readFileSync(ENTITY_CACHE_PATH, 'utf8')); } catch(e) {}
function saveEntityCache() { try { fs.writeFileSync(ENTITY_CACHE_PATH, JSON.stringify(entityCache)); } catch(e) {} }
function getInputPeer(username, Api) {
    const key = (username||'').toString().toLowerCase().replace('@','');
    const e = entityCache[key];
    if (e && e.id && e.accessHash) {
        try { return new Api.InputPeerChannel({ channelId: BigInt(e.id), accessHash: BigInt(e.accessHash) }); } catch(_) {}
    }
    return username;
}

// Сессия для авторизации (сохраняется в файл)
const sessionFile = './session.txt';
let sessionString = '';
if (fs.existsSync(sessionFile)) {
    sessionString = fs.readFileSync(sessionFile, 'utf8').trim();
}
const stringSession = new StringSession(sessionString);

// Функция для парсинга инфы о канале по HTTP (чтобы не ловить FloodWait)
async function fetchChannelInfoHTTP(channelName) {
    for (let attempt = 1; attempt <= 5; attempt++) {
        try {
            const html = await new Promise((resolve, reject) => {
                const req = https.get('https://t.me/' + channelName, { timeout: 3000 }, (res) => {
                    let d = '';
                    res.on('data', c => d += c);
                    res.on('end', () => resolve(d));
                });
                req.on('error', reject);
                req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
            });
            const titleMatch = html.match(/<meta property="og:title" content="([^"]+)">/);
            const descMatch = html.match(/<meta property="og:description" content="([^"]+)">/);
            const extraMatch = html.match(/tgme_page_extra.*?>([^<]+)</);
            
            let subsCount = 0;
            if (extraMatch) {
                const raw = extraMatch[1].replace(/\s/g, '').replace(/,/g, '');
                const subMatch = raw.match(/(\d+)/);
                if (subMatch) subsCount = parseInt(subMatch[1]) || 0;
            }
            
            return {
                title: titleMatch ? titleMatch[1] : '',
                desc: descMatch ? descMatch[1] : '',
                subs: subsCount
            };
        } catch (e) {
            await new Promise(r => setTimeout(r, 1000 * attempt));
        }
    }
    return null;
}

// Проверяет соответствие канала формату мем-канала через HTTP (t.me/s/) без TG API
// Критерии: >80% постов = одиночное медиа (фото/видео) + текст ≤50 символов
async function checkMemeFormatViaHTTP(channelName) {
    try {
        const { statusCode, html } = await new Promise((resolve, reject) => {
            const req = https.get(`https://t.me/s/${channelName}`, {
                headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
                timeout: 8000
            }, (res) => {
                // 302 = приватный/закрытый канал, нет публичной ленты
                if (res.statusCode !== 200) {
                    res.resume();
                    return resolve({ statusCode: res.statusCode, html: '' });
                }
                let d = '';
                res.on('data', c => d += c);
                res.on('end', () => resolve({ statusCode: res.statusCode, html: d }));
            });
            req.on('error', reject);
            req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
        });

        if (statusCode !== 200 || !html) return false;

        // Парсим посты из t.me/s/ ленты
        const posts = html.split('tgme_widget_message_wrap');
        if (posts.length < 4) return false; // меньше 3 постов — не хватает данных

        let totalPosts = 0;
        let singleMediaPosts = 0;
        let shortTextPosts = 0;

        for (const post of posts.slice(1)) {
            totalPosts++;

            // Одиночное медиа: есть photo/video, но НЕТ album (grouped)
            const hasPhoto  = /tgme_widget_message_photo_wrap/i.test(post);
            const hasVideo  = /tgme_widget_message_video_wrap|tgme_widget_message_roundvideo/i.test(post);
            const hasAlbum  = /tgme_widget_message_grouped/i.test(post);
            const hasSingleMedia = (hasPhoto || hasVideo) && !hasAlbum;
            if (hasSingleMedia) singleMediaPosts++;

            // Текст поста: внутри tgme_widget_message_text, очищаем HTML
            const textMatch = post.match(/class="tgme_widget_message_text[^"]*"[^>]*>([\s\S]*?)<\/div>/);
            let textLen = 0;
            if (textMatch) {
                const rawText = textMatch[1].replace(/<[^>]+>/g, '').replace(/&[a-z]+;/gi, ' ').trim();
                textLen = rawText.length;
            }
            if (textLen <= 30) shortTextPosts++; // строже: 50 → 30 символов
        }

        if (totalPosts < 5) return false; // минимум 5 постов для достоверности

        const singleMediaRatio = singleMediaPosts / totalPosts;
        const shortTextRatio   = shortTextPosts / totalPosts;

        // Строже: ≥85% одиночных медиа И ≥85% постов с текстом ≤ 30‍символов
        return singleMediaRatio >= 0.85 && shortTextRatio >= 0.85;
    } catch(e) {
        return false;
    }
}

async function start() {
    console.log("🚀 Запуск Smart Meme Parser...");

    const PASS_COUNTER_PATH = './pass_counter.json';
    const TOP_MEME_EVERY_N = 4; // самый копируемый — раз в 4 прохода (~2 часа)

    // Создаём тихий логгер — подавляем gramJS INFO-спам (Starting direct file download, etc.)
    const silentLogger = new Logger();
    silentLogger.setLevel('none');

    const client = new TelegramClient(stringSession, config.apiId, config.apiHash, {
        connectionRetries: 5,
        baseLogger: silentLogger,
    });

    await client.start({
        phoneNumber: async () => config.phone || await input.text('Введите ваш номер телефона (например, +123456789): '),
        password: async () => await input.text('Введите 2FA пароль (если есть): '),
        phoneCode: async () => await input.text('Введите код из Telegram: '),
        onError: (err) => console.log('Ошибка авторизации:', err),
    });

    console.log("✅ Успешно авторизовано в Telegram!");
    fs.writeFileSync(sessionFile, client.session.save());

    // Функция для сохранения найденных каналов (из репостов)
    function saveDiscoveredChannel(username, title, foundIn, subs, desc) {
        const jsonPath = './discovered_channels.json';
        const jsPath = './discovered_data.js';
        let data = [];
        if (fs.existsSync(jsonPath)) {
            try { data = JSON.parse(fs.readFileSync(jsonPath, 'utf8')); } catch(e) {}
        }
        let existing = data.find(c => c.username === username);
        if (existing) {
            existing.repostCount = (existing.repostCount || 1) + 1;
            fs.writeFileSync(jsonPath, JSON.stringify(data, null, 2));
            fs.writeFileSync(jsPath, 'const discoveredChannels = ' + JSON.stringify(data, null, 2) + ';');
        } else if (!config.targetChannels.includes(username)) {
            data.push({ username, title: title || username, foundIn, repostCount: 1,
                subscribers: subs || 'Unknown', description: desc || '',
                discoveredAt: new Date().toLocaleString() });
            fs.writeFileSync(jsonPath, JSON.stringify(data, null, 2));
            fs.writeFileSync(jsPath, 'const discoveredChannels = ' + JSON.stringify(data, null, 2) + ';');
            console.log(`🌟 Найден новый потенциальный канал через репост: @${username} (из @${foundIn})`);
        }
    }

    // Бесконечный цикл раз в 30 минут (с учетом времени прохода)
    while (true) {
        // Читаем и инкрементируем счётчик перед каждым проходом
        let passCounter;
        try { passCounter = JSON.parse(fs.readFileSync(PASS_COUNTER_PATH, 'utf8')); } catch(_) { passCounter = { count: 0 }; }
        passCounter.count = (passCounter.count || 0) + 1;
        const isTopMemePass = (passCounter.count % TOP_MEME_EVERY_N === 0);
        try { fs.writeFileSync(PASS_COUNTER_PATH, JSON.stringify(passCounter)); } catch(_) {}
        console.log(`📊 Проход #${passCounter.count} | Топ-баян: ${isTopMemePass ? '✅ ДА' : `нет (след. через ${TOP_MEME_EVERY_N - (passCounter.count % TOP_MEME_EVERY_N)} пр.)`}`);

        const passStart = Date.now();
        await processChannels(client, saveDiscoveredChannel, isTopMemePass);
        const durationMs = Date.now() - passStart;

        const waitTimeMs = Math.max(0, (30 * 60 * 1000) - durationMs);
        console.log(`\n⏳ Проход занял ${(durationMs / 1000).toFixed(1)} сек. Ожидание ${(waitTimeMs / 1000 / 60).toFixed(1)} мин до следующего прохода...`);
        await new Promise(r => setTimeout(r, waitTimeMs));
    }
}

async function processChannels(client, saveDiscoveredChannel, isTopMemePass = false) {
    // Динамически читаем конфиг перед каждым проходом, чтобы админка могла им управлять на лету
    let currentConfig;
    try {
        currentConfig = JSON.parse(fs.readFileSync('./config.json', 'utf8'));
    } catch (e) {
        console.error("Failed to read config:", e);
        currentConfig = config; // fallback to the global one
    }

    function parseRawSubs(raw) {
        if (!raw) return 0;
        const s = String(raw).replace(/\s/g,'').toUpperCase();
        if (s.endsWith('M')) return Math.round(parseFloat(s) * 1_000_000);
        if (s.endsWith('K')) return Math.round(parseFloat(s) * 1_000);
        return parseInt(s) || 0;
    }

    console.log(`\n[${new Date().toLocaleString()}] Начинаем сбор по ${currentConfig.targetChannels.length} каналам...`);
    
    const ignoredPath = './ignored_channels.json';
    let ignoredChannels = new Set();
    if (fs.existsSync(ignoredPath)) {
        try { ignoredChannels = new Set(JSON.parse(fs.readFileSync(ignoredPath, 'utf8'))); } catch(e){}
    }
    const saveIgnoredChannels = () => fs.writeFileSync(ignoredPath, JSON.stringify(Array.from(ignoredChannels), null, 2));

    let allMemes = [];
    let hashCandidates = []; // посты для широкого хеширования (views>=100, react>=1)
    const memory = loadMemory(); // Channel Memory EMA
    let processedCount = 0;
    let skippedCount = 0; // каналы без постов за окно

    clusters.resetPassStats();

    const stats = {
        totalPostsViewed: 0,  // все просмотренные посты (до фильтра)
        totalPosts: 0,        // прошли фильтр (react≥min, views≥min)
        viral: 0,
        dupFiltered: 0,
        forwarded: 0,
        hashNew: 0,   // новых хешей добавлено за проход
        hashDupes: 0, // баянов найдено при хешировании
        lt1k: 0, lt5k: 0, lt10k: 0, lt20k: 0, gt20k: 0, unknown: 0,
        // Кластерная статистика
        clNano: 0, clMicro: 0, clSmall: 0, clMedium: 0, clBridge: 0
    };
    const dupHits = []; // трекаем самые копируемые мемы

    // Загружаем кэш подписчиков один раз до цикла
    const cachePath = './channel_cache.json';
    let subsCache = {};

    // Счётчик ошибок каналов (канал удаляется только при 3 ошибках подряд — защита от масс-удаления при крашах)
    const errPath = './channel_errors.json';
    let channelErrors = {};
    try { channelErrors = JSON.parse(fs.readFileSync(errPath, 'utf8')); } catch(_){}
    if (fs.existsSync(cachePath)) {
        try { subsCache = JSON.parse(fs.readFileSync(cachePath, 'utf8')); } catch(e){}
    }

    // Базовая временная граница (адаптируется по кластеру)
    // Абсолютный cap: не старше 4 часов, чтобы nano/micro кластеры не тащили совсем старые посты
    const MAX_POST_AGE_HOURS = 4;
    const baseTimeLimitMs = Date.now() - (currentConfig.hoursToCheck * 60 * 60 * 1000);

    const batchSize = 3;
    for (let i = 0; i < currentConfig.targetChannels.length; i += batchSize) {
        const batch = currentConfig.targetChannels.slice(i, i + batchSize);
        await Promise.all(batch.map(async (channel) => {
        processedCount++;
        if (processedCount % 100 === 0) {
            botSendMessage(ADMIN_TG_ID, `⏳ Просканировано ${processedCount} каналов из ${currentConfig.targetChannels.length}`).catch(()=>{});
        }
        try {
            console.log(`📡 Парсинг канала: ${channel}... (${processedCount}/${currentConfig.targetChannels.length})`);
            // Загружаем память именно этого канала (или null для первого прохода)
            let channelMem = memory[channel] || null;
            const _chKeyPre = channel.toLowerCase().replace('@','');
            const _cachedPre = subsCache[_chKeyPre];
            const _subsPre = !_cachedPre ? 0 : (typeof _cachedPre === 'number' ? _cachedPre :
                (_cachedPre.subs > 0 ? _cachedPre.subs : parseRawSubs(_cachedPre.rawSubs)));
            const channelCluster = clusters.getCluster(_subsPre);
            const historyLimit = clusters.clusterHistoryLimit(channelCluster);
            const timeMult = clusters.clusterTimeMultiplier(channelCluster);
            const timeLimitMs = Math.max(
                Date.now() - (currentConfig.hoursToCheck * timeMult * 60 * 60 * 1000),
                Date.now() - (MAX_POST_AGE_HOURS * 60 * 60 * 1000) // cap: не старше 4ч
            );

            // Трекаем кластер
            clusters.countClusterChannel(channelCluster);
            if (channelCluster === 'nano')   stats.clNano++;
            else if (channelCluster === 'micro')  stats.clMicro++;
            else if (channelCluster === 'small')  stats.clSmall++;
            else if (channelCluster === 'medium') stats.clMedium++;
            else                                  stats.clBridge++;

            const history = await client.invoke(
                new Api.messages.GetHistory({
                    peer: getInputPeer(channel, Api),
                    limit: historyLimit,
                })
            );

            let channelMemes = [];
            let srcPeer = channel;

            // Сохраняем entity из history.chats → entity_cache
            if (history.chats) {
                for (const chat of history.chats) {
                    if (chat.username && chat.id != null && chat.accessHash != null) {
                        const key = chat.username.toLowerCase();
                        if (!entityCache[key]) entityCache[key] = { id: chat.id.toString(), accessHash: chat.accessHash.toString() };
                    }
                }
            }
            // Сохраняем entity_cache СРАЗУ после каждого GetHistory (не ждём конца прогона)
            saveEntityCache();

            // Сохраняем подписчиков source-канала в кэш (если history.chats содержит реальные данные)
            // гет не вызываем getEntity — он flood-опасен
            {
                const chName = channel.toLowerCase().replace('@', '');
                const srcChat = history.chats && history.chats.find(c =>
                    (c.username || '').toLowerCase() === chName
                );
                // Строим InputPeerChannel явно — gramjs использует его напрямую без ResolveUsername
                if (srcChat && srcChat.id != null && srcChat.accessHash != null) {
                    try {
                        srcPeer = new Api.InputPeerChannel({
                            channelId: BigInt(srcChat.id.toString()),
                            accessHash: BigInt(srcChat.accessHash.toString())
                        });
                    } catch(_) { srcPeer = channel; }
                } else {
                    // Попытка из entity_cache
                    const _ck = channel.toLowerCase().replace('@','');
                    const _ce = entityCache[_ck];
                    if (_ce && _ce.id && _ce.accessHash) {
                        try {
                            srcPeer = new Api.InputPeerChannel({
                                channelId: BigInt(_ce.id),
                                accessHash: BigInt(_ce.accessHash)
                            });
                        } catch(_) { srcPeer = channel; }
                    } else {
                        srcPeer = channel; // последний fallback — вызовет ResolveUsername
                    }
                }

                const pc = srcChat && srcChat.participantsCount > 0 ? srcChat.participantsCount : 0;
                if (pc > 0 && !subsCache[chName]) subsCache[chName] = { subs: pc };
                const cached = subsCache[chName];
                const subs = pc > 0 ? pc
                    : (cached ? (typeof cached === 'number' ? cached : (cached.subs > 0 ? cached.subs : parseRawSubs(cached.rawSubs))) : 0);
                if      (subs > 0 && subs < 1000)   stats.lt1k++;
                else if (subs >= 1000 && subs < 5000)  stats.lt5k++;
                else if (subs >= 5000 && subs < 10000) stats.lt10k++;
                else if (subs >= 10000 && subs < 20000) stats.lt20k++;
                else if (subs >= 20000)                 stats.gt20k++;
                else                                    stats.unknown++;
            }

            for (let msg of history.messages) {
                // Если это репост из другого канала, проверяем подписчиков и сохраняем
                if (msg.fwdFrom && msg.fwdFrom.fromId && msg.fwdFrom.fromId.className === 'PeerChannel') {
                    const fwdChannelId = msg.fwdFrom.fromId.channelId;
                    const fwdChatInfo = history.chats.find(c => c.id.toString() === fwdChannelId.toString());
                    if (fwdChatInfo && fwdChatInfo.username) {
                        const username = fwdChatInfo.username;
                        
                        // Проверяем, не отслеживаем ли мы уже этот канал
                        const isAlreadyTracked = currentConfig.targetChannels.some(ch => 
                            ch.replace('@', '').toLowerCase() === username.toLowerCase()
                        );

                        if (!ignoredChannels.has(username) && !isAlreadyTracked) {
                            // Кэш подписчиков...
                            let fetchFailed = false;
                            if (subsCache[username] === undefined || subsCache[username].rawSubs === 'Unknown' || subsCache[username].rawSubs === '?') {
                                try {
                                    console.log(`🔍 Запрашиваем инфу о ${username} через t.me...`);
                                    const info = await fetchChannelInfoHTTP(username);
                                    if (info) {
                                        subsCache[username] = { 
                                            subs: info.subs, 
                                            desc: info.desc, 
                                            rawSubs: info.subs > 0 ? info.subs.toString() : 'Unknown' 
                                        };
                                        fs.writeFileSync(cachePath, JSON.stringify(subsCache, null, 2));
                                        if (info.subs <= 0) fetchFailed = true;
                                    } else {
                                        console.log(`⚠️ Ошибка получения инфы о ${username}, пропускаем.`);
                                        fetchFailed = true;
                                    }
                                } catch (e) {
                                    console.log(`⚠️ Ошибка получения инфы о ${username}, пропускаем.`);
                                    fetchFailed = true;
                                }
                                
                                if (fetchFailed) {
                                    if (subsCache[username] === undefined) {
                                        subsCache[username] = { subs: 999999, desc: '', rawSubs: 'Unknown' };
                                        fs.writeFileSync(cachePath, JSON.stringify(subsCache, null, 2));
                                    }
                                    ignoredChannels.add(username);
                                    saveIgnoredChannels();
                                }
                            }

                            if (!fetchFailed && !ignoredChannels.has(username)) {
                                let cacheData = subsCache[username];
                                let subsCount = typeof cacheData === 'number' ? cacheData : (cacheData?.subs || 0);
                                let desc = typeof cacheData === 'object' ? cacheData.desc : '';
                                let rawSubs = typeof cacheData === 'object' ? cacheData.rawSubs : subsCount;

                                if (subsCount <= 10000) {
                                    saveDiscoveredChannel(username, fwdChatInfo.title, channel, rawSubs, desc);
                                } else {
                                    // Отсеиваем каналы > 10000, добавляем в игнор чтобы не проверять их посты снова
                                    ignoredChannels.add(username);
                                    saveIgnoredChannels();
                                }
                            }
                        }
                    }
                }

                // Проверка на "кружок"
                const isRoundVideo = msg.media && msg.media.className === 'MessageMediaDocument' && 
                                     msg.media.document && msg.media.document.attributes &&
                                     msg.media.document.attributes.some(attr => attr.className === 'DocumentAttributeVideo' && attr.roundMessage);

                if (!msg.media || msg.fwdFrom || isRoundVideo) continue;

                // Собираем ВСЕ уникальные медиа-посты — не только вирусные кандидаты.
                // isAlreadyProcessed — быстрый O(1) SQLite PRIMARY KEY lookup.
                {
                    const _v = msg.views || 0;
                    const _r = msg.reactions ? (msg.reactions.results || []).reduce((s, r) => s + r.count, 0) : 0;
                    const _isSticker = msg.media?.document?.attributes?.some?.(a => a.className === 'DocumentAttributeSticker');
                    const _isAudio   = (msg.media?.document?.mimeType || '').startsWith('audio/');
                    if (_v >= 100 && _r >= 1 && !_isSticker && !_isAudio && !isAlreadyProcessed(channel, msg.id)) {
                        const _gid = msg.groupedId ? msg.groupedId.toString() : null;
                        hashCandidates.push({ channel, peer: srcPeer, id: msg.id, media: msg.media, views: _v, groupedId: _gid });
                    }
                }

                const views = msg.views || 0;
                let reactions = 0;
                let reactionResults = null;
                if (msg.reactions && msg.reactions.results) {
                    reactionResults = msg.reactions.results;
                    reactions = reactionResults.reduce((sum, r) => sum + r.count, 0);
                }
                const replies = msg.replies ? msg.replies.replies : 0;

                stats.totalPostsViewed++;

                {
                    const _ageMin = Math.max((Date.now() - msg.date * 1000) / 60000, 1);
                    const _vpMin  = views / (_ageMin + 10);
                    temporal.updateProfile(_vpMin, msg.date * 1000);
                }

                const _chNameF = channel.toLowerCase().replace('@','');
                const _cachedF = subsCache[_chNameF];
                const _subsF = !_cachedF ? 0 : (typeof _cachedF === 'number' ? _cachedF :
                    (_cachedF.subs > 0 ? _cachedF.subs : parseRawSubs(_cachedF.rawSubs)));

                // Обновляем кластерную статистику для КАЖДОГО поста (для Welford)
                const _postAgeMin = Math.max((Date.now() - msg.date * 1000) / 60000, 1);
                clusters.updateClusterPost(channelCluster, views, reactions + replies, replies, _postAgeMin, _subsF);

                const { minViews, minReactions } = clusters.clusterMinThresholds(channelCluster);

                // 1. Скорим с текущей памятью (до обновления EMA)
                if (msg.date * 1000 >= timeLimitMs && reactions >= minReactions && views >= minViews) {
                    // Фильтруем: только фото, GIF, видео (не аудио/голос/стикеры) + без активных ссылок
                    const mediaType = msg.media?.className || '';
                    const mimeType = msg.media?.document?.mimeType || '';
                    const isAudio = mimeType.startsWith('audio/') || mimeType === 'video/ogg';
                    const isVoice = msg.media?.document?.attributes?.some?.(a => a.className === 'DocumentAttributeAudio' && a.voice);
                    const isSticker = msg.media?.document?.attributes?.some?.(a => a.className === 'DocumentAttributeSticker');

                    // Проверка на активные ссылки (только реальные URL — без упоминаний @username)
                    const hasActiveLink = (msg.entities && msg.entities.some(e => 
                        e.className === 'MessageEntityUrl' || 
                        e.className === 'MessageEntityTextUrl'
                    )) || /https?:\/\/|t\.me\//i.test(msg.message || '');

                    if (!msg.media || isAudio || isVoice || isSticker || hasActiveLink) {
                        // Не мем (аудио/голос/стикер/нет медиа или содержит ссылку)
                    } else {
                        const subsRaw = subsCache[_chNameF] ? (subsCache[_chNameF].rawSubs || subsCache[_chNameF]) : null;

                        // Временной поправочный коэффициент
                        const tFactor = temporal.getTemporalFactor(msg.date * 1000);

                        let scoredCFS = { cfs: 0, rvi: 0, freshness: 0, sizeM: 1.2, momentumR: 0, momentumV: 0 };
                        let scoredCluster = { ncvi: 0, mcvi: 0, scvi: 0, viewsRatio: 0, erRatio: 0, rpAnomaly: 0, erAnomaly: 0, clusterAnomaly: 0 };
                        let clusterScore = 0; // нормализованный скор для сравнения между кластерами

                        if (channelCluster === 'nano') {
                            const nano = calculateNanoVirality(views, reactions, replies, msg.date * 1000, channelMem, _subsF, reactionResults, channel, msg.id, tFactor);
                            scoredCluster.ncvi = nano.ncvi;
                            scoredCluster.rpAnomaly = nano.rpAnomaly;
                            scoredCluster.erAnomaly = nano.erAnomaly;
                            scoredCFS = calculateVirality(views, reactions, replies, msg.date * 1000, channelMem, subsRaw, reactionResults, channel, msg.id, tFactor);
                            clusterScore = nano.ncvi * 10000;
                            scoredCFS.momentumR = nano.momentumR;
                            scoredCFS.momentumV = nano.momentumV;
                            scoredCFS.freshness = nano.freshness;
                        } else if (channelCluster === 'micro') {
                            const micro = calculateMicroVirality(views, reactions, replies, msg.date * 1000, channelMem, _subsF, reactionResults, channel, msg.id, tFactor);
                            scoredCluster.mcvi = micro.mcvi;
                            scoredCluster.viewsRatio = micro.viewsRatio;
                            scoredCluster.erRatio = micro.erRatio;
                            scoredCluster.rpAnomaly = micro.rpAnomaly;
                            scoredCFS = calculateVirality(views, reactions, replies, msg.date * 1000, channelMem, subsRaw, reactionResults, channel, msg.id, tFactor);
                            clusterScore = micro.mcvi * 10000;
                            scoredCFS.momentumR = micro.momentumR;
                            scoredCFS.momentumV = micro.momentumV;
                            scoredCFS.freshness = micro.freshness;
                        } else if (channelCluster === 'small') {
                            const small = calculateSmallVirality(views, reactions, replies, msg.date * 1000, channelMem, subsRaw, reactionResults, channel, msg.id, tFactor);
                            scoredCluster.scvi = small.scvi;
                            scoredCluster.clusterAnomaly = small.clusterAnomaly;
                            scoredCFS = { cfs: small.cfsRaw, rvi: small.rvi, freshness: small.freshness, sizeM: small.sizeM, momentumR: small.momentumR, momentumV: small.momentumV };
                            clusterScore = small.scvi;
                        } else if (channelCluster === 'medium') {
                            scoredCFS = adaptedMediumCFS(views, reactions, replies, msg.date * 1000, channelMem, subsRaw, reactionResults, channel, msg.id, tFactor);
                            clusterScore = scoredCFS.cfs;
                        } else {
                            // bridge — стандартный CFS
                            scoredCFS = calculateVirality(views, reactions, replies, msg.date * 1000, channelMem, subsRaw, reactionResults, channel, msg.id, tFactor);
                            clusterScore = scoredCFS.cfs;
                        }

                        channelMemes.push({
                            channel,
                            peer: srcPeer,
                            cluster:    channelCluster,
                            isSmall:    channelCluster === 'small' || channelCluster === 'micro',
                            isMicro:    channelCluster === 'micro',
                            isNano:     channelCluster === 'nano',
                            id: msg.id,
                            date: msg.date,
                            views,
                            reactions,
                            replies,
                            subs:       _subsF,
                            vi:         scoredCFS.cfs,
                            clusterScore: clusterScore,
                            rvi:        scoredCFS.rvi,
                            freshness:  scoredCFS.freshness,
                            sizeM:      scoredCFS.sizeM,
                            momentumR:  scoredCFS.momentumR,
                            momentumV:  scoredCFS.momentumV,
                            // Кластерные метрики
                            ncvi:           scoredCluster.ncvi,
                            mcvi:           scoredCluster.mcvi,
                            scvi:           scoredCluster.scvi,
                            viewsRatio:     scoredCluster.viewsRatio,
                            erRatio:        scoredCluster.erRatio,
                            rpAnomaly:      scoredCluster.rpAnomaly,
                            erAnomaly:      scoredCluster.erAnomaly,
                            clusterAnomaly: scoredCluster.clusterAnomaly,
                            media: msg.media,
                            groupedId: msg.groupedId ? msg.groupedId.toString() : null
                        });
                        stats.totalPosts++;
                    }
                }

                // 2. Затем обновляем EMA-память (включая посты с 0 реакций — для точной нормы)
                channelMem = updateMemory(channelMem, views, reactions, replies, msg.date * 1000, _subsF, channelCluster);

            }

            // Сохраняем обновлённую Channel Memory канала
            memory[channel] = channelMem;

            // Все посты-кандидаты добавляем в общий пул
            for (let m of channelMemes) {
                m.anomalyScore = m.rvi || 1; // для лога совместимости
                allMemes.push(m);
            }

            // processedCount уже был увеличен в начале итерации (строка 262)
            // Успешный парсинг — сбрасываем CHANNEL_INVALID-счётчик для этого канала
            const _chLowOk = channel.toLowerCase().replace('@', '');
            if (channelErrors[_chLowOk]) delete channelErrors[_chLowOk];

        } catch (e) {
            // CHANNEL_INVALID = канал закрыт/удалён/сменил юзернейм.
            // Удаляем ТОЛЬКО если это произошло 3 раза подряд (защита от масс-удаления при crash-loop)
            if (e.message && e.message.includes('CHANNEL_INVALID')) {
                const chLow = channel.toLowerCase().replace('@', '');
                channelErrors[chLow] = (channelErrors[chLow] || 0) + 1;
                const strikes = channelErrors[chLow];
                if (strikes >= 3) {
                    console.log(`🗑 Канал @${channel} недоступен 3й проход подряд — удаляем из источников`);
                    const _chLowDel = chLow;
                    updateConfig(cfg => {
                        const key = cfg.targetChannels ? 'targetChannels' : 'channels';
                        cfg[key] = (cfg[key] || []).filter(c => c.toLowerCase().replace('@','') !== _chLowDel);
                        return cfg;
                    });
                    delete channelErrors[chLow]; // сбрасываем счётчик
                } else {
                    console.log(`\u26A0\uFE0F @${channel}: CHANNEL_INVALID (\u0441трайк ${strikes}/3)`);
                }
            } else {
                // Любая другая ошибка — не считаем страйком, просто логируем
                console.log(`\u274C \u041e\u0448\u0438\u0431\u043a\u0430 \u043f\u0440\u0438 \u043f\u0430\u0440\u0441\u0438\u043d\u0433\u0435 ${channel}:`, e.message);
                // Успешный результат сбрасывает CHANNEL_INVALID-счётчик (handled above)
            }
            skippedCount++;
        }
        
        // Маленькая пауза внутри батча (рандомизация)
        await new Promise(r => setTimeout(r, 100 + Math.random() * 200));
        })); // Конец Promise.all
        
        // Пауза между батчами для безопасности от FloodWait
        await new Promise(r => setTimeout(r, 1000));
    }

    // Сохраняем всю Channel Memory после прохода
    saveMemory(memory);
    // Сохраняем счётчик ошибок
    try { fs.writeFileSync(errPath, JSON.stringify(channelErrors)); } catch(_){}

    // После основного прохода проверяем каналы у которых нет данных о подписчиках
    // Используем HTTP (не TG API) чтобы не ловить FloodWait
    {
        function parseRawSubsLocal(raw) {
            if (!raw || raw === 'null' || raw === '?') return 0;
            const s = String(raw).replace(/\s/g,'').toUpperCase();
            if (s.endsWith('M')) return Math.round(parseFloat(s) * 1_000_000);
            if (s.endsWith('K')) return Math.round(parseFloat(s) * 1_000);
            return parseInt(s) || 0;
        }
        const unknownChannels = currentConfig.targetChannels.filter(ch => {
            const key = ch.toLowerCase().replace('@', '');
            const sc = subsCache[key];
            if (!sc) return true;  // нет кэша совсем
            const subs = sc.subs > 0 ? sc.subs : parseRawSubsLocal(sc.rawSubs);
            return subs <= 0;  // нет ни subs ни parseable rawSubs
        });
        if (unknownChannels.length > 0) {
            console.log(`\n🔍 HTTP-проверка ${unknownChannels.length} каналов без данных о подписчиках...`);
            let httpFixed = 0;
            for (const ch of unknownChannels) {
                const key = ch.toLowerCase().replace('@', '');
                try {
                    const info = await fetchChannelInfoHTTP(key);
                    if (info && info.subs > 0) {
                        subsCache[key] = { subs: info.subs, desc: info.desc || '', rawSubs: String(info.subs) };
                        httpFixed++;
                    }
                    await new Promise(r => setTimeout(r, 150)); // не перегружаем сервер
                } catch(_) {}
            }
            if (httpFixed > 0) {
                fs.writeFileSync(cachePath, JSON.stringify(subsCache));
                console.log(`   ✅ Получены данные для ${httpFixed} каналов (HTTP)`);
            }
        }
    }

    console.log(`\n📊 ИТОГИ ПРОХОДА:`);
    console.log(`   ├─ Всего каналов в конфиге: ${currentConfig.targetChannels.length}`);
    console.log(`   ├─ Успешно обработано: ${processedCount}`);
    console.log(`   ├─ Ошибок/пропусков: ${skippedCount}`);
    console.log(`   ├─ Кандидатов найдено: ${allMemes.length}`);
    console.log(`   └─ Channel Memory: ${Object.keys(memory).length} каналов в базе (накопл.)`);



    // Сортируем по Composite Final Score
    allMemes.sort((a, b) => b.vi - a.vi);

    console.log('🔥 ТОП-10 (CFS · RVI · Size · Freshness · Momentum):');
    allMemes.slice(0, 10).forEach((m, i) => {
        const momStr = (m.momentumR > 0 || m.momentumV > 0) ? ` Mom:${m.momentumR}r/min` : '';
        console.log(`  ${i+1}. [@${m.channel}] CFS:${m.vi} RVI:${m.rvi}x Size:${m.sizeM}x Fresh:${m.freshness}${momStr} React:${m.reactions}`);
    });

    // Сохраняем сырой пул (до RVI-фильтра) для очереди малых каналов
    // Тоже фильтруем уже пересланные — иначе они займут слоты micro/small/nano очередей
    const allMemesRaw = allMemes.filter(m => !isAlreadyForwarded(m.channel, m.id));

    ;(async () => {
        const HASH_SCAN_LIMIT = 600;
        const batchToHash = hashCandidates
            .sort((a, b) => (b.views || 0) - (a.views || 0))
            .slice(0, HASH_SCAN_LIMIT);
        let hNew = 0, hDupe = 0;
        console.log(`🔍 Hash scan (фон): ${batchToHash.length}/${hashCandidates.length} постов...`);
        for (const cand of batchToHash) {
            try {
                const buf = await client.downloadMedia(cand.media, { thumb: 1 });
                if (!buf || !Buffer.isBuffer(buf) || buf.length < 100) continue;
                const dup = await isDuplicate(buf, cand.channel, cand.id, 600, cand.groupedId || null);
                if (dup) hDupe++;
                else { await saveToDatabase(buf, cand.id, cand.channel, cand.groupedId || null); hNew++; }
            } catch (_) {}
            await new Promise(r => setTimeout(r, 80));
        }
        console.log(`✅ Hash scan (фон) завершён: +${hNew} хешей, ${hDupe} баянов из ${batchToHash.length}`);
    })().catch(e => console.error('❌ Hash scan bg error:', e.message));


    // Берём топ кандидатов: сортируем по CFS, отсекаем откровенно слабые (RVI < 1.5)
    // Фильтруем уже пересланные ДО построения очередей чтобы они не занимали слоты
    const TOTAL_BUDGET_PRE = config.maxMemesToForward || 50;
    const MIN_RVI = 1.5; // порог вирусности
    const MAX_CANDIDATES = 300; // широкий пул до очередей — очереди сами ограничивают по слотам
    const qualified = allMemes
        .filter(m => parseFloat(m.rvi) >= MIN_RVI)
        .filter(m => !isAlreadyForwarded(m.channel, m.id)) // убираем уже пересланные до очередей
        .slice(0, MAX_CANDIDATES);
    stats.viral = qualified.length;
    console.log(`✅ Квалифицировано (RVI≥${MIN_RVI}): ${qualified.length} из ${allMemes.length}`);
    allMemes.splice(0, allMemes.length, ...qualified);

    // destPeer: сначала из entity_cache, потом единственный resolve через getEntity
    let destPeer = currentConfig.destinationChannel;
    const _destKey = String(currentConfig.destinationChannel).replace('@','').toLowerCase();
    const _destCached = entityCache[_destKey];
    if (_destCached && _destCached.id && _destCached.accessHash) {
        try {
            destPeer = new Api.InputPeerChannel({
                channelId: BigInt(_destCached.id),
                accessHash: BigInt(_destCached.accessHash)
            });
            console.log(`✅ Dest из кэша: ${currentConfig.destinationChannel}`);
        } catch(_) {}
    } else {
        // Если нет в кэше — резолвим ОДИН РАЗ и сохраняем
        try {
            // Для числового ID (приватный канал) передаём BigInt
            const destArg = typeof currentConfig.destinationChannel === 'number'
                ? BigInt(currentConfig.destinationChannel)
                : currentConfig.destinationChannel;
            const destEnt = await client.getEntity(destArg);
            if (destEnt && destEnt.id && destEnt.accessHash != null) {
                entityCache[_destKey] = { id: destEnt.id.toString(), accessHash: destEnt.accessHash.toString() };
                saveEntityCache();
                destPeer = new Api.InputPeerChannel({
                    channelId: BigInt(destEnt.id.toString()),
                    accessHash: BigInt(destEnt.accessHash.toString())
                });
                console.log(`✅ Dest resolved + закэшировано: ${currentConfig.destinationChannel}`);
            }
        } catch(e) {
            console.warn(`⚠️ Dest resolve failed (flood?), используем строку. ${e.message}`);
        }
    }

    const floodStatePath = './flood_state.json';
    let floodBanActive = false;
    if (fs.existsSync(floodStatePath)) {
        try {
            const floodData = JSON.parse(fs.readFileSync(floodStatePath, 'utf8'));
            const elapsed = (Date.now() - floodData.bannedAt) / 1000;
            const remaining = floodData.waitSec - elapsed;
            if (remaining > 0) {
                floodBanActive = true;
                console.log('🚫 Flood ban ещё активен. Осталось: ' + Math.round(remaining/60) + ' мин. Форварды пропущены.');
                saveEntityCache();
            } else {
                fs.unlinkSync(floodStatePath);
                console.log('✅ Flood ban истёк! Форварды возобновлены.');
            }
        } catch(_) {}
    }

    // Объявляем счётчики ДО проверки flood ban — иначе в итоговом отчёте будет ReferenceError
    let forwardedCount = 0;
    let forwardedMomentum = 0;
    let forwardedSmall = 0;
    let forwardedMicro = 0;
    let forwardedNano = 0;
    let forwardedMedium = 0;

    if (!floodBanActive) {
    const TOTAL_BUDGET = config.maxMemesToForward || 50;

    // Пропорциональное распределение бюджета (минимум 1 на кластер, чтобы не терять хвосты)
    const MAX_BRIDGE   = Math.max(1, Math.ceil(TOTAL_BUDGET * 0.35)); // 35%
    const MAX_MOMENTUM = Math.max(1, Math.ceil(TOTAL_BUDGET * 0.25)); // 25%
    const MAX_MEDIUM   = Math.max(1, Math.ceil(TOTAL_BUDGET * 0.15)); // 15%
    const MAX_SMALL    = Math.max(1, Math.ceil(TOTAL_BUDGET * 0.10)); // 10%
    const MAX_MICRO    = Math.max(1, Math.ceil(TOTAL_BUDGET * 0.10)); // 10%
    const MAX_NANO     = Math.max(1, Math.ceil(TOTAL_BUDGET * 0.05)); // 5%

    // 1. Bridge (≥10k) — стандартный CFS, топ
    const bridgeQueue = allMemes
        .filter(m => m.cluster === 'bridge' || (!m.cluster && !m.isSmall && !m.isMicro && !m.isNano))
        .slice(0, MAX_BRIDGE * 5)
        .map(m => ({ ...m, _slot: 'main' }));
    const mainIds = new Set(bridgeQueue.map(m => m.channel + '/' + m.id));

    // 2. Моментум: посты с наибольшей динамикой роста (любой кластер)
    const momentumQueue = [...allMemes]
        .filter(m => !mainIds.has(m.channel + '/' + m.id))
        .sort((a, b) => (b.momentumR + b.momentumV) - (a.momentumR + a.momentumV) || b.vi - a.vi)
        .slice(0, MAX_MOMENTUM * 5)
        .map(m => ({ ...m, _slot: 'momentum' }));
    const momentumActive = momentumQueue.filter(m => m.momentumR > 0 || m.momentumV > 0).length;
    for (let m of momentumQueue) mainIds.add(m.channel + '/' + m.id);

    // 3. Medium (3000–9999) — adapted CFS
    const mediumQueue = allMemesRaw
        .filter(m => m.cluster === 'medium' && !mainIds.has(m.channel + '/' + m.id))
        .sort((a, b) => b.vi - a.vi)
        .slice(0, MAX_MEDIUM * 5)
        .map(m => ({ ...m, _slot: 'medium' }));
    for (let m of mediumQueue) mainIds.add(m.channel + '/' + m.id);

    // 4. Small (1000–2999) — SCVI (гибрид CFS + Z-score)
    const smallQueue = allMemesRaw
        .filter(m => m.cluster === 'small' && !mainIds.has(m.channel + '/' + m.id))
        .sort((a, b) => (b.scvi || b.vi) - (a.scvi || a.vi))
        .slice(0, MAX_SMALL * 5)
        .map(m => ({ ...m, _slot: 'small' }));
    for (let m of smallQueue) mainIds.add(m.channel + '/' + m.id);

    // 5. Micro (300–999) — MCVI v2 (кубический корень 3 аномалий)
    const microQueue = allMemesRaw
        .filter(m => m.cluster === 'micro' && !mainIds.has(m.channel + '/' + m.id))
        .sort((a, b) => b.mcvi - a.mcvi)
        .slice(0, MAX_MICRO * 5)
        .map(m => ({ ...m, _slot: 'micro' }));
    for (let m of microQueue) mainIds.add(m.channel + '/' + m.id);

    // 6. Nano (<300) — NCVI (Reach Penetration × ER аномалия)
    const nanoQueue = allMemesRaw
        .filter(m => m.cluster === 'nano' && !mainIds.has(m.channel + '/' + m.id))
        .sort((a, b) => b.ncvi - a.ncvi)
        .slice(0, MAX_NANO * 5)
        .map(m => ({ ...m, _slot: 'nano' }));

    console.log(`📊 Очереди: Bridge=${bridgeQueue.length} Mom=${momentumQueue.length}(${momentumActive}🔥) Med=${mediumQueue.length} Small=${smallQueue.length} Micro=${microQueue.length} Nano=${nanoQueue.length}`);
    const forwardQueue = [...bridgeQueue, ...momentumQueue, ...mediumQueue, ...smallQueue, ...microQueue, ...nanoQueue];

    for (let meme of forwardQueue) {
        const currentTotal = forwardedCount + forwardedMomentum + forwardedMedium + forwardedSmall + forwardedMicro + forwardedNano;
        if (currentTotal >= TOTAL_BUDGET) {
            console.log(`🎯 Достигнут общий лимит форвардов (${TOTAL_BUDGET}). Завершаем отбор.`);
            break;
        }

        if (meme._slot === 'main'     && forwardedCount    >= MAX_BRIDGE)   continue;
        if (meme._slot === 'momentum' && forwardedMomentum >= MAX_MOMENTUM) continue;
        if (meme._slot === 'medium'   && forwardedMedium   >= MAX_MEDIUM)   continue;
        if (meme._slot === 'small'    && forwardedSmall    >= MAX_SMALL)    continue;
        if (meme._slot === 'micro'    && forwardedMicro    >= MAX_MICRO)    continue;
        if (meme._slot === 'nano'     && forwardedNano     >= MAX_NANO)     continue;

        try {
            if (isAlreadyForwarded(meme.channel, meme.id)) {
                console.log(`⏭ Уже пересылали: @${meme.channel}/${meme.id} — пропуск`);
                stats.dupFiltered++;
                continue;
            }

            const buffer = await client.downloadMedia(meme.media, { thumb: 1 });
            if (!buffer) continue; 

            const isDupe = await isDuplicate(buffer, meme.channel, meme.id, 600, meme.groupedId || null);
            if (isDupe) {
                console.log(`♻️ БАЯН! @${meme.channel}/${meme.id} ← оригинал: @${isDupe.channelId}/${isDupe.messageId} (hitCount:${isDupe.hitCount})`);
                // Фиксируем картинку в архиве даже если это баян — чтобы знать когда впервые встретилась
                archive.checkAndRecord(buffer).catch(() => {});
                stats.dupFiltered++;
                continue;
            }

            // Если config.archiveFilterDays > 0 — отсеиваем мемы старше N дней
            // (картинка уже циркулировала в рунете давно → не свежий контент)
            const archiveFilterDays = currentConfig.archiveFilterDays || 0;
            if (archiveFilterDays > 0) {
                const archCheck = await archive.checkAndRecord(buffer).catch(() => ({ isNew: true }));
                if (!archCheck.isNew && archCheck.firstSeenDaysAgo >= archiveFilterDays) {
                    console.log(`🗓 Старый мем (${archCheck.firstSeenDaysAgo}д в архиве): @${meme.channel}/${meme.id} — пропуск`);
                    stats.dupFiltered++;
                    continue;
                }
            }

            console.log(`🚀 ПЕРЕСЫЛАЕМ: @${meme.channel}/${meme.id} (CFS:${meme.vi} RVI:${meme.rvi}x Size:${meme.sizeM}x)`);
            
            let forwarded;
            try {
                // Прямой MTProto invoke — gramjs НЕ вызывает ResolveUsername/getEntity
                // fromPeer и toPeer — готовые InputPeerChannel из entity_cache
                forwarded = await client.invoke(new Api.messages.ForwardMessages({
                    fromPeer: meme.peer,
                    id: [meme.id],
                    toPeer: destPeer,
                    randomId: [BigInt(Math.floor(Math.random() * 2**52))],
                    silent: false,
                    background: false,
                    withMyScore: false,
                    dropAuthor: false,
                    dropMediaCaptions: false,
                    noforwards: false,
                }));
            } catch(fwdErr) {
                const msg = fwdErr.message || '';
                if (msg.includes('FLOOD_WAIT')) {
                    const secs = parseInt(msg.match(/FLOOD_WAIT_(\d+)/)?.[1] || '60');
                    // Короткий flood wait (до 60с) — просто ждём
                    if (secs < 120) {
                        console.log(`⏳ FloodWait ${secs}s — ждём...`);
                        await new Promise(r => setTimeout(r, secs * 1000));
                    } else {
                        // Долгий flood wait — сохраняем и прекращаем
                        const floodState = { bannedAt: Date.now(), waitSec: secs };
                        try { fs.writeFileSync(floodStatePath, JSON.stringify(floodState)); } catch(_) {}
                        console.log(`🚫 FLOOD BAN ${secs}s! Запись в flood_state.json. Прерываем форвардинг.`);
                        break;
                    }
                } else if (msg.includes('CHAT_FORWARDS_RESTRICTED')) {
                    console.log(`🔒 @${meme.channel} запрещает пересылку — добавляем в чёрный список`);
                    const _restrCh = meme.channel;
                    updateConfig(cfg => {
                        cfg.targetChannels = (cfg.targetChannels || []).filter(c => c !== _restrCh);
                        if (!cfg.restrictedChannels) cfg.restrictedChannels = [];
                        if (!cfg.restrictedChannels.includes(_restrCh)) cfg.restrictedChannels.push(_restrCh);
                        return cfg;
                    });
                    console.log(`   ✂️ @${meme.channel} удалён из парсинга, добавлен в restricted`);
                } else if (msg.includes('CHANNEL_PRIVATE')) {
                    console.log(`🚫 Приватный канал @${meme.channel} — пропускаем`);
                } else if (msg.includes('ResolveUsername') || msg.includes('wait of') || msg.includes('FLOOD_WAIT')) {
                    // Flood ban на ResolveUsername или любой флуд — сохраняем и прекращаем
                    const waitMatch = msg.match(/(\d{4,}) seconds/) || msg.match(/FLOOD_WAIT_(\d+)/);
                    const waitSec = waitMatch ? parseInt(waitMatch[1]) : 3600;
                    const floodState = { bannedAt: Date.now(), waitSec };
                    try { fs.writeFileSync(floodStatePath, JSON.stringify(floodState)); } catch(_) {}
                    console.log(`🚫 FLOOD BAN! wait=${Math.round(waitSec/3600)}ч. Форварды прерваны. Запись в flood_state.json`);
                    break; // прекращаем весь forwarding loop
                } else {
                    console.log(`❌ Ошибка пересылки @${meme.channel}:`, msg);
                }
                continue;
            }

            // invoke возвращает Updates объект (не массив)
            let newMsgId = null;
            if (forwarded && forwarded.updates) {
                // Ищем UpdateMessageID — содержит новый msg_id в целевом канале
                const updMsgId = forwarded.updates.find(u => u.className === 'UpdateMessageID');
                const updNewMsg = forwarded.updates.find(u => u.className === 'UpdateNewChannelMessage');
                newMsgId = updMsgId?.id ?? updNewMsg?.message?.id ?? null;
            } else if (forwarded && forwarded.id) {
                newMsgId = forwarded.id;
            } else if (!forwarded) {
                console.log(`⚠️  invoke вернул null для @${meme.channel}/${meme.id}`);
                continue;
            }

            console.log(`   ✅ Переслано → msg_id=${newMsgId} в ${config.destinationChannel}`);




            const er = meme.views > 0 ? ((meme.reactions / meme.views) * 100).toFixed(2) : 0;
            const slotName = meme._slot === 'main'     ? 'Вирусный (CFS) 🔥'
                           : meme._slot === 'momentum'  ? 'Гравитационный Моментум 🚀'
                           : meme._slot === 'nano'      ? `Nano 🔬 (NCVI:${meme.ncvi} RP×${meme.rpAnomaly} ER×${meme.erAnomaly})`
                           : meme._slot === 'micro'     ? `Micro 🧫 (MCVI:${meme.mcvi} RP×${meme.rpAnomaly} Views×${meme.viewsRatio})`
                           : meme._slot === 'small'     ? `Small 🐣 (SCVI:${meme.scvi || meme.vi} Z:${meme.clusterAnomaly})`
                           : meme._slot === 'medium'    ? `Medium 📊 (CFS:${meme.vi} boost)`
                           :                              'Канал';
            const text = `<blockquote expandable>🔥 <b>CFS: ${meme.vi}</b>  ·  RVI: ×${meme.rvi}  ·  Size: ×${meme.sizeM}  ·  Свежесть: ${Math.round(meme.freshness*100)}%
📥 Алгоритм: <b>${slotName}</b>
🏷 Кластер: ${meme.cluster || 'bridge'} (${meme.subs || '?'} подп.)

📡 Источник: @${meme.channel}
👁 Просмотров: <b>${meme.views.toLocaleString()}</b>  ·  ❤️ Реакций: <b>${meme.reactions}</b>  ·  ER: <b>${er}%</b>
💬 Комментариев: ${meme.replies || 0}</blockquote>`;

            const botRes = await botSendMessage(BOT_CHAT || currentConfig.destinationChannel, text, newMsgId)
                .catch(e => { console.error('Bot send error:', e.message); return null; });
            if (botRes && !botRes.ok) console.log(`   ⚠️ Bot API: ${botRes.description}`);
            else if (botRes && botRes.ok) console.log(`   📊 Статистика отправлена.`);

            // Сохраняем в базу хешей (страховка — hash scan мог уже добавить), помечаем как пересланный
            await saveToDatabase(buffer, meme.id, meme.channel, meme.groupedId || null);
            markAsForwarded(meme.channel, meme.id);
            // Если archiveFilterDays=0, запись в архив ещё не была сделана выше — делаем сейчас
            if (!(currentConfig.archiveFilterDays > 0)) {
                archive.checkAndRecord(buffer).catch(() => {});
            }
            if (meme._slot === 'nano')         forwardedNano++;
            else if (meme._slot === 'micro')   forwardedMicro++;
            else if (meme._slot === 'small')   forwardedSmall++;
            else if (meme._slot === 'medium')  forwardedMedium++;
            else if (meme._slot === 'momentum') forwardedMomentum++;
            else forwardedCount++;
            
            stats.forwarded++;

            // Пауза между форвардами — защита от Bot API "Too Many Requests"
            await new Promise(r => setTimeout(r, 3000));

        } catch (e) {
            console.log(`❌ Ошибка при пересылке:`, e.message);
        }
    }

    } // end if (!floodBanActive)

    saveEntityCache();

    // Функция fetchChannelInfoHTTP перемещена наверх для глобального использования

    if (false) try {
        const seenStats   = getSeenInStats();
        // Читаем свежий конфиг через updateConfig — один раз, потом применяем изменения атомарно
        const cfgSnap     = JSON.parse(fs.readFileSync('./config.json', 'utf8'));
        const existingSet = new Set(
            (cfgSnap.targetChannels || cfgSnap.channels || []).map(c => String(c).toLowerCase().replace('@','').trim())
        );
        const destChannels = new Set(
            [cfgSnap.destinationChannel, ...(cfgSnap.destinationChannels || [])]
                .filter(Boolean).map(c => String(c).toLowerCase().replace('@',''))
        );

        const autoAdded = [];
        for (const [ch, hits] of Object.entries(seenStats)) {
            if (hits < 5)             continue; // min 5 reposts
            if (existingSet.has(ch))  continue; // already tracked
            if (destChannels.has(ch)) continue; // our destination

            // Step 1: get info from cache or HTTP (нужно только для passCond1 — keyword)
            // passCond2 (GetHistory) работает независимо через getEntity если нет в кэше
            let entityEntry = entityCache[ch] || entityCache['@' + ch];
            let scEntry     = subsCache[ch];
            if (!scEntry || !scEntry.subs || !entityEntry || !entityEntry.title) {
                const info = await fetchChannelInfoHTTP(ch);
                if (info) {
                    entityEntry = { id: '', accessHash: '', title: info.title || '' };
                    entityCache[ch] = entityEntry;
                    scEntry = { subs: info.subs || 0, desc: info.desc || '' };
                    subsCache[ch] = scEntry;
                    fs.writeFileSync(cachePath, JSON.stringify(subsCache));
                    saveEntityCache();
                }
                // Не делаем continue: passCond2 может всё равно пройти через getEntity
            }
            // Rule: диапазон подписчиков 1000–20000
            const subs = scEntry ? (scEntry.subs > 0 ? scEntry.subs : parseRawSubs(scEntry.rawSubs)) : 0;
            if (subs < 1000 || subs > 20000) continue;

            const chTitle    = entityEntry ? (entityEntry.title || '') : '';
            const chDesc     = scEntry ? (scEntry.desc || '') : '';
            const inUsername = /mem|мем/i.test(ch);
            const inTitle    = /mem|мем/i.test(chTitle);
            const inDesc     = /mem|мем/i.test(chDesc);
            const passCond1  = inUsername || inTitle || inDesc;

            // Фильтр-исключение: нет слов anime, аниме, арты, арт, архитек
            const excludeRegex = /anime|animе|аниме|\bарт\b|\bарты\b|архитек/i;
            if (excludeRegex.test(chTitle) || excludeRegex.test(chDesc) || excludeRegex.test(ch)) continue;

            let checkPeer = null;
            // Защита от пустой строки '' (id из HTTP-фолбека не содержит реального ID)
            if (entityEntry && entityEntry.id && entityEntry.id.length > 0 &&
                entityEntry.accessHash && entityEntry.accessHash.length > 0) {
                try {
                    checkPeer = new Api.InputPeerChannel({
                        channelId: BigInt(entityEntry.id),
                        accessHash: BigInt(entityEntry.accessHash)
                    });
                } catch(_e1) {}
            }
            if (!checkPeer) {
                try {
                    const ent = await client.getEntity(ch);
                    if (ent && ent.id && ent.accessHash != null) {
                        entityCache[ch] = { id: ent.id.toString(), accessHash: ent.accessHash.toString(), title: ent.title || '' };
                        saveEntityCache();
                        checkPeer = new Api.InputPeerChannel({
                            channelId: BigInt(ent.id.toString()),
                            accessHash: BigInt(ent.accessHash.toString())
                        });
                        if (ent.participantsCount > 0) {
                            subsCache[ch] = subsCache[ch] || {};
                            subsCache[ch].subs = ent.participantsCount;
                            fs.writeFileSync(cachePath, JSON.stringify(subsCache));
                        }
                    }
                } catch(_e2) {}
            }

            let passCond2 = false;
            if (checkPeer) {
                try {
                    const hist = await client.invoke(new Api.messages.GetHistory({
                        peer: checkPeer, limit: 20, offsetId: 0,
                        offsetDate: 0, addOffset: 0, maxId: 0, minId: 0, hash: BigInt(0)
                    }));
                    const msgs = (hist.messages || []).filter(m => m.className === 'Message');
                    if (msgs.length >= 5) {
                        let total = 0, singleMedia = 0, longText = 0;
                        for (const m of msgs) {
                            total++;
                            const cls   = (m.media && m.media.className) ? m.media.className : '';
                            const doc   = (m.media && m.media.document) ? m.media.document : null;
                            const mime  = doc ? (doc.mimeType || '') : '';
                            const attrs = doc ? (doc.attributes || []) : [];
                            // groupedId is Long in gramJS — album if non-null and non-zero
                            const gid     = m.groupedId;
                            const isAlbum = (gid != null && gid.toString() !== '0');
                            const isPhoto   = (cls === 'MessageMediaPhoto');
                            const isGif     = attrs.some(a => a.className === 'DocumentAttributeAnimated');
                            const isVideo   = (cls === 'MessageMediaDocument') && (mime.startsWith('video/') || isGif);
                            const isVoice   = attrs.some(a => a.className === 'DocumentAttributeAudio' && a.voice);
                            const isSticker = attrs.some(a => a.className === 'DocumentAttributeSticker');
                            const isAudio   = !isGif && (mime.startsWith('audio/') || mime === 'video/ogg');
                            // Single media: photo or video/gif, NOT album, NOT voice/sticker/audio
                            if ((isPhoto || isVideo) && !isAlbum && !isVoice && !isSticker && !isAudio) singleMedia++;
                            // Long caption > 100 chars
                            if ((m.message || '').trim().length > 100) longText++;
                        }
                        passCond2 = (total >= 5) && ((singleMedia / total) >= 0.85) && ((longText / total) < 0.15);
                    }
                    await new Promise(r => setTimeout(r, 300));
                } catch(_e3) {}
            }

            // Добавляем ТОЛЬКО если выполняются ОБА условия
            if (!passCond1 || !passCond2) continue;

            existingSet.add(ch); // предотвращаем повторное добавление в этом же проходе
            const conds = [passCond1 ? 'keyword' : '', passCond2 ? 'meme_format ✅' : ''].filter(Boolean).join(' + ');
            autoAdded.push({ ch, subs, hits, chTitle: inTitle ? chTitle : '', conds, passCond2 });


        }


        if (autoAdded.length > 0) {
            await updateConfig(cfg => {
                const key = cfg.targetChannels ? 'targetChannels' : 'channels';
                const existingNorm = new Set((cfg[key] || []).map(c => String(c).toLowerCase().replace('@','').trim()));
                for (const item of autoAdded) {
                    if (!existingNorm.has(item.ch)) {
                        cfg[key].push(item.ch);
                        existingNorm.add(item.ch);
                    }
                    // Тег meme_format — только при Условии 2
                    if (item.passCond2) {
                        if (!cfg.tags) cfg.tags = {};
                        cfg.tags[item.ch] = Array.from(new Set((cfg.tags[item.ch] || []).concat('meme_format')));
                    }
                }
                return cfg;
            });
            // Обновляем discovered_channels.json для meme_format каналов
            try {
                const discPath = './discovered_channels.json';
                if (fs.existsSync(discPath)) {
                    const discData = JSON.parse(fs.readFileSync(discPath, 'utf8'));
                    let changed = false;
                    for (const item of autoAdded.filter(i => i.passCond2)) {
                        const entry = discData.find(x => (x.username || '').toLowerCase().replace('@','') === item.ch);
                        if (entry) {
                            entry.tags = Array.from(new Set((entry.tags || []).concat('meme_format')));
                            entry.isMeme = true;
                            changed = true;
                        }
                    }
                    if (changed) fs.writeFileSync(discPath, JSON.stringify(discData, null, 2));
                }
            } catch(_) {}
            console.log('\n🤖 Авто-добавлено ' + autoAdded.length + ' мем-канал(ов) в источники:');
            autoAdded.forEach(x => console.log('  ✪ @' + x.ch + ' (' + x.subs + ' подп., reposts: ' + x.hits + (x.chTitle ? ' "' + x.chTitle + '"' : '') + ') [' + x.conds + ']'));
        }
    } catch(e) {
        console.log('\u26a0\ufe0f autoDiscover error:', e.message);
    }

    // Сохраняем временной профиль (накапливается с каждым прогоном)
    temporal.saveProfile();
    const tStats = temporal.profileStats();
    console.log(`⏱ Temporal profile: ${tStats.totalSamples} семплов, активных часов: ${tStats.readyHours}/24, дней: ${tStats.readyDays}/7`);

    // Сохраняем кластерную статистику
    clusters.saveClusterStats();
    const clSummary = clusters.getClusterSummary();
    console.log(`📊 Cluster stats: Nano=${clSummary.nano?.channels||0} Micro=${clSummary.micro?.channels||0} Small=${clSummary.small?.channels||0} Medium=${clSummary.medium?.channels||0} Bridge=${clSummary.bridge?.channels||0}`);

    const _fwdCount = forwardedCount + forwardedSmall + forwardedMomentum + forwardedMicro + forwardedNano + forwardedMedium;
    console.log(`\n✅ Итерация завершена. Переслано: ${_fwdCount} мемов (Bridge: ${forwardedCount}, Mom: ${forwardedMomentum}, Med: ${forwardedMedium}, Small: ${forwardedSmall}, Micro: ${forwardedMicro}, Nano: ${forwardedNano}).`);
    console.log(`⏰ Следующий прогон через ~30 мин (в ${new Date(Date.now() + 30*60*1000).toLocaleTimeString('ru')})`);

    const now = new Date();
    const mskTime = new Date(now.getTime() + 3*3600000 + now.getTimezoneOffset()*60000);
    const timeStr = mskTime.toLocaleTimeString('ru', { hour: '2-digit', minute: '2-digit' });

    // Каналы в очереди на фильтрацию (discovered)
    const discoveredPath = './discovered_channels.json';
    const discoveredCount = fs.existsSync(discoveredPath)
        ? (() => { try { return JSON.parse(fs.readFileSync(discoveredPath, 'utf8')).length; } catch(e) { return 0; } })()
        : 0;

    const report = `📊 <b>Отчёт прохода ${timeStr} МСК</b>
<blockquote expandable>Пабликов в базе: ${currentConfig.targetChannels.length}
Проанализировано постов: ${stats.totalPostsViewed}
Выдано постов: ${_fwdCount}</blockquote>`;

    console.log(`📤 Отправляем отчёт (${report.length} символов)...`);
    const reportRes = await botSendMessage(BOT_CHAT || currentConfig.destinationChannel, report)
        .catch(e => { console.error('Report send error:', e.message); return null; });
    if (reportRes && reportRes.ok) console.log('✅ Отчёт отправлен в канал.');
    else if (reportRes) console.error('❌ Report bot error:', JSON.stringify(reportRes));

    // Отправляем топ-2 самых копируемых мемов — раз в 4 прохода (~2 часа)
    if (isTopMemePass) {
        try {
            const topDupes = getTopDuplicates(2);
            if (topDupes.length > 0) {
                // Заголовок перед картинками
                await botSendMessage(BOT_CHAT || currentConfig.destinationChannel,
                    `🏆 <b>Самые копируемые мемы прохода:</b>`
                ).catch(() => {});

                for (const dupe of topDupes) {
                    try {
                        // Используем invoke чтобы не триггерить ResolveUsername
                        const dupFromPeer = dupe.channelId
                            ? (() => { const ce = entityCache[String(dupe.channelId).toLowerCase().replace('@','')]; return ce ? new Api.InputPeerChannel({ channelId: BigInt(ce.id), accessHash: BigInt(ce.accessHash) }) : dupe.channelId; })()
                            : null;
                        if (!dupFromPeer) throw new Error('no peer for dupe ' + dupe.channelId);
                        await client.invoke(new Api.messages.ForwardMessages({
                            fromPeer: dupFromPeer,
                            id: [parseInt(dupe.messageId)],
                            toPeer: destPeer,
                            randomId: [BigInt(Math.floor(Math.random() * 2**52))],
                            silent: false, background: false, withMyScore: false,
                            dropAuthor: false, dropMediaCaptions: false, noforwards: false,
                        }));
                        const cleanCh = (ch) => String(ch || '').replace('@', '');
                        const totalSeen = (dupe.seenIn ? dupe.seenIn.length : 0);
                        // hitCount — количество новых совпадений за этот период (сброшен при выдаче)
                        // seenIn — накопленная история всех каналов где видели картинку
                        const totalCount = Math.max(totalSeen, dupe.hitCount || 1);

                        let lines = [];

                        // 1. Первое появление (оригинал)
                        if (dupe.channelId && dupe.messageId) {
                            lines.push(`🏁 <b>Оригинал:</b> <a href="https://t.me/${cleanCh(dupe.channelId)}/${dupe.messageId}">@${cleanCh(dupe.channelId)}</a>`);
                        }

                        // 2. Все каналы где встречалась
                        if (dupe.seenIn && dupe.seenIn.length > 0) {
                            const channelLines = dupe.seenIn.map((x, i) =>
                                `  ${i + 1}. <a href="https://t.me/${cleanCh(x.channel)}/${x.msgId}">@${cleanCh(x.channel)}</a>`
                            );
                            lines.push(`\n🔁 <b>Замечено в ${totalCount} каналах:</b>\n` + channelLines.join('\n'));
                        } else {
                            lines.push(`\n📊 Новых совпадений за проход: ${dupe.hitCount || 1}`);
                        }

                        const caption = lines.join('\n');
                        await botSendMessage(
                            BOT_CHAT || currentConfig.destinationChannel,
                            `🖼 <b>Самая копируемая картинка</b> (×${totalCount} копий)\n\n` + caption
                        ).catch(() => {});
                        await new Promise(r => setTimeout(r, 1000));
                    } catch(e) {
                        console.log('⚠️ Ошибка пересылки топ-баяна:', e.message);
                    }
                }
            }
        } catch(e) {
            console.error('⚠️ top dupes error:', e.message);
        }
    }

}

start();
