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

const SUSPICIOUS_PATTERNS = [
    /^[a-zA-ZÀ-ÿ]+\s+[a-zA-ZÀ-ÿ]+(\s+[a-zA-ZÀ-ÿ]+)?$/i,
    /^[a-zA-Z0-9_]{12,}$/,
    /bot/i, /admin/i, /support/i, /bitcoin/i, /crypto/i,
    /invest/i, /trade/i, /bonus/i, /casino/i, /vip/i, /\?/g,
];

const FOREIGN_PATTERNS = [
    /kumar/i, /singh/i, /sharma/i, /patel/i, /ahmed/i, /ali/i, /khan/i, /mohammad/i,
    /rajput/i, /yadav/i, /gupta/i, /das/i, /chawla/i, /verma/i, /shaikh/i,
];

async function runCleaner() {
    await client.start();
    console.log("✅ Успешно авторизовано в Telegram!");
    console.log(`Начинаем ГЛУБОКИЙ поиск (A-Z) в @${TARGET_CHANNEL}...`);
    
    const channel = await client.getEntity(TARGET_CHANNEL);
    // Пройдемся по алфавиту, чтобы обойти ограничение Telegram в 200 пользователей
    const alphabet = 'abcdefghijklmnopqrstuvwxyz'.split('');
    
    let allParticipants = new Map();
    
    for (const char of alphabet) {
        process.stdout.write(`🔍 Ищем на букву '${char}'... `);
        let count = 0;
        try {
            for await (const p of client.iterParticipants(channel, { search: char })) {
                if (!allParticipants.has(p.id)) {
                    allParticipants.set(p.id, p);
                    count++;
                }
            }
            console.log(`Найдено: ${count}`);
            await new Promise(r => setTimeout(r, 800)); // Защита от лимитов (FloodWait)
        } catch (e) {
            console.error(`Ошибка при поиске ${char}:`, e.message);
        }
    }
    
    console.log(`\n✅ Всего собрано участников через алфавитный поиск: ${allParticipants.size}`);
    
    const botsToBan = [];
    
    for (const [id, user] of allParticipants.entries()) {
        let isSuspicious = false;
        let reasons = [];
        
        const fullName = `${user.firstName || ''} ${user.lastName || ''}`.trim();
        const username = user.username || '';
        
        if (!user.photo) {
            reasons.push('Нет аватарки');
        }
        
        if (!username) {
            reasons.push('Нет юзернейма');
        }
        
        for (const pattern of FOREIGN_PATTERNS) {
            if (pattern.test(fullName) || pattern.test(username)) {
                isSuspicious = true;
                reasons.push('Иностранное имя/юзернейм');
                break;
            }
        }
        
        for (const pattern of SUSPICIOUS_PATTERNS) {
             if (pattern.test(fullName) || pattern.test(username)) {
                isSuspicious = true;
                reasons.push('Подозрительный паттерн');
                break;
            }
        }

        if (fullName.length < 2 && !username) {
            isSuspicious = true;
            reasons.push('Пустое или слишком короткое имя');
        }
        
        // УСЛОВИЕ БАНА: У бота должна быть комбинация подозрительных признаков,
        // чтобы не забанить случайно русского пользователя без аватарки.
        // Главный критерий: Имя латиницей (SUSPICIOUS_PATTERNS) + Отсутствие юзернейма
        if (isSuspicious && reasons.includes('Нет юзернейма') && (reasons.includes('Подозрительный паттерн') || reasons.includes('Иностранное имя/юзернейм') || reasons.includes('Пустое или слишком короткое имя'))) {
            botsToBan.push({
                user,
                reason: reasons.join(' + '),
                name: fullName,
                username: username || 'Нет'
            });
        }
    }
    
    console.log(`\n🚨 Найдено 100% ботов для блокировки: ${botsToBan.length}\n`);
    
    console.log('--- Примеры ботов ---');
    for (let i = 0; i < Math.min(20, botsToBan.length); i++) {
        console.log(`[${i+1}] ${botsToBan[i].name} - ${botsToBan[i].reason}`);
    }
    
    if (botsToBan.length === 0) {
        console.log("Ботов не найдено, завершение.");
        await client.disconnect();
        return;
    }

    console.log('\n--- ОПАСНАЯ ЗОНА ---');
    console.log('Начинаем массовую блокировку через 10 секунд... (Ctrl+C для отмены)');
    await new Promise(r => setTimeout(r, 10000));
    
    let banned = 0;
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
            if (banned % 50 === 0) console.log(`Заблокировано: ${banned}/${botsToBan.length}...`);
            await new Promise(r => setTimeout(r, 500));
        } catch (err) {
            console.error(`Ошибка бана ${bot.user.id}:`, err.message);
            if (err.message.includes('FLOOD_WAIT') || err.message.includes('wait of')) {
                const waitMatch = err.message.match(/A wait of (\d+) seconds/);
                const waitSecs = waitMatch ? parseInt(waitMatch[1], 10) : 60;
                console.log(`⏳ Telegram установил лимит на удаление. Ждем ${waitSecs} секунд...`);
                await new Promise(r => setTimeout(r, waitSecs * 1000 + 2000));
                // Повторяем попытку для этого же бота
                try {
                    await client.invoke(new Api.channels.EditBanned({
                        channel: TARGET_CHANNEL,
                        participant: bot.user.id,
                        bannedRights: new Api.ChatBannedRights({ untilDate: 0, viewMessages: true, sendMessages: true })
                    }));
                    banned++;
                } catch(e) {}
            }
        }
    }
    console.log(`\n✅ Успешно заблокировано ботов: ${banned}`);
    await client.disconnect();
}
runCleaner();
