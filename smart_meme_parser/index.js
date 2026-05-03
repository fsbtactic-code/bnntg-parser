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
const { calculateVirality, updateMemory, loadMemory, saveMemory, adaptiveThreshold } = require('./virality');
const { isDuplicate, saveToDatabase } = require('./dedup');

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
        totalPosts: 0,
        viral: 0,
        dupFiltered: 0,
        forwarded: 0,
        // Размеры каналов (по кол-ву подписчиков source-канала)
        lt1k: 0, lt5k: 0, lt10k: 0, lt20k: 0, gt20k: 0, unknown: 0
    };

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
                    peer: channel,
                    limit: 50,
                })
            );

            let channelMemes = [];

            // Получаем кол-во подписчиков source-канала из ответа Telegram API
            // history.chats содержит инфу о самом канале в первом элементе
            {
                const srcChat = history.chats && history.chats.find(c => {
                    const uname = (c.username || '').toLowerCase();
                    return uname === channel.toLowerCase().replace('@','');
                });
                const srcSubs = srcChat ? (srcChat.participantsCount || 0) : null;
                if (srcSubs === null) {
                    stats.unknown++;
                } else if (srcSubs < 1000)  stats.lt1k++;
                else if (srcSubs < 5000)  stats.lt5k++;
                else if (srcSubs < 10000) stats.lt10k++;
                else if (srcSubs < 20000) stats.lt20k++;
                else                      stats.gt20k++;
            }

            for (let msg of history.messages) {
                // Если это репост из другого канала, проверяем подписчиков и сохраняем
                if (msg.fwdFrom && msg.fwdFrom.fromId && msg.fwdFrom.fromId.className === 'PeerChannel') {
                    const fwdChannelId = msg.fwdFrom.fromId.channelId;
                    const fwdChatInfo = history.chats.find(c => c.id.toString() === fwdChannelId.toString());
                    if (fwdChatInfo && fwdChatInfo.username) {
                        const username = fwdChatInfo.username;
                        
                        // Проверяем игнор-лист (удаленные из Discovered)
                        const ignoredPath = './ignored_channels.json';
                        let ignoredChannels = [];
                        if (fs.existsSync(ignoredPath)) {
                            try { ignoredChannels = JSON.parse(fs.readFileSync(ignoredPath, 'utf8')); } catch(e){}
                        }

                        if (!ignoredChannels.includes(username)) {
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

                // 1. Сначала СКОРИМ с текущей памятью (до обновления)
                // Минимальные пороги: ≥3 реакций и ≥100 просмотров (защита от ложных аномалий)
                if (msg.date * 1000 >= timeLimitMs && reactions >= 3 && views >= 100) {
                    // Фильтруем: только фото, GIF, видео (не аудио/голос/стикеры)
                    const mediaType = msg.media?.className || '';
                    const isDocument = mediaType === 'MessageMediaDocument';
                    const mimeType = msg.media?.document?.mimeType || '';
                    const isAudio = mimeType.startsWith('audio/') || mimeType === 'video/ogg';
                    const isVoice = msg.media?.document?.attributes?.some?.(a => a.className === 'DocumentAttributeAudio' && a.voice);
                    const isSticker = msg.media?.document?.attributes?.some?.(a => a.className === 'DocumentAttributeSticker');

                    if (!msg.media || isAudio || isVoice || isSticker) {
                        // Не мем (аудио/голос/стикер/нет медиа)
                    } else {
                        const subsRaw = subsCache[channel] ? (subsCache[channel].rawSubs || subsCache[channel]) : null;
                        const scored = calculateVirality(views, reactions, replies, msg.date * 1000, channelMem, subsRaw, reactionResults);
                        channelMemes.push({
                            channel,
                            id: msg.id,
                            date: msg.date,
                            views,
                            reactions,
                            replies,
                            vi: scored.cfs,
                            rvi: scored.rvi,
                            freshness: scored.freshness,
                            sizeM: scored.sizeM,
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

    console.log('🔥 ТОП-10 (CFS · RVI · Size · Freshness):');
    allMemes.slice(0, 10).forEach((m, i) => {
        console.log(`  ${i+1}. [@${m.channel}] CFS:${m.vi} RVI:${m.rvi}x Size:${m.sizeM}x Fresh:${m.freshness} React:${m.reactions}`);
    });

    // Берём топ кандидатов: сортируем по CFS, отсекаем откровенно слабые (RVI < 1.5)
    // Без зависимости от «среднего» — берём реальные аномалии
    const MIN_RVI = 1.5; // минимальная аномалия для публикации
    const MAX_CANDIDATES = (config.maxMemesToForward || 5) * 3; // пул в 3× больше нужного
    const qualified = allMemes
        .filter(m => parseFloat(m.rvi) >= MIN_RVI)
        .slice(0, MAX_CANDIDATES);
    stats.viral = qualified.length;
    console.log(`✅ Квалифицировано (RVI≥${MIN_RVI}): ${qualified.length} из ${allMemes.length}`);
    allMemes.splice(0, allMemes.length, ...qualified);

    // Обработка Анти-Баяном и Пересылка
    let forwardedCount = 0;
    
    for (let meme of allMemes) {
        if (forwardedCount >= config.maxMemesToForward) break;

        try {
            const buffer = await client.downloadMedia(meme.media, { thumb: 1 });
            if (!buffer) continue; 

            const isDupe = await isDuplicate(buffer);
            if (isDupe) {
                console.log(`♻️ БАЯН! Пропускаем: ${meme.channel}/${meme.id} (уже было)`);
                stats.dupFiltered++;
                continue;
            }

            console.log(`🚀 ПЕРЕСЫЛАЕМ: @${meme.channel}/${meme.id} (CFS:${meme.vi} RVI:${meme.rvi}x Size:${meme.sizeM}x)`);
            
            let forwarded;
            try {
                forwarded = await client.forwardMessages(config.destinationChannel, {
                    messages: [meme.id],
                    fromPeer: meme.channel
                });
            } catch(fwdErr) {
                const msg = fwdErr.message || '';
                if (msg.includes('FLOOD_WAIT')) {
                    const secs = parseInt(msg.match(/FLOOD_WAIT_(\d+)/)?.[1] || '60');
                    console.log(`⏳ FloodWait ${secs}s — ждём...`);
                    await new Promise(r => setTimeout(r, secs * 1000));
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
                } else {
                    console.log(`❌ Ошибка пересылки @${meme.channel}:`, msg);
                }
                continue;
            }

            if (!forwarded || !forwarded.length) {
                console.log(`⚠️  forwardMessages вернул пустой массив для @${meme.channel}/${meme.id}`);
                continue;
            }

            // gramjs forwardMessages возвращает [[message]] — массив массивов
            let newMsgId = null;
            try {
                if (Array.isArray(forwarded[0])) {
                    // Формат [[msg, ...]]
                    newMsgId = forwarded[0][0]?.id ?? null;
                } else if (forwarded[0]?.id) {
                    newMsgId = forwarded[0].id;
                } else if (forwarded.updates) {
                    const upd = forwarded.updates.find(u => u.className === 'UpdateNewChannelMessage');
                    newMsgId = upd?.message?.id ?? null;
                }
            } catch(_) {}

            console.log(`   ✅ Переслано → msg_id=${newMsgId} в ${config.destinationChannel}`);




            const er = meme.views > 0 ? ((meme.reactions / meme.views) * 100).toFixed(2) : 0;
            const text = [
                `🔥 <b>CFS: ${meme.vi}</b>  ·  RVI: ×${meme.rvi}  ·  Size: ×${meme.sizeM}  ·  Свежесть: ${Math.round(meme.freshness*100)}%`,
                ``,
                `📡 Источник: @${meme.channel}`,
                `👁 Просмотров: <b>${meme.views.toLocaleString()}</b>  ·  ❤️ Реакций: <b>${meme.reactions}</b>  ·  ER: <b>${er}%</b>`,
                `💬 Комментариев: ${meme.replies || 0}`,
            ].join('\n');

            const botRes = await botSendMessage(BOT_CHAT || config.destinationChannel, text, newMsgId)
                .catch(e => { console.error('Bot send error:', e.message); return null; });
            if (botRes && !botRes.ok) console.log(`   ⚠️ Bot API: ${botRes.description}`);

            // Сохраняем в базу анти-баяна
            await saveToDatabase(buffer, meme.id, meme.channel);
            forwardedCount++;
            stats.forwarded++;

        } catch (e) {
            console.log(`❌ Ошибка при пересылке:`, e.message);
        }
    }

    const nextIn = Math.round((30 * 60 * 1000 - (Date.now() % (30*60*1000))) / 60000);
    console.log(`\n✅ Итерация завершена. Переслано: ${forwardedCount} мемов.`);
    console.log(`⏰ Следующий прогон через ~30 мин (в ${new Date(Date.now() + 30*60*1000).toLocaleTimeString('ru')})`);

    // ── Итоговый отчёт в канал ───────────────────────────────────────────────
    const now = new Date();
    const mskTime = new Date(now.getTime() + 3*3600000 + now.getTimezoneOffset()*60000);
    const timeStr = mskTime.toLocaleTimeString('ru', { hour: '2-digit', minute: '2-digit' });

    const report = [
        `📊 <b>Отчёт прохода ${timeStr} МСК</b>`,
        ``,
        `📡 <b>Каналов в базе:</b> ${currentConfig.targetChannels.length}`,
        `✅ Обработано: ${processedCount}  ·  ❌ Ошибок: ${skippedCount}`,
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
        `   Найдено (react≥3, views≥100): ${stats.totalPosts}`,
        `   🔥 Вирусных (RVI≥1.5): ${stats.viral}`,
        `   ♻️ Баяны: ${stats.dupFiltered}`,
        `   📤 Опубликовано: ${stats.forwarded}`,
    ].join('\n');

    await botSendMessage(BOT_CHAT || currentConfig.destinationChannel, report)
        .catch(e => console.error('Report send error:', e.message));

}

start();
