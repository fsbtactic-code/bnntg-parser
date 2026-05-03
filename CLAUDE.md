# CLAUDE.md — Инструкция для установки через Claude Code

## Промпт для установки одной командой

Скопируй и отправь в Claude Code:

---

```
Установи и запусти проект BananaParser с GitHub: https://github.com/fsbtactic-code/bnntg-parser

Сделай следующее:
1. Склонируй репозиторий в текущую папку
2. Перейди в папку smart_meme_parser и выполни npm install
3. Скопируй config.example.json в config.json
4. Скопируй .env.example в .env
5. Спроси у меня:
   - api_id и api_hash с my.telegram.org
   - username'ы каналов-источников (без @)
   - username моего канала куда публиковать
   - BOT_TOKEN от BotFather
   - BOT_CHANNEL_ID канала (с -100 впереди)
6. Запиши мои ответы в config.json и .env
7. Запусти node auth.js для авторизации Telegram аккаунта
8. После успешной авторизации запусти парсер через PM2: pm2 start index.js --name meme-parser && pm2 save
9. Покажи статус pm2 list
```

---

## Что Claude сделает автоматически

- ✅ Установит зависимости (`npm install`)
- ✅ Создаст `config.json` и `.env` из шаблонов
- ✅ Поможет с авторизацией MTProto сессии
- ✅ Запустит парсер через PM2 в фоне
- ✅ Проверит что всё работает через логи

## Минимальные требования для сервера

```
OS: Ubuntu 20.04+ / Debian 11+
Node.js: 18+
RAM: 512MB+
PM2: устанавливается автоматически
```

Установить Node.js если нет:
```bash
curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
sudo apt-get install -y nodejs
```

## Структура после установки

```
bnntg-parser/
└── smart_meme_parser/
    ├── index.js          ← запускается PM2
    ├── admin_server.js   ← веб-панель :8333
    ├── config.json       ← твои каналы и ключи
    ├── .env              ← токен бота
    └── session.txt       ← MTProto сессия (создаётся при auth)
```
