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

// Паттерны для выявления ботов
const SUSPICIOUS_PATTERNS = [
    /^[a-zA-ZÀ-ÿ]+\s+[a-zA-ZÀ-ÿ]+(\s+[a-zA-ZÀ-ÿ]+)?$/i, // Имя Фамилия на латинице (например Eva Licor Gerra, MAIKOL Gonzales)
    /^[a-zA-Z0-9_]{12,}$/, // Очень длинные бессмысленные юзернеймы/имена
    /bot/i,
    /admin/i,
    /support/i,
    /bitcoin/i,
    /crypto/i,
    /invest/i,
    /trade/i,
    /bonus/i,
    /casino/i,
    /vip/i,
    /\?/g, // Знаки вопроса (??????)
];

// Паттерны типичных индийских/арабских имен, которые часто используют фермы
const FOREIGN_PATTERNS = [
    /kumar/i, /singh/i, /sharma/i, /patel/i, /ahmed/i, /ali/i, /khan/i, /mohammad/i,
    /rajput/i, /yadav/i, /gupta/i, /das/i, /chawla/i, /verma/i, /shaikh/i
];

async function runCleaner() {
    await client.start({
        phoneNumber: async () => config.phone || await require('readline').createInterface({ input: process.stdin, output: process.stdout }).question('Введите ваш номер телефона (например, +123456789): '),
        password: async () => await require('readline').createInterface({ input: process.stdin, output: process.stdout }).question('Введите 2FA пароль (если есть): '),
        phoneCode: async () => await require('readline').createInterface({ input: process.stdin, output: process.stdout }).question('Введите код из Telegram: '),
        onError: (err) => console.log('Ошибка авторизации:', err),
    });
    console.log("✅ Успешно авторизовано в Telegram!");
    
    console.log(`Начинаем сбор участников из канала @${TARGET_CHANNEL}...`);
    
    let participants = [];
    
    try {
        const channel = await client.getEntity(TARGET_CHANNEL);
        
        // Получаем всех участников (может занять время)
        for await (const participant of client.iterParticipants(channel)) {
            participants.push(participant);
            if (participants.length % 1000 === 0) {
                console.log(`Собрано ${participants.length} участников...`);
            }
        }
        
        console.log(`\nВсего найдено участников: ${participants.length}`);
        
        const botsToBan = [];
        
        for (const user of participants) {
            let isSuspicious = false;
            let reasons = [];
            
            // Критерий 1: Нет аватарки (самый частый признак ботов из панели)
            if (!user.photo) {
                isSuspicious = true;
                reasons.push('Нет аватарки');
            }
            
            // Проверка имени и фамилии
            const fullName = `${user.firstName || ''} ${user.lastName || ''}`.trim();
            const username = user.username || '';
            
            // Критерий 2: Подозрительные иностранные имена
            for (const pattern of FOREIGN_PATTERNS) {
                if (pattern.test(fullName) || pattern.test(username)) {
                    isSuspicious = true;
                    reasons.push('Иностранное имя/юзернейм');
                    break;
                }
            }
            
            // Критерий 3: Спам-паттерны или бессмысленные длинные имена
            for (const pattern of SUSPICIOUS_PATTERNS) {
                 if (pattern.test(fullName) || pattern.test(username)) {
                    isSuspicious = true;
                    reasons.push('Подозрительный паттерн (спам/бессмысленный)');
                    break;
                }
            }

            // Дополнительная проверка: Если имени вообще нет (только точка, эмодзи и тд)
            if (fullName.length < 2 && !username) {
                isSuspicious = true;
                reasons.push('Пустое или слишком короткое имя');
            }
            
            if (isSuspicious) {
                botsToBan.push({
                    user,
                    reason: reasons.join(' + '),
                    name: fullName,
                    username: username || 'Нет'
                });
            }
        }
        
        console.log(`\n🚨 Найдено потенциальных ботов: ${botsToBan.length}\n`);
        
        // Выведем пример первых 20
        console.log('--- Примеры найденных ботов ---');
        for (let i = 0; i < Math.min(20, botsToBan.length); i++) {
            const b = botsToBan[i];
            console.log(`[${i+1}] ${b.name} (@${b.username}) - Причина: ${b.reason}`);
        }
        
        // Запись в файл для проверки
        let logData = '';
        for (const b of botsToBan) {
            logData += `ID: ${b.user.id} | Имя: ${b.name} | Юзернейм: @${b.username} | Причина: ${b.reason}\n`;
        }
        fs.writeFileSync('./bots_to_ban.txt', logData);
        console.log(`\n📄 Полный список подозрительных ботов сохранен в файл: bots_to_ban.txt`);
        
        console.log('\n--- ОПАСНАЯ ЗОНА ---');
        console.log('Скрипт переходит к блокировке пользователей.');
        console.log('Через 10 секунд начнется бан. Если список в bots_to_ban.txt некорректный, нажмите Ctrl+C!');
        
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
                if (banned % 50 === 0) console.log(`Заблокировано: ${banned}/${botsToBan.length}...`);
                
                // Пауза, чтобы не словить FloodWait от Telegram
                await new Promise(r => setTimeout(r, 500));
            } catch (err) {
                errors++;
                console.error(`Ошибка бана ${bot.user.id}:`, err.message);
                
                if (err.message.includes('FLOOD_WAIT')) {
                    const waitMatch = err.message.match(/A wait of (\d+) seconds/);
                    if (waitMatch) {
                        const waitSecs = parseInt(waitMatch[1], 10);
                        console.log(`⏳ Лимит! Ждем ${waitSecs} сек...`);
                        await new Promise(r => setTimeout(r, waitSecs * 1000 + 1000));
                    }
                }
            }
        }
        console.log(`\n✅ Готово! Успешно заблокировано ботов: ${banned}. Ошибок: ${errors}`);
        
    } catch (e) {
        console.error("Критическая ошибка:", e);
    }
    
    await client.disconnect();
}

runCleaner();
