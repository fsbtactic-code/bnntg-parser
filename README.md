# 🍌 BananaParser — Умный парсер вирусных мемов из Telegram

Автоматически находит самые вирусные мемы из Telegram-каналов и публикует их в ваш канал. Работает круглосуточно на сервере.

## Как это работает

Каждые 30 минут парсер:
1. Читает последние посты из ваших каналов-источников
2. Считает **Composite Final Score (CFS)** для каждого поста
3. Пересылает топ-мемы в ваш канал через Telegram аккаунт
4. Бот пишет аналитику под каждым постом

### Формула CFS
```
VI  = views + reactions×5 + replies×3
RVI = VI / EMA_канала          (аномалия относительно нормы канала)
CFS = RVI × sizeM × freshness  (итоговый ранг)
```
Чем выше CFS — тем более вирусный пост относительно нормы канала.

---

## Быстрый старт

### Что нужно
- **Linux сервер** (Ubuntu 20.04+) с Node.js 18+
- **Telegram аккаунт** (не бот!) для парсинга и пересылки
- **Telegram бот** для публикации аналитики
- **API ключи** с [my.telegram.org](https://my.telegram.org)

### 1. Получи Telegram API ключи

1. Зайди на [my.telegram.org](https://my.telegram.org)
2. Apps → Create new application
3. Запиши `api_id` и `api_hash`

### 2. Создай Telegram бота

1. Напиши [@BotFather](https://t.me/BotFather) → `/newbot`
2. Запиши токен: `1234567890:AAFxxxx...`
3. **Добавь бота как администратора** в твой канал с правом публикации

### 3. Клонируй репозиторий

```bash
git clone https://github.com/fsbtactic-code/bnntg-parser
cd bnntg-parser/smart_meme_parser
npm install
```

### 4. Создай конфиг

```bash
cp config.example.json config.json
```

Отредактируй `config.json`:
```json
{
    "apiId": 12345678,
    "apiHash": "твой_api_hash",
    "targetChannels": [
        "username_канала_1",
        "username_канала_2"
    ],
    "destinationChannel": "@твой_канал",
    "hoursToCheck": 0.5,
    "maxMemesToForward": 5
}
```

> `targetChannels` — username'ы каналов **без @**, откуда берём мемы  
> `destinationChannel` — куда публикуем (нужны права администратора)

### 5. Создай .env

```bash
cp .env.example .env
nano .env
```

```
BOT_TOKEN=токен_бота
BOT_CHANNEL_ID=-100твой_chat_id
```

> Узнать `chat_id` канала: добавь бота [@username_to_id_bot](https://t.me/username_to_id_bot)

### 6. Авторизация Telegram аккаунта

```bash
node auth.js
```

Введи номер телефона и код из Telegram. Создастся `session.txt` — **храни его в тайне**.

### 7. Запуск

```bash
# Тест (одноразово)
node index.js

# Постоянная работа через PM2
npm install -g pm2
pm2 start index.js --name meme-parser
pm2 save
pm2 startup
```

### 8. Админ-панель (опционально)

```bash
# В папке smart_meme_parser
node admin_server.js
```

Открой `http://localhost:8333` — интерфейс для управления каналами.

---

## Структура файлов

```
smart_meme_parser/
├── index.js              # Главный парсер (запускать этот)
├── admin_server.js       # Веб-интерфейс управления
├── virality.js           # Математика: CFS, EMA, RVI
├── dedup.js              # Анти-баян через pHash
├── auth.js               # Авторизация MTProto сессии
│
├── config.example.json   # Шаблон конфига (скопируй в config.json)
├── .env.example          # Шаблон env (скопируй в .env)
│
├── config.json           # ❌ Создай сам (в .gitignore)
├── .env                  # ❌ Создай сам (в .gitignore)
└── session.txt           # ❌ Создаётся при auth.js (в .gitignore)
```

---

## Частые вопросы

**Q: Парсер пересылает чужой пост — это нормально?**  
A: Да, используется стандартный `forwardMessages` MTProto API, как если бы ты пересылал вручную.

**Q: Что значит "Канал в ЧС"?**  
A: Некоторые каналы запрещают пересылку. Парсер автоматически их исключает.

**Q: Как добавить новые каналы?**  
A: Через админ-панель или напрямую в `config.json`. Парсер подхватывает изменения на следующем прогоне.

**Q: Как часто публикуются мемы?**  
A: Каждые 30 минут, максимум `maxMemesToForward` постов за прогон (по умолчанию 5).

---

## Стек

- **Node.js** + [GramJS](https://github.com/gram-js/gramjs) (MTProto клиент)
- **Express** (Admin UI)
- **Jimp** (pHash для анти-баяна)
- **PM2** (daemon)

---

*Сделано с 🍌 — [BananaParser](https://github.com/fsbtactic-code/bnntg-parser)*
