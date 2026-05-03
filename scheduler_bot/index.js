'use strict';
/**
 * Scheduler Bot — автоматическая публикация в Telegram-канал
 * 
 * Интервал публикаций (МСК):
 *   07:00–09:00  → каждые 15 мин
 *   18:00–22:00  → каждые 15 мин
 *   остальное    → каждые 30 мин
 * 
 * Поддерживает: фото, видео, GIF, документы, альбомы (media group), подписи
 */

const TelegramBot = require('node-telegram-bot-api');
const fs          = require('fs');
const path        = require('path');

// ── Конфиг ──────────────────────────────────────────────────────────────────
const TOKEN      = process.env.BOT_TOKEN      || '8759138938:AAEd9Dy2yWts7o_f4mQoKoBhHMdv_t6uMzA';
const CHANNEL_ID = process.env.CHANNEL_ID     || '-1001786724036';
const QUEUE_FILE = path.join(__dirname, 'queue.json');
const STATE_FILE = path.join(__dirname, 'state.json');

// ── Хранилище ─────────────────────────────────────────────────────────────────
const loadJSON = (f, def) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return def; } };
const saveJSON = (f, d)   => fs.writeFileSync(f, JSON.stringify(d, null, 2));
const loadQueue = ()   => loadJSON(QUEUE_FILE, []);
const saveQueue = q    => saveJSON(QUEUE_FILE, q);
const loadState = ()   => loadJSON(STATE_FILE, { lastPostedAt: 0, adminChatIds: [] });
const saveState = s    => saveJSON(STATE_FILE, s);

// ── Московское время ──────────────────────────────────────────────────────────
function getMskDate() {
    const now = new Date();
    // Moscow = UTC+3
    return new Date(now.getTime() + (3 * 3600000) + (now.getTimezoneOffset() * 60000));
}
function getMskHour()   { return getMskDate().getHours(); }
function getMskTimeStr() {
    const d = getMskDate();
    return `${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
}

// Интервал в мс в зависимости от времени МСК
function getIntervalMs() {
    const h = getMskHour();
    const isPeak = (h >= 7 && h < 9) || (h >= 18 && h < 22);
    return (isPeak ? 15 : 30) * 60 * 1000;
}

function getIntervalLabel() {
    const h = getMskHour();
    return (h >= 7 && h < 9) || (h >= 18 && h < 22) ? '15 мин' : '30 мин';
}

// Минут до следующей публикации
function minsUntilNext() {
    const state = loadState();
    if (!state.lastPostedAt) return 0;
    const remaining = getIntervalMs() - (Date.now() - state.lastPostedAt);
    return remaining > 0 ? Math.ceil(remaining / 60000) : 0;
}

// ── Очередь ───────────────────────────────────────────────────────────────────
function enqueue(item, chatId) {
    const q = loadQueue();
    q.push({ ...item, addedAt: Date.now() });
    saveQueue(q);

    const mins = minsUntilNext();
    const eta  = mins > 0 ? `~${mins} мин` : 'ближайшая проверка';
    if (chatId) {
        bot.sendMessage(chatId,
            `✅ Добавлено в очередь (позиция #${q.length})\n` +
            `📋 В очереди: *${q.length}* постов\n` +
            `⏰ Следующая публикация через: *${eta}*\n` +
            `🕐 Текущий интервал: *${getIntervalLabel()}*`,
            { parse_mode: 'Markdown' }
        ).catch(() => {});
    }
}

// ── Буфер для media group (альбомов) ─────────────────────────────────────────
const groupBuf = new Map(); // media_group_id → { chatId, items, caption, timer }

function handleGroupItem(msg, type, fileId) {
    const gid = msg.media_group_id;
    if (!groupBuf.has(gid)) {
        groupBuf.set(gid, { chatId: msg.chat.id, items: [], caption: '' });
    }
    const grp = groupBuf.get(gid);
    grp.items.push({ type, media: fileId });
    if (msg.caption && !grp.caption) grp.caption = msg.caption;

    clearTimeout(grp.timer);
    grp.timer = setTimeout(() => {
        groupBuf.delete(gid);
        // Caption — на первый элемент
        const mediaArr = grp.items.map((it, i) => ({
            type: it.type,
            media: it.media,
            ...(i === 0 && grp.caption ? { caption: grp.caption, parse_mode: 'HTML' } : {})
        }));
        enqueue({ type: 'media_group', items: mediaArr }, grp.chatId);
    }, 2000); // ждём 2 с чтобы собрать все части альбома
}

// ── Бот ───────────────────────────────────────────────────────────────────────
const bot = new TelegramBot(TOKEN, { polling: true });

function registerAdmin(chatId) {
    const s = loadState();
    if (!s.adminChatIds.includes(chatId)) {
        s.adminChatIds.push(chatId);
        saveState(s);
    }
}

// /start
bot.onText(/\/start/, msg => {
    registerAdmin(msg.chat.id);
    bot.sendMessage(msg.chat.id,
        `🤖 *Scheduler Bot* запущен!\n\n` +
        `📤 Отправь мне: фото, видео, GIF, альбом (с текстом или без)\n` +
        `📅 Расписание публикаций *МСК*:\n` +
        `   • 07:00–09:00 → каждые *15 мин*\n` +
        `   • 18:00–22:00 → каждые *15 мин*\n` +
        `   • Остальное  → каждые *30 мин*\n\n` +
        `Команды:\n` +
        `/status — очередь и время\n` +
        `/list — первые 5 постов в очереди\n` +
        `/skip — пропустить первый пост\n` +
        `/clear — очистить всю очередь`,
        { parse_mode: 'Markdown' }
    );
});

