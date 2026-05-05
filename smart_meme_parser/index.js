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
const { StringSession } = require('telegram/sessions');
const input = require('input');
const https = require('https');
const { calculateVirality, calculateMicroVirality, updateMemory, loadMemory, saveMemory, adaptiveThreshold } = require('./virality');
const { isDuplicate, saveToDatabase, getTopDuplicates, isAlreadyForwarded } = require('./dedup');
const archive = require('./seen_archive'); // бинарный архив уникальных pHash (12 байт/картинка)

// Защита от падений из-за таймаутов внутри gramjs
process.on('unhandledRejection', (reason, promise) => {
    console.error('Unhandled Rejection:', reason);
});
process.on('uncaughtException', (err) => {
    console.error('Uncaught Exception:', err);
});

// ─── Bot API helper ─────────────────────────────────────────────────────────
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


// Загружаем конфиг
const config = JSON.parse(fs.readFileSync('./config.json', 'utf8'));

// ── Entity Cache: channelId+accessHash → не вызываем ResolveUsername ──────────
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

async function start() {
    console.log("🚀 Запуск Smart Meme Parser...");

    const client = new TelegramClient(stringSession, config.apiId, config.apiHash, {
        connectionRetries: 5,
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
        
        // Find existing channel and update count, or add new
        let existing = data.find(c => c.username === username);
        if (existing) {
            existing.repostCount = (existing.repostCount || 1) + 1;
            fs.writeFileSync(jsonPath, JSON.stringify(data, null, 2));
            fs.writeFileSync(jsPath, 'const discoveredChannels = ' + JSON.stringify(data, null, 2) + ';');
        } else if (!config.targetChannels.includes(username)) {
            data.push({
                username: username,
                title: title || username,
                foundIn: foundIn,
                repostCount: 1,
                subscribers: subs || 'Unknown',
                description: desc || '',
                discoveredAt: new Date().toLocaleString()
            });
            fs.writeFileSync(jsonPath, JSON.stringify(data, null, 2));
            fs.writeFileSync(jsPath, 'const discoveredChannels = ' + JSON.stringify(data, null, 2) + ';');
            console.log(`🌟 Найден новый потенциальный канал через репост: @${username} (из @${foundIn})`);
        }
    }

    // Бесконечный цикл раз в 30 минут (с учетом времени прохода)
    while (true) {
        const passStart = Date.now();
        await processChannels(client, saveDiscoveredChannel);
        const durationMs = Date.now() - passStart;
        
        const waitTimeMs = Math.max(0, (30 * 60 * 1000) - durationMs);
        
        console.log(`\n⏳ Проход занял ${(durationMs / 1000).toFixed(1)} сек. Ожидание ${(waitTimeMs / 1000 / 60).toFixed(1)} мин до следующего прохода...`);
        await new Promise(r => setTimeout(r, waitTimeMs));
    }
}

async function processChannels(client, saveDiscoveredChannel) {
    // Динамически читаем конфиг перед каждым проходом, чтобы админка могла им управлять на лету
    let currentConfig;
    try {
        currentConfig = JSON.parse(fs.readFileSync('./config.json', 'utf8'));
    } catch (e) {
        console.error("Failed to read config:", e);
        currentConfig = config; // fallback to the global one
    }

    console.log(`\n[${new Date().toLocaleString()}] Начинаем сбор по ${currentConfig.targetChannels.length} каналам...`);
    
    let allMemes = [];
    const memory = loadMemory(); // Channel Memory EMA
    let processedCount = 0;
    let skippedCount = 0; // каналы без постов за окно

    // ── Статистика прохода ──────────────────────────────────────────────────
    const stats = {
        totalPostsViewed: 0,  // все просмотренные посты (до фильтра)
        totalPosts: 0,        // прошли фильтр (react≥3, views≥100)
        viral: 0,
        dupFiltered: 0,
        forwarded: 0,
        lt1k: 0, lt5k: 0, lt10k: 0, lt20k: 0, gt20k: 0, unknown: 0
    };
    const dupHits = []; // трекаем самые копируемые мемы

    // Загружаем кэш подписчиков один раз до цикла
    const cachePath = './channel_cache.json';
    let subsCache = {};
    if (fs.existsSync(cachePath)) {
        try { subsCache = JSON.parse(fs.readFileSync(cachePath, 'utf8')); } catch(e){}
    }

    // Временная граница: проверяем посты не старше N часов
    const timeLimitMs = Date.now() - (currentConfig.hoursToCheck * 60 * 60 * 1000);

    for (let channel of currentConfig.targetChannels) {
        try {
            console.log(`📡 Парсинг канала: ${channel}...`);
            // Загружаем память именно этого канала (или null для первого прохода)
            let channelMem = memory[channel] || null;
            const history = await client.invoke(
                new Api.messages.GetHistory({
                    peer: getInputPeer(channel, Api),
                    limit: 50,
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

                // Подписчики: из history.chats (бесплатно), затем из кэша c rawSubs
                function parseRawSubs(raw) {
                    if (!raw) return 0;
                    const s = String(raw).replace(/\s/g,'').toUpperCase();
                    if (s.endsWith('M')) return Math.round(parseFloat(s) * 1_000_000);
                    if (s.endsWith('K')) return Math.round(parseFloat(s) * 1_000);
                    return parseInt(s) || 0;
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
                        
                        const ignoredPath = './ignored_channels.json';
                        let ignoredChannels = [];
                        if (fs.existsSync(ignoredPath)) {
                            try { ignoredChannels = JSON.parse(fs.readFileSync(ignoredPath, 'utf8')); } catch(e){}
                        }

                        // Проверяем, не отслеживаем ли мы уже этот канал
                        const isAlreadyTracked = currentConfig.targetChannels.some(ch => 
                            ch.replace('@', '').toLowerCase() === username.toLowerCase()
                        );

                        if (!ignoredChannels.includes(username) && !isAlreadyTracked) {
                            // Кэш подписчиков...
                            if (subsCache[username] === undefined) {
                                try {
                                    console.log(`🔍 Запрашиваем инфу о ${username} через t.me...`);
                                    const r = await fetch('https://t.me/s/' + username);
                                    const html = await r.text();
                                    
                                    const subsMatch = html.match(/<span class="counter_value">([^<]+)<\/span>\s*<span class="counter_type">subscribers<\/span>/);
                                    const descMatch = html.match(/<div class="tgme_channel_info_description[^>]*>([\s\S]*?)<\/div>/);
                                    
                                    let subsRaw = subsMatch ? subsMatch[1] : '0';
                                    let descRaw = descMatch ? descMatch[1].replace(/<[^>]+>/g, '').trim() : '';
                                    
                                    let parsedSubs = 0;
                                    let strSubs = subsRaw.replace(/ /g, '').toUpperCase();
                                    if (strSubs.endsWith('M')) parsedSubs = parseFloat(strSubs) * 1000000;
                                    else if (strSubs.endsWith('K')) parsedSubs = parseFloat(strSubs) * 1000;
                                    else parsedSubs = parseInt(strSubs) || 0;

                                    subsCache[username] = { subs: parsedSubs, desc: descRaw, rawSubs: subsRaw };
                                    fs.writeFileSync(cachePath, JSON.stringify(subsCache, null, 2));
                                    await new Promise(r => setTimeout(r, 2000));
                                } catch (e) {
                                    console.log(`⚠️ Ошибка получения инфы о ${username}, пропускаем.`);
                                    subsCache[username] = { subs: 999999, desc: '', rawSubs: 'Unknown' };
                                    fs.writeFileSync(cachePath, JSON.stringify(subsCache, null, 2));
                                }
                            }

                            let cacheData = subsCache[username];
                            let subsCount = typeof cacheData === 'number' ? cacheData : (cacheData?.subs || 0);
                            let desc = typeof cacheData === 'object' ? cacheData.desc : '';
                            let rawSubs = typeof cacheData === 'object' ? cacheData.rawSubs : subsCount;

                            if (subsCount <= 10000) {
                                saveDiscoveredChannel(username, fwdChatInfo.title, channel, rawSubs, desc);
                            }
                        }
                    }
                }

                // Проверка на "кружок"
                const isRoundVideo = msg.media && msg.media.className === 'MessageMediaDocument' && 
                                     msg.media.document && msg.media.document.attributes &&
                                     msg.media.document.attributes.some(attr => attr.className === 'DocumentAttributeVideo' && attr.roundMessage);

                if (!msg.media || msg.fwdFrom || isRoundVideo) continue;

                const views = msg.views || 0;
                let reactions = 0;
                let reactionResults = null;
                if (msg.reactions && msg.reactions.results) {
                    reactionResults = msg.reactions.results;
                    reactions = reactionResults.reduce((sum, r) => sum + r.count, 0);
                }
                const replies = msg.replies ? msg.replies.replies : 0;

                stats.totalPostsViewed++;

                // Определяем размер канала ДО фильтра — для адаптивных порогов
                const _chNameF = channel.toLowerCase().replace('@','');
                const _cachedF = subsCache[_chNameF];
                const _subsF = !_cachedF ? 0 : (typeof _cachedF === 'number' ? _cachedF :
                    (_cachedF.subs > 0 ? _cachedF.subs : parseRawSubs(_cachedF.rawSubs)));
                const isMicroChannel = _subsF > 0 && _subsF < 1000;

                // Адаптивные пороги: микроканалы (< 1000 подп.) используют заниженные барьеры
                // У них редко >100 просмотров быстро — важна ОТНОСИТЕЛЬНАЯ аномалия
                const minViews     = isMicroChannel ? 15  : 100;
                const minReactions = isMicroChannel ? 2   : 3;

                // 1. Скорим с текущей памятью (до обновления EMA)
                if (msg.date * 1000 >= timeLimitMs && reactions >= minReactions && views >= minViews) {
                    // Фильтруем: только фото, GIF, видео (не аудио/голос/стикеры)
                    const mediaType = msg.media?.className || '';
                    const mimeType = msg.media?.document?.mimeType || '';
                    const isAudio = mimeType.startsWith('audio/') || mimeType === 'video/ogg';
                    const isVoice = msg.media?.document?.attributes?.some?.(a => a.className === 'DocumentAttributeAudio' && a.voice);
                    const isSticker = msg.media?.document?.attributes?.some?.(a => a.className === 'DocumentAttributeSticker');

                    if (!msg.media || isAudio || isVoice || isSticker) {
                        // Не мем (аудио/голос/стикер/нет медиа)
                    } else {
                        const subsRaw = subsCache[_chNameF] ? (subsCache[_chNameF].rawSubs || subsCache[_chNameF]) : null;

                        let scoredCFS = { cfs: 0, rvi: 0, freshness: 0, sizeM: 1.2, momentumR: 0, momentumV: 0 };
                        let scoredMicro = { mcvi: 0, viewsRatio: 0, erRatio: 0, freshness: 0, momentumV: 0 };

                        if (isMicroChannel) {
                            // Для микроканалов: оба скора (MCVI — основной, CFS — для совместимости)
                            scoredMicro = calculateMicroVirality(views, reactions, replies, msg.date * 1000, channelMem, reactionResults, channel, msg.id);
                            // CFS тоже считаем, но с заниженным весом (для сортировки в общем пуле)
                            scoredCFS = calculateVirality(views, reactions, replies, msg.date * 1000, channelMem, subsRaw, reactionResults, channel, msg.id);
                        } else {
                            scoredCFS = calculateVirality(views, reactions, replies, msg.date * 1000, channelMem, subsRaw, reactionResults, channel, msg.id);
                        }

                        channelMemes.push({
                            channel,
                            peer: srcPeer,
                            isSmall:  _subsF > 0 && _subsF < 2000,
                            isMicro:  isMicroChannel,
                            id: msg.id,
                            date: msg.date,
                            views,
                            reactions,
                            replies,
                            vi:       scoredCFS.cfs,
                            rvi:      scoredCFS.rvi,
                            freshness: scoredCFS.freshness,
                            sizeM:    scoredCFS.sizeM,
                            momentumR: scoredCFS.momentumR,
                            momentumV: scoredCFS.momentumV,
                            // Micro-метрики
                            mcvi:       scoredMicro.mcvi,
                            viewsRatio: scoredMicro.viewsRatio,
                            erRatio:    scoredMicro.erRatio,
                            media: msg.media
                        });
                        stats.totalPosts++;
                    }
                }

                // 2. Затем обновляем EMA-память (включая посты с 0 реакций — для точной нормы)
                channelMem = updateMemory(channelMem, views, reactions, replies, msg.date * 1000);

            }

            // Сохраняем обновлённую Channel Memory канала
            memory[channel] = channelMem;

            // Все посты-кандидаты добавляем в общий пул
            for (let m of channelMemes) {
                m.anomalyScore = m.rvi || 1; // для лога совместимости
                allMemes.push(m);
            }

            processedCount++;

        } catch (e) {
            console.log(`❌ Ошибка при парсинге ${channel}:`, e.message);
            skippedCount++;
        }
        
        // Маленькая пауза для безопасности от FloodWait (т.к. каналов > 120)
        await new Promise(r => setTimeout(r, 200));
    }

    // Сохраняем всю Channel Memory после прохода
    saveMemory(memory);

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
    // Малые каналы могут иметь меньший RVI (нет накопленной памяти), но всё равно ценны
    const allMemesRaw = [...allMemes];

    // Берём топ кандидатов: сортируем по CFS, отсекаем откровенно слабые (RVI < 1.5)
    const MIN_RVI = 1.5;
    const MAX_CANDIDATES = (config.maxMemesToForward || 5) * 3;
    const qualified = allMemes
        .filter(m => parseFloat(m.rvi) >= MIN_RVI)
        .slice(0, MAX_CANDIDATES);
    stats.viral = qualified.length;
    console.log(`✅ Квалифицировано (RVI≥${MIN_RVI}): ${qualified.length} из ${allMemes.length}`);
    allMemes.splice(0, allMemes.length, ...qualified);

    // destPeer: сначала из entity_cache, потом единственный resolve через getEntity
    let destPeer = currentConfig.destinationChannel;
    const _destKey = currentConfig.destinationChannel.replace('@','').toLowerCase();
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
            const destEnt = await client.getEntity(currentConfig.destinationChannel);
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

    // ── Проверяем flood ban state ────────────────────────────────────────────────
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

    if (!floodBanActive) {
    // 1. CFS: топ 5 по Composite Final Score
    const MAX_OLD = 5;
    const oldQueue = allMemes.slice(0, MAX_OLD).map(m => ({ ...m, _slot: 'main' }));
    const mainIds = new Set(oldQueue.map(m => m.channel + '/' + m.id));

    // 2. Моментум: посты с наибольшей динамикой роста прямо сейчас
    // БАГ-ФИКС: убираем фильтр > 0 — на первых проходах у всех постов momentumR=0
    // Сортируем по суммарной скорости, лучшие не из top-5 идут в momentum-слот
    const MAX_MOMENTUM = (config.maxMemesToForward || 15) - MAX_OLD;
    const momentumQueue = [...allMemes]
        .filter(m => !mainIds.has(m.channel + '/' + m.id))
        .sort((a, b) => (b.momentumR + b.momentumV) - (a.momentumR + a.momentumV) || b.vi - a.vi)
        .slice(0, MAX_MOMENTUM)
        .map(m => ({ ...m, _slot: 'momentum' }));
    
    const momentumActive = momentumQueue.filter(m => m.momentumR > 0 || m.momentumV > 0).length;
    console.log(`📈 Momentum-очередь: ${momentumQueue.length} постов (${momentumActive} с активной динамикой)`);
    for (let m of momentumQueue) mainIds.add(m.channel + '/' + m.id);

    // 3. Малые каналы: берём из СЫРОГО пула (до RVI-фильтра)
    // У малых каналов может не быть достаточной истории для высокого RVI
    const MAX_SMALL = config.maxSmallChannelMemes || 3;
    const smallQueue = allMemesRaw
        .filter(m => m.isSmall && !m.isMicro && !mainIds.has(m.channel + '/' + m.id))
        .sort((a, b) => b.vi - a.vi)
        .slice(0, MAX_SMALL)
        .map(m => ({ ...m, _slot: 'small' }));
    for (let m of smallQueue) mainIds.add(m.channel + '/' + m.id);

    // 4. Микроканалы (< 1000 подп.): сортируем по MCVI — нашей относительной метрике
    // Берём из сырого пула, MCVI >= 1.5 считается аномалией для микроканала
    const MAX_MICRO = 3;
    const microQueue = allMemesRaw
        .filter(m => m.isMicro && !mainIds.has(m.channel + '/' + m.id))
        .sort((a, b) => b.mcvi - a.mcvi)
        .slice(0, MAX_MICRO)
        .map(m => ({ ...m, _slot: 'micro' }));

    const microActive = microQueue.filter(m => m.mcvi >= 1.5).length;
    console.log(`📊 Очереди: CFS=${oldQueue.length} Momentum=${momentumQueue.length} Small=${smallQueue.length} Micro=${microQueue.length}(из них аномальных MCVI≥1.5: ${microActive})`);
    const forwardQueue = [...oldQueue, ...momentumQueue, ...smallQueue, ...microQueue];

    for (let meme of forwardQueue) {
        if (meme._slot === 'main'     && forwardedCount    >= MAX_OLD)      continue;
        if (meme._slot === 'momentum' && forwardedMomentum >= MAX_MOMENTUM) continue;
        if (meme._slot === 'small'    && forwardedSmall    >= MAX_SMALL)    continue;
        if (meme._slot === 'micro'    && forwardedMicro    >= MAX_MICRO)    continue;

        try {
            // ── Быстрая дедупликация по channel+msgId (до скачивания медиа) ──
            if (isAlreadyForwarded(meme.channel, meme.id)) {
                console.log(`⏭ Уже пересылали: @${meme.channel}/${meme.id} — пропуск`);
                stats.dupFiltered++;
                continue;
            }

            const buffer = await client.downloadMedia(meme.media, { thumb: 1 });
            if (!buffer) continue; 

            const isDupe = await isDuplicate(buffer, meme.channel, meme.id);
            if (isDupe) {
                console.log(`♻️ БАЯН! @${meme.channel}/${meme.id} ← оригинал: @${isDupe.channelId}/${isDupe.messageId} (hitCount:${isDupe.hitCount})`);
                // Фиксируем картинку в архиве даже если это баян — чтобы знать когда впервые встретилась
                archive.checkAndRecord(buffer).catch(() => {});
                stats.dupFiltered++;
                continue;
            }

            // ── Архивная проверка: фильтр по возрасту картинки ────────────────────
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
                    // Автоматически удаляем из targetChannels
                    try {
                        const cfg = JSON.parse(fs.readFileSync('./config.json', 'utf8'));
                        cfg.targetChannels = cfg.targetChannels.filter(c => c !== meme.channel);
                        if (!cfg.restrictedChannels) cfg.restrictedChannels = [];
                        if (!cfg.restrictedChannels.includes(meme.channel)) cfg.restrictedChannels.push(meme.channel);
                        fs.writeFileSync('./config.json', JSON.stringify(cfg, null, 4));
                        console.log(`   ✂️ @${meme.channel} удалён из парсинга, добавлен в restricted`);
                    } catch(e) { console.log('   cfg update error:', e.message); }
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
                           : meme._slot === 'micro'     ? `Микроканал 🔬 (MCVI:${meme.mcvi} Views×${meme.viewsRatio} ER×${meme.erRatio})`
                           :                              'Малый канал 🐣';
            const text = [
                `🔥 <b>CFS: ${meme.vi}</b>  ·  RVI: ×${meme.rvi}  ·  Size: ×${meme.sizeM}  ·  Свежесть: ${Math.round(meme.freshness*100)}%`,
                `📥 Алгоритм: <b>${slotName}</b>`,
                ``,
                `📡 Источник: @${meme.channel}`,
                `👁 Просмотров: <b>${meme.views.toLocaleString()}</b>  ·  ❤️ Реакций: <b>${meme.reactions}</b>  ·  ER: <b>${er}%</b>`,
                `💬 Комментариев: ${meme.replies || 0}`,
            ].join('\n');

            const botRes = await botSendMessage(BOT_CHAT || currentConfig.destinationChannel, text, newMsgId)
                .catch(e => { console.error('Bot send error:', e.message); return null; });
            if (botRes && !botRes.ok) console.log(`   ⚠️ Bot API: ${botRes.description}`);
            else if (botRes && botRes.ok) console.log(`   📊 Статистика отправлена.`);

            // Сохраняем в базу анти-баяна и в бинарный архив
            await saveToDatabase(buffer, meme.id, meme.channel);
            // Если archiveFilterDays=0, запись в архив ещё не была сделана выше — делаем сейчас
            if (!(currentConfig.archiveFilterDays > 0)) {
                archive.checkAndRecord(buffer).catch(() => {});
            }
            if (meme._slot === 'small')    forwardedSmall++;
            else if (meme._slot === 'momentum') forwardedMomentum++;
            else if (meme._slot === 'micro')    forwardedMicro++;
            else forwardedCount++;
            
            stats.forwarded++;

        } catch (e) {
            console.log(`❌ Ошибка при пересылке:`, e.message);
        }
    }

    } // end if (!floodBanActive)

    saveEntityCache(); // Сохраняем все накопленные entities
    const _fwdCount = forwardedCount + forwardedSmall + forwardedMomentum + forwardedMicro;
    console.log(`\n✅ Итерация завершена. Переслано: ${_fwdCount} мемов (CFS: ${forwardedCount}, Моментум: ${forwardedMomentum}, Малые: ${forwardedSmall}, Микро: ${forwardedMicro}).`);
    console.log(`⏰ Следующий прогон через ~30 мин (в ${new Date(Date.now() + 30*60*1000).toLocaleTimeString('ru')})`);

    // ── Итоговый отчёт в канал ───────────────────────────────────────────────
    const now = new Date();
    const mskTime = new Date(now.getTime() + 3*3600000 + now.getTimezoneOffset()*60000);
    const timeStr = mskTime.toLocaleTimeString('ru', { hour: '2-digit', minute: '2-digit' });

    // Каналы в очереди на фильтрацию (discovered)
    const discoveredPath = './discovered_channels.json';
    const discoveredCount = fs.existsSync(discoveredPath)
        ? (() => { try { return JSON.parse(fs.readFileSync(discoveredPath, 'utf8')).length; } catch(e) { return 0; } })()
        : 0;

    const report = [
        `📊 <b>Отчёт прохода ${timeStr} МСК</b>`,
        ``,
        `📡 <b>Каналов в базе:</b> ${currentConfig.targetChannels.length}`,
        `✅ Обработано: ${processedCount}  ·  ❌ Ошибок: ${skippedCount}`,
        `📌 В очереди на фильтрацию: ${discoveredCount} каналов`,
        ``,
        `📏 <b>Размеры каналов:</b>`,
        `   до 1 000 подп.: ${stats.lt1k}`,
        `   до 5 000 подп.: ${stats.lt5k}`,
        `   до 10 000 подп.: ${stats.lt10k}`,
        `   до 20 000 подп.: ${stats.lt20k}`,
        `   свыше 20 000: ${stats.gt20k}`,
        ...(stats.unknown > 0 ? [`   ❓ нет данных: ${stats.unknown}`] : []),
        ``,
        `🔍 <b>Посты:</b>`,
        `   📖 Просмотрено всего: ${stats.totalPostsViewed}`,
        `   ✔️ С реакциями (react≥3, views≥100): ${stats.totalPosts}`,
        `   🔥 Вирусных (RVI≥1.5): ${stats.viral}`,
        `   ♻️ Баяны: ${stats.dupFiltered}`,
    ].join('\n');

    await botSendMessage(BOT_CHAT || currentConfig.destinationChannel, report)
        .catch(e => console.error('Report send error:', e.message));

    // Отправляем топ-2 самых копируемых мемов если есть баяны
    if (stats.dupFiltered > 0) {
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
                        // ── Формируем отчёт о самом копируемом меме ─────────────────────────
                        const cleanCh = (ch) => String(ch || '').replace('@', '');
                        const totalSeen = (dupe.seenIn ? dupe.seenIn.length : 0);
                        // hitCount — количество новых совпадений за этот период (сброшен при выдаче)
                        // seenIn — накопленная история всех каналов где видели картинку
                        const totalCount = totalSeen || dupe.hitCount || 1;

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
