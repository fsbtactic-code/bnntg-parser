const { TelegramClient, Api } = require('telegram');
const { StringSession } = require('telegram/sessions');
const fs = require('fs');

const config = require('./config.json');
const sessionFile = './session.txt';
let sessionStr = '';
if (fs.existsSync(sessionFile)) {
    sessionStr = fs.readFileSync(sessionFile, 'utf8');
}
const stringSession = new StringSession(sessionStr);

const client = new TelegramClient(stringSession, config.apiId, config.apiHash, {
    connectionRetries: 5,
});

const TARGET_CHANNEL = 'russiasmek';

// ─── Балльная система: бот если score >= BAN_THRESHOLD ───────────────────────
const BAN_THRESHOLD = 2;

// Вес: 3 = почти гарантированно бот, 2 = очень подозрительно, 1 = слабый сигнал

function scoreUser(user) {
    const scores = [];
    const firstName = (user.firstName || '').trim();
    const lastName  = (user.lastName  || '').trim();
    const fullName  = `${firstName} ${lastName}`.trim();
    const username  = (user.username  || '').toLowerCase();
    const bio       = (user.about     || '').toLowerCase(); // может быть undefined

    // ── 1. ЖЁСТКИЕ КРИТЕРИИ (+3) ──────────────────────────────────────────────

    // Явно бот по флагу API
    if (user.bot) {
        scores.push({ w: 3, r: 'Telegram-бот (флаг API)' });
    }

    // Имя только из эмодзи / нечитаемых символов / пустое
    if (/^[\s\p{Emoji}\p{So}\p{Sm}\p{Sk}]*$/u.test(fullName) && fullName.length < 3) {
        scores.push({ w: 3, r: 'Имя = только эмодзи или пустое' });
    }

    // Арабские / хинди / тайские / китайские символы в имени (боты из ферм)
    if (/[\u0600-\u06FF\u0900-\u097F\u0E00-\u0E7F\u4E00-\u9FFF\uAC00-\uD7AF]/.test(fullName)) {
        scores.push({ w: 3, r: 'Имя содержит нелатинские/нерусские символы (арабский/хинди/тайский/китайский)' });
    }

    // Крипто/спам-ключевые слова в username или bio
    const SPAM_WORDS = /bitcoin|crypto|invest|trade|forex|profit|earn|casino|bonus|vip|nft|token|wallet|airdrop|pump|usdt|binance|signal|channel|click|join|subscribe|promo|free/i;
    if (SPAM_WORDS.test(username) || SPAM_WORDS.test(bio)) {
        scores.push({ w: 3, r: 'Крипто/спам-слова в username или bio' });
    }

    // Бот/сервисные слова в username
    if (/bot|admin|support|service|official|help|info|news|shop|store/i.test(username)) {
        scores.push({ w: 3, r: 'Сервисное слово в username' });
    }

    // ── 2. СИЛЬНЫЕ КРИТЕРИИ (+2) ──────────────────────────────────────────────

    // Типичные индийские/пакистанские имена-фермы (расширенный список)
    const INDIAN_NAMES = /\b(kumar|singh|sharma|patel|ahmed|ali|khan|mohammad|rajput|yadav|gupta|das|chawla|verma|shaikh|rajan|ravi|suresh|ramesh|ganesh|dinesh|naresh|mahesh|rakesh|rajesh|kaur|bhat|pandey|mishra|tiwari|dubey|soni|joshi|agarwal|kapoor|malhotra|nair|pillai|menon|iyer|reddy|rao|naidu|murthy|sastry|babu|sahu|dixit|tripathi|saxena|mathur|tandon|awasthi|srivastava|chatterjee|mukherjee|banerjee|bose|ghosh|roy|dey|sen|basu|chakraborty|das|datta|paul|biswas|mitra|hazra|mandal|giri|saha|pal|mondal|islam|rahman|hossain|begum|khatun|akter|sultana|molla|sheikh|chowdhury|choudhury|bhuiyan|mian|uddin|siddique|haque|ferdous|kibria|karim|reza|zaman|parveen|nasrin|sabrina|fatima|ayesha|meera|pooja|priya|neha|divya|asha|usha|rekha|radha|sita|lata|mala|kala|veda|gita|rita|nita|anita|sunita|kavita|lalita|mamata|shanta|shobha|sobha|savita|pushpa|padma|kamala|sarala|sumati|sumitra|susheela|saroja|sarojini|sakuntala|sharada|sheela|sheila|shyamala|shantha|vasantha|vasumathi|vidya|vijaya|vimala|vinodha|visalakshi)\b/i;
    if (INDIAN_NAMES.test(fullName) || INDIAN_NAMES.test(username)) {
        scores.push({ w: 2, r: 'Типичное имя-ферма (Индия/Пакистан)' });
    }

    // Username = набор случайных букв+цифр длиннее 10 (без смысла)
    if (/^[a-z]{3,6}\d{4,}$/i.test(username) || /^[a-z\d]{13,}$/i.test(username)) {
        scores.push({ w: 2, r: 'Username выглядит как автогенерат (случайные символы)' });
    }

    // Имя = только латиница, Имя + Фамилия, при этом канал русскоязычный
    // (живые русские подписчики почти всегда пишут кириллицей или имеют username)
    const isLatinNameOnly = /^[A-Za-z\s\-']+$/.test(fullName) && fullName.length > 3;
    const hasNoUsername = !username;
    if (isLatinNameOnly && hasNoUsername) {
        scores.push({ w: 2, r: 'Латинское имя без юзернейма на русском канале' });
    }

    // Нет аватарки И нет юзернейма (вместе — сильный сигнал)
    if (!user.photo && !username) {
        scores.push({ w: 2, r: 'Нет аватарки + нет юзернейма' });
    }

    // ── 3. СЛАБЫЕ КРИТЕРИИ (+1) ───────────────────────────────────────────────

    // Нет аватарки (отдельно — слабый сигнал, у живых людей тоже бывает)
    if (!user.photo) {
        scores.push({ w: 1, r: 'Нет аватарки' });
    }

    // Имя = только цифры или очень короткое (1-2 символа)
    if (/^\d+$/.test(fullName) || fullName.length <= 2) {
        scores.push({ w: 1, r: 'Имя из цифр или слишком короткое' });
    }

    // Username содержит подозрительные числовые паттерны (bot_12345678)
    if (/\d{6,}/.test(username)) {
        scores.push({ w: 1, r: 'Много цифр подряд в username' });
    }

    // Имя повторяет username (типично для автосозданных акков)
    if (username && fullName.toLowerCase().replace(/\s/g, '') === username.replace(/_/g, '')) {
        scores.push({ w: 1, r: 'Имя совпадает с username' });
    }

    // Deleted / restricted аккаунт
    if (user.deleted || user.restricted) {
        scores.push({ w: 3, r: 'Аккаунт удалён или ограничен' });
    }

    const total = scores.reduce((s, x) => s + x.w, 0);
    const reasons = scores.map(x => x.r).join(' | ');
    return { total, reasons };
}

async function runCleaner() {
    await client.start({
        phoneNumber: async () => config.phone,
        password:    async () => '',
        phoneCode:   async () => { throw new Error('Нужна авторизация интерактивно'); },
        onError:     (err) => console.log('Ошибка авторизации:', err),
    });
    console.log("✅ Успешно авторизовано в Telegram!");
    
    console.log(`\nСобираем участников канала @${TARGET_CHANNEL}...`);
    
    let participants = [];
    
    try {
        const channel = await client.getEntity(TARGET_CHANNEL);
        
        for await (const participant of client.iterParticipants(channel)) {
            participants.push(participant);
            if (participants.length % 500 === 0) {
                console.log(`  Собрано ${participants.length}...`);
            }
        }
        
        console.log(`\nВсего найдено участников: ${participants.length}`);
        
        const botsToBan = [];
        const cleanUsers = [];
        
        for (const user of participants) {
            // Пропускаем создателя и администраторов
            if (user.participant && (
                user.participant.className === 'ChannelParticipantCreator' ||
                user.participant.className === 'ChannelParticipantAdmin'
            )) {
                cleanUsers.push({ name: `${user.firstName || ''} ${user.lastName || ''}`.trim(), reason: 'ADMIN/CREATOR — пропущен' });
                continue;
            }

            const { total, reasons } = scoreUser(user);
            const fullName = `${user.firstName || ''} ${user.lastName || ''}`.trim();
            const username = user.username || '';

            if (total >= BAN_THRESHOLD) {
                botsToBan.push({ user, score: total, reason: reasons, name: fullName, username: username || 'Нет' });
            } else {
                cleanUsers.push({ name: fullName, username, score: total, reason: reasons || 'Чистый' });
            }
        }
        
        console.log(`\n🧹 Потенциальных ботов:     ${botsToBan.length}`);
        console.log(`✅ Выживших (чистых):        ${cleanUsers.length}`);
        
        // Логируем чистых — проверка что не баним живых людей
        console.log('\n--- Чистые аккаунты (НЕ баним) ---');
        for (const u of cleanUsers) {
            console.log(`  ✅ ${u.name} (@${u.username || 'Нет'}) score=${u.score} | ${u.reason}`);
        }

        // Логируем первые 30 ботов
        console.log('\n--- Примеры ботов к бану ---');
        for (let i = 0; i < Math.min(30, botsToBan.length); i++) {
            const b = botsToBan[i];
            console.log(`[${i+1}] score=${b.score} | ${b.name} (@${b.username}) — ${b.reason}`);
        }
        
        // Запись полного списка в файл
        let logData = 'БОТЫ К БАНУ:\n';
        for (const b of botsToBan) {
            logData += `score=${b.score} | ID:${b.user.id} | ${b.name} | @${b.username} | ${b.reason}\n`;
        }
        logData += '\n\nЧИСТЫЕ (не трогаем):\n';
        for (const u of cleanUsers) {
            logData += `score=${u.score} | ${u.name} | @${u.username || 'нет'} | ${u.reason}\n`;
        }
        fs.writeFileSync('./bots_to_ban.txt', logData, 'utf8');
        console.log(`\n📄 Полный список сохранён в bots_to_ban.txt`);
        
        if (botsToBan.length === 0) {
            console.log('✨ Нечего банить — канал чист!');
            await client.disconnect();
            return;
        }

        console.log('\n--- ОПАСНАЯ ЗОНА ---');
        console.log(`Через 10 секунд начнётся бан ${botsToBan.length} аккаунтов. Ctrl+C для отмены!`);
        
        await new Promise(r => setTimeout(r, 10000));
        
        console.log('\nНачинаем блокировку...');
        let banned = 0;
        let errors = 0;

        for (const bot of botsToBan) {
            try {
                await client.invoke(new Api.channels.EditBanned({
                    channel: TARGET_CHANNEL,
                    participant: bot.user.id,
                    bannedRights: new Api.ChatBannedRights({
                        untilDate: 0,
                        viewMessages: true,
                        sendMessages: true,
                    }),
                }));
                banned++;
                if (banned % 50 === 0) console.log(`  Заблокировано: ${banned}/${botsToBan.length}...`);
                
                // Безопасная пауза от FloodWait
                await new Promise(r => setTimeout(r, 400));
            } catch (err) {
                errors++;
                console.error(`  ❌ Ошибка бана ID=${bot.user.id}:`, err.message);
                
                if (err.message.includes('FLOOD_WAIT')) {
                    const m = err.message.match(/wait of (\d+)/i);
                    if (m) {
                        const secs = parseInt(m[1], 10);
                        console.log(`  ⏳ FloodWait ${secs} сек...`);
                        await new Promise(r => setTimeout(r, secs * 1000 + 2000));
                    }
                }
            }
        }

        console.log(`\n✅ Готово! Забанено: ${banned}. Ошибок: ${errors}`);
        
    } catch (e) {
        console.error("Критическая ошибка:", e);
    }
    
    await client.disconnect();
}

runCleaner();
