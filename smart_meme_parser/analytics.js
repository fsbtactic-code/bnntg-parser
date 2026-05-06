const fs = require('fs');
const { TelegramClient, Api } = require('telegram');
const { StringSession } = require('telegram/sessions');

async function runAnalytics() {
    console.log("Загрузка конфигурации...");
    const config = JSON.parse(fs.readFileSync(__dirname + '/config.json', 'utf8'));
    
    let sessionString = '';
    if (fs.existsSync(__dirname + '/session.txt')) {
        sessionString = fs.readFileSync(__dirname + '/session.txt', 'utf8').trim();
    } else {
        console.error("Нет session.txt!");
        return;
    }

    const client = new TelegramClient(new StringSession(sessionString), config.apiId, config.apiHash, {
        connectionRetries: 5,
        useWSS: false
    });

    console.log("Подключение к Telegram...");
    await client.connect();
    console.log("Успешно подключено. Начинаем анализ каналов...");

    let totalPosts = 0;
    let singleImage = 0;
    let singleVideo = 0;
    let textOnly = 0;
    let otherMedia = 0;

    let totalChars = 0;
    let textLengthCategories = {
        '0': 0,
        '1-50': 0,
        '51-200': 0,
        '201+': 0
    };

    let entityCache = {};
    try { if (fs.existsSync(__dirname + '/entity_cache.json')) entityCache = JSON.parse(fs.readFileSync(__dirname + '/entity_cache.json', 'utf8')); } catch(e) {}

    function getInputPeer(username) {
        const key = (username||'').toString().toLowerCase().replace('@','');
        const e = entityCache[key];
        if (e && e.id && e.accessHash) {
            try { return new Api.InputPeerChannel({ channelId: BigInt(e.id), accessHash: BigInt(e.accessHash) }); } catch(_) {}
        }
        return username;
    }

    const targetChannels = config.targetChannels || config.channels;
    
    // Для скорости и предотвращения FloodWait, можно анализировать топ-200 каналов,
    // либо сделать для всех. Сделаем для всех, но по 15 последних постов.
    const LIMIT = 15; 
    let processed = 0;

    for (let channel of targetChannels) {
        if (processed >= 40) break; // Ограничиваем выборку для скорости (40 каналов)
        try {
            const peer = getInputPeer(channel);
            
            const history = await client.invoke(
                new Api.messages.GetHistory({
                    peer: peer,
                    limit: LIMIT,
                    offsetId: 0,
                    offsetDate: 0,
                    addOffset: 0,
                    maxId: 0,
                    minId: 0,
                    hash: 0n,
                })
            );

            if (!history || !history.messages) {
                continue;
            }

            // Группируем альбомы по groupedId
            const albums = new Set();

            for (let msg of history.messages) {
                if (msg.className !== 'Message' && msg.className !== 'MessageService') continue;
                if (!msg.message && !msg.media) continue; // пустые

                if (msg.groupedId) {
                    albums.add(msg.groupedId.toString());
                    continue; // Считаем альбомы как "otherMedia" или будем считать их целиком ниже
                }

                totalPosts++;

                const textLen = msg.message ? msg.message.length : 0;
                totalChars += textLen;

                if (textLen === 0) textLengthCategories['0']++;
                else if (textLen <= 50) textLengthCategories['1-50']++;
                else if (textLen <= 200) textLengthCategories['51-200']++;
                else textLengthCategories['201+']++;

                if (msg.media) {
                    if (msg.media.className === 'MessageMediaPhoto') {
                        singleImage++;
                    } else if (msg.media.className === 'MessageMediaDocument' && msg.media.document && msg.media.document.mimeType && msg.media.document.mimeType.startsWith('video/')) {
                        singleVideo++;
                    } else {
                        otherMedia++;
                    }
                } else {
                    textOnly++;
                }
            }

            // Учитываем альбомы (они состоят из нескольких медиа, мы их считаем как 1 пост "otherMedia" или можно детально)
            // Для упрощения: 1 groupedId = 1 пост (категория otherMedia)
            for (let aid of albums) {
                totalPosts++;
                otherMedia++;
                // Текст в альбоме обычно прикреплен к одному из сообщений группы, мы его проигнорировали выше,
                // но для примерной аналитики сойдет.
            }

            processed++;
            if (processed % 50 === 0) {
                console.log(`Проанализировано ${processed}/${targetChannels.length} каналов...`);
            }

            await new Promise(r => setTimeout(r, 100)); // небольшая пауза

        } catch (e) {
            if (e.message.includes('FLOOD')) {
                console.log(`⚠️ FloodWait: ${e.message}. Прерываем анализ для безопасности.`);
                break;
            }
        }
    }

    console.log("\n===========================================");
    console.log("📊 АНАЛИТИКА ПО БАЗЕ КАНАЛОВ");
    console.log("===========================================");
    console.log(`Всего каналов проанализировано: ${processed}`);
    console.log(`Всего публикаций проанализировано: ${totalPosts}\n`);

    if (totalPosts > 0) {
        console.log(`🖼 Одно фото (1 картинка): ${((singleImage / totalPosts) * 100).toFixed(1)}% (${singleImage})`);
        console.log(`🎥 Одно видео (1 видео): ${((singleVideo / totalPosts) * 100).toFixed(1)}% (${singleVideo})`);
        console.log(`📝 Только текст (без медиа): ${((textOnly / totalPosts) * 100).toFixed(1)}% (${textOnly})`);
        console.log(`📂 Альбомы и др. медиа (гифки и т.д.): ${((otherMedia / totalPosts) * 100).toFixed(1)}% (${otherMedia})\n`);

        console.log(`📏 Среднее кол-во символов: ${(totalChars / totalPosts).toFixed(0)} симв.\n`);

        console.log(`Распределение текста (символы):`);
        console.log(`   Без текста (0): ${((textLengthCategories['0'] / totalPosts) * 100).toFixed(1)}%`);
        console.log(`   Короткий (1-50): ${((textLengthCategories['1-50'] / totalPosts) * 100).toFixed(1)}%`);
        console.log(`   Средний (51-200): ${((textLengthCategories['51-200'] / totalPosts) * 100).toFixed(1)}%`);
        console.log(`   Длинный (201+): ${((textLengthCategories['201+'] / totalPosts) * 100).toFixed(1)}%`);
    }

    await client.disconnect();
    process.exit(0);
}

runAnalytics();
