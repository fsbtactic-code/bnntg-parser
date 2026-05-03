/**
 * BananaParser — Авторизация Telegram MTProto сессии
 * Запусти один раз: node auth.js
 * Создаст session.txt — храни его в тайне!
 */

const { TelegramClient } = require('telegram');
const { StringSession } = require('telegram/sessions');
const input = require('input');
const fs = require('fs');

// Читаем конфиг
let config;
try {
    config = JSON.parse(fs.readFileSync('./config.json', 'utf8'));
} catch (e) {
    console.error('❌ Не найден config.json. Скопируй config.example.json в config.json и заполни.');
    process.exit(1);
}

if (!config.apiId || !config.apiHash || config.apiHash === 'your_api_hash_here') {
    console.error('❌ Заполни apiId и apiHash в config.json (получить на my.telegram.org)');
    process.exit(1);
}

(async () => {
    console.log('\n🍌 BananaParser — Авторизация\n');
    console.log('Получи API ключи на https://my.telegram.org\n');

    const client = new TelegramClient(
        new StringSession(''),
        config.apiId,
        config.apiHash,
        { connectionRetries: 3 }
    );

    await client.start({
        phoneNumber: async () => await input.text('📱 Номер телефона (с +7): '),
        password: async () => await input.text('🔑 Пароль 2FA (если есть, иначе Enter): '),
        phoneCode: async () => await input.text('💬 Код из Telegram: '),
        onError: (err) => console.log('Ошибка:', err),
    });

    const session = client.session.save();
    fs.writeFileSync('./session.txt', session);
    
    const me = await client.getMe();
    console.log(`\n✅ Авторизован как: @${me.username} (${me.firstName})`);
    console.log('✅ session.txt создан\n');
    console.log('Теперь запускай: node index.js');
    console.log('Или через PM2: pm2 start index.js --name meme-parser\n');

    await client.disconnect();
})();