// /status
bot.onText(/\/status/, msg => {
    registerAdmin(msg.chat.id);
    const q    = loadQueue();
    const mins = minsUntilNext();
    bot.sendMessage(msg.chat.id,
        `📊 *Статус планировщика*\n\n` +
        `🕐 Время МСК: *${getMskTimeStr()}*\n` +
        `⏱ Интервал сейчас: *${getIntervalLabel()}*\n` +
        `📋 В очереди: *${q.length}* постов\n` +
        `⏰ До публикации: *${mins > 0 ? mins + ' мин' : 'скоро'}*`,
        { parse_mode: 'Markdown' }
    );
});

// /list
bot.onText(/\/list/, msg => {
    registerAdmin(msg.chat.id);
    const q = loadQueue();
    if (!q.length) return bot.sendMessage(msg.chat.id, '📋 Очередь пуста');
    const lines = q.slice(0, 5).map((it, i) => {
        const label = it.type === 'media_group'
            ? `📸 Альбом (${it.items.length} фото/видео)`
            : it.type === 'photo'   ? '🖼 Фото'
            : it.type === 'video'   ? '🎬 Видео'
            : it.type === 'animation' ? '🎞 GIF'
            : '📎 Файл';
        const cap = it.caption ? ` — "${it.caption.slice(0, 40)}${it.caption.length > 40 ? '…' : ''}"` : '';
        return `${i + 1}. ${label}${cap}`;
    });
    bot.sendMessage(msg.chat.id,
        `📋 *Очередь (первые ${Math.min(5, q.length)} из ${q.length}):*\n\n` + lines.join('\n'),
        { parse_mode: 'Markdown' }
    );
});

// /skip
bot.onText(/\/skip/, msg => {
    registerAdmin(msg.chat.id);
    const q = loadQueue();
    if (!q.length) return bot.sendMessage(msg.chat.id, '❌ Очередь пуста');
    const skipped = q.shift();
    saveQueue(q);
    bot.sendMessage(msg.chat.id, `⏭ Пропущено: ${skipped.type}. В очереди: ${q.length}`);
});

// /clear
bot.onText(/\/clear/, msg => {
    registerAdmin(msg.chat.id);
    saveQueue([]);
    bot.sendMessage(msg.chat.id, '🗑 Очередь очищена');
});

// Фото
bot.on('photo', msg => {
    registerAdmin(msg.chat.id);
    const fileId = msg.photo[msg.photo.length - 1].file_id; // самое крупное
    if (msg.media_group_id) {
        handleGroupItem(msg, 'photo', fileId);
    } else {
        enqueue({ type: 'photo', fileId, caption: msg.caption || '' }, msg.chat.id);
    }
});

// Видео
bot.on('video', msg => {
    registerAdmin(msg.chat.id);
    const fileId = msg.video.file_id;
    if (msg.media_group_id) {
        handleGroupItem(msg, 'video', fileId);
    } else {
        enqueue({ type: 'video', fileId, caption: msg.caption || '' }, msg.chat.id);
    }
});

// GIF / анимация
bot.on('animation', msg => {
    registerAdmin(msg.chat.id);
    enqueue({ type: 'animation', fileId: msg.animation.file_id, caption: msg.caption || '' }, msg.chat.id);
});

// Документ (файл, webp, sticker-pack и пр.)
bot.on('document', msg => {
    registerAdmin(msg.chat.id);
    enqueue({ type: 'document', fileId: msg.document.file_id, caption: msg.caption || '' }, msg.chat.id);
});

// ── Публикатор ────────────────────────────────────────────────────────────────
async function publishNext() {
    const q = loadQueue();
    if (!q.length) return;

    const item = q[0];
    const opts = {};
    if (item.caption) opts.caption = item.caption;

    try {
        if (item.type === 'photo') {
            await bot.sendPhoto(CHANNEL_ID, item.fileId, opts);
        } else if (item.type === 'video') {
            await bot.sendVideo(CHANNEL_ID, item.fileId, opts);
        } else if (item.type === 'animation') {
            await bot.sendAnimation(CHANNEL_ID, item.fileId, opts);
        } else if (item.type === 'document') {
            await bot.sendDocument(CHANNEL_ID, item.fileId, opts);
        } else if (item.type === 'media_group') {
            await bot.sendMediaGroup(CHANNEL_ID, item.items);
        }

        // Успех — убираем из очереди
        q.shift();
        saveQueue(q);

        const s = loadState();
        s.lastPostedAt = Date.now();
        saveState(s);

        console.log(`✅ [${getMskTimeStr()} МСК] ${item.type} опубликован. В очереди: ${q.length}. Следующий через ${getIntervalLabel()}`);

        // Уведомляем администраторов
        for (const chatId of s.adminChatIds) {
            bot.sendMessage(chatId,
                `📢 Опубликовано! В очереди осталось: *${q.length}*`,
                { parse_mode: 'Markdown' }
            ).catch(() => {});
        }

    } catch (err) {
        console.error(`❌ Ошибка публикации (${item.type}):`, err.message);
        // Не удаляем из очереди — попробуем снова
    }
}

// ── Планировщик (тик каждые 30 сек) ─────────────────────────────────────────
setInterval(async () => {
    const state = loadState();
    const q     = loadQueue();
    if (!q.length) return;

    const elapsed = Date.now() - (state.lastPostedAt || 0);
    if (elapsed >= getIntervalMs()) {
        await publishNext();
    }
}, 30 * 1000);

console.log('🤖 Scheduler Bot запущен');
console.log(`📢 Канал: ${CHANNEL_ID}`);
console.log(`⏱ Интервал: 30 мин (15 мин в 07-09 и 18-22 МСК)`);
