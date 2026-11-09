'use strict';

const dns = require('dns');
const net = require('net');
const { Telegraf } = require('telegraf');
const mineflayer = require('mineflayer');

// Railway інколи віддає IPv6, на який Minecraft-сервер не слухає
try { dns.setDefaultResultOrder('ipv4first'); } catch (_) {}

// ================== НАЛАШТУВАННЯ ==================
const TOKEN = process.env.TOKEN; // задай у Railway -> Variables
const DEFAULT_NICK = 'AFK_BOT';
const MAX_SECONDS = 2 * 365 * 24 * 3600; // максимум 2 роки
const MAX_SESSIONS = 30;
const ATTEMPT_TIMEOUT = 20000; // мс на одну спробу входу
// ==================================================

if (!TOKEN) {
  console.error('Не задано змінну TOKEN');
  process.exit(1);
}

// бот не повинен падати через помилки бібліотек
process.on('uncaughtException', (e) => console.error('uncaughtException:', e));
process.on('unhandledRejection', (e) => console.error('unhandledRejection:', e));

const tg = new Telegraf(TOKEN);

// ---------------------- час ----------------------
const UNITS = {
  'с': 1, s: 1, 'сек': 1,
  'х': 60, x: 60, 'хв': 60, min: 60,
  'г': 3600, h: 3600, 'год': 3600,
  'д': 86400, d: 86400, 'дн': 86400,
  'т': 7 * 86400, w: 7 * 86400,
  'м': 30 * 86400, 'мс': 30 * 86400, mo: 30 * 86400,
  'р': 365 * 86400, y: 365 * 86400, 'рік': 365 * 86400,
};

function parseTime(text) {
  const m = String(text).trim().toLowerCase().match(/^(\d+)\s*(\p{L}+)$/u);
  if (!m) return null;
  const mult = UNITS[m[2]];
  if (!mult) return null;
  return parseInt(m[1], 10) * mult;
}

function fmtTime(sec) {
  const parts = [];
  for (const [name, size] of [['р', 365 * 86400], ['міс', 30 * 86400], ['д', 86400], ['г', 3600], ['хв', 60], ['с', 1]]) {
    if (sec >= size) {
      parts.push(`${Math.floor(sec / size)}${name}`);
      sec %= size;
    }
  }
  return parts.join(' ') || '0с';
}

// ---------------------- допоміжне ----------------------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const withTimeout = (p, ms, msg) =>
  Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(msg)), ms))]);

// причина кіку може бути рядком, JSON або NBT-структурою -> робимо звичайний текст
function simplify(v) {
  if (Array.isArray(v)) return v.map(simplify);
  if (v && typeof v === 'object') {
    if ('type' in v && 'value' in v && Object.keys(v).length <= 2) return simplify(v.value);
    const o = {};
    for (const k of Object.keys(v)) o[k] = simplify(v[k]);
    return o;
  }
  return v;
}

function flatten(c) {
  if (c == null) return '';
  if (typeof c === 'string') {
    try {
      const p = JSON.parse(c);
      if (p && typeof p === 'object') return flatten(p);
    } catch (_) {}
    return c;
  }
  if (typeof c === 'number' || typeof c === 'boolean') return String(c);
  if (Array.isArray(c)) return c.map(flatten).join('');
  let s = '';
  if (c.text != null) s += flatten(c.text);
  else if (c.translate) s += c.translate;
  if (c.extra) s += flatten(c.extra);
  return s;
}

function reasonText(r) {
  let t = '';
  try { t = flatten(simplify(r)); } catch (_) {}
  if (!t) {
    try { t = JSON.stringify(r); } catch (_) { t = String(r); }
  }
  return String(t).replace(/§./g, '').replace(/\s+/g, ' ').trim().slice(0, 250);
}

const VERSION_HINT = /outdated|incompatible|unsupported|protocol|version|viaversion|please use|use 1\.|use 26\.|версі|клієнт/i;

// SRV-запис (як у справжньому клієнті Minecraft): play.server.net -> реальний хост:порт
async function resolveTarget(host, port) {
  if (port === 25565 && net.isIP(host) === 0 && host !== 'localhost') {
    try {
      const r = await withTimeout(dns.promises.resolveSrv('_minecraft._tcp.' + host), 5000, 'srv timeout');
      if (r && r.length) return { host: r[0].name, port: r[0].port, srv: true };
    } catch (_) {}
  }
  return { host, port, srv: false };
}

// пінг сервера (тільки для інформації)
function pingServer(host, port, version) {
  let mc;
  try { mc = require('minecraft-protocol'); } catch (_) { return Promise.reject(new Error('no minecraft-protocol')); }
  const o = { host, port };
  if (version) o.version = version;
  return withTimeout(
    new Promise((resolve, reject) => mc.ping(o, (err, res) => (err ? reject(err) : resolve(res)))),
    12000, 'пінг не відповів за 12с');
}

// ---------------------- сесії ----------------------
const sessions = new Map(); // userId -> session

async function send(chatId, text) {
  try {
    await tg.telegram.sendMessage(chatId, String(text).slice(0, 4000));
  } catch (e) {
    console.error('Не вдалося надіслати повідомлення:', e.message);
  }
}

function cleanup(s) {
  s.stopped = true;
  clearInterval(s.ticker);
  clearInterval(s.antiAfk);
  if (sessions.get(s.userId) === s) sessions.delete(s.userId);
}

function hardStop(s) {
  for (const b of [s.bot, s.pending]) {
    if (!b) continue;
    try { b.quit(); } catch (_) {}
    try { b.end(); } catch (_) {}
  }
}

function stopSession(userId) {
  const s = sessions.get(userId);
  if (!s) return false;
  cleanup(s);
  hardStop(s);
  return true;
}

// одна спроба входу з конкретною версією
function attempt(s, baseOpts, version) {
  return new Promise((resolve) => {
    let stage = 'підключення';
    let done = false;
    let bot;
    const finish = (r) => {
      if (done) return;
      done = true;
      clearTimeout(t);
      resolve(r);
    };
    const t = setTimeout(() => {
      try { bot.end(); } catch (_) {}
      finish({ ok: false, reason: `таймаут (${stage})` });
    }, ATTEMPT_TIMEOUT);

    try {
      bot = mineflayer.createBot({ ...baseOpts, version });
    } catch (e) {
      return finish({ ok: false, reason: e.message });
    }
    s.pending = bot;

    try {
      bot._client.on('connect', () => { stage = 'TCP підключено'; });
      bot._client.on('state', (st) => { stage = 'стан: ' + st; });
    } catch (_) {}

    bot.once('login', () => finish({ ok: true, bot }));
    bot.on('kicked', (r) => finish({ ok: false, kicked: true, reason: reasonText(r) }));
    bot.on('error', (e) => finish({ ok: false, reason: e && e.message ? e.message : String(e) }));
    bot.on('end', () => finish({ ok: false, reason: `з'єднання закрито (${stage})` }));
  });
}

// налаштування бота після успішного входу
function setupBot(s, bot, say) {
  s.bot = bot;
  s.pending = null;
  let chatCount = 0;
  let registered = false;
  let loggedIn = false;

  say(`✅ ${s.nick} зайшов на ${s.server} (версія ${bot.version || '?'}) і стоїть AFK.`);

  // легкий анти-AFK
  let yaw = 0;
  s.antiAfk = setInterval(() => {
    try {
      yaw += 0.6;
      bot.look(yaw, 0, true);
      bot.swingArm('right');
    } catch (_) {}
  }, 20000);

  bot.on('messagestr', (msg) => {
    const m = String(msg || '').trim();
    if (!m) return;
    const low = m.toLowerCase();
    if (s.password) {
      if (!registered && (low.includes('/register') || low.includes('зареєстр'))) {
        registered = true;
        setTimeout(() => { if (!s.stopped) { try { bot.chat(`/register ${s.password} ${s.password}`); } catch (_) {} } }, 1000);
      } else if (!loggedIn && (low.includes('/login') || low.includes('авториз') || low.includes('увійд'))) {
        loggedIn = true;
        setTimeout(() => { if (!s.stopped) { try { bot.chat(`/login ${s.password}`); } catch (_) {} } }, 1000);
      }
    }
    if (chatCount < 5 || low.includes('/register') || low.includes('/login')) {
      chatCount++;
      say(`💬 Сервер: ${m.slice(0, 250)}`);
    }
  });

  bot.on('resourcePack', () => { try { bot.acceptResourcePack(); } catch (_) {} });
  bot.on('kicked', (r) => { if (!s.stopped) say(`🚫 Бота кікнуло: ${reasonText(r)}`); });
  bot.on('error', (e) => { if (!s.stopped) say(`❌ Помилка: ${e && e.message ? e.message : e}`); });
  bot.on('end', (reason) => {
    if (s.stopped) return;
    cleanup(s);
    say(`🔌 Бот ${s.nick} відключився від ${s.server}.${reason ? ' (' + reason + ')' : ''}`);
  });
}

async function runSession(s) {
  // повідомлення йдуть по черзі, щоб не плутався порядок
  let queue = Promise.resolve();
  const say = (text) => { queue = queue.then(() => send(s.chatId, text)); };

  try {
    const supported = (mineflayer.supportedVersions || []).slice();
    const newest = supported.slice().reverse();

    const target = await resolveTarget(s.host, s.port);
    if (target.srv) say(`ℹ️ Знайдено SRV-запис: ${target.host}:${target.port}`);

    // пінг у фоні — просто для інформації, вхід не чекає на нього
    pingServer(target.host, target.port, newest[0]).then((res) => {
      if (res && res.version) {
        const pl = res.players ? `, гравців ${res.players.online}/${res.players.max}` : '';
        say(`ℹ️ Статус сервера: версія "${reasonText(res.version.name)}", протокол ${res.version.protocol}${pl}`);
      }
    }).catch(() => {});

    // версії для спроб: вказана користувачем -> найновіші підтримувані бібліотекою
    const candidates = [];
    if (s.version !== 'auto') {
      if (supported.includes(s.version)) candidates.push(s.version);
      else say(`ℹ️ Бібліотека не знає версію ${s.version} (максимум ${newest[0] || '?'}), пробую інші.`);
    }
    for (const v of newest) {
      if (candidates.length >= 5) break;
      if (!candidates.includes(v)) candidates.push(v);
    }

    const baseOpts = {
      host: target.host,
      port: target.port,
      username: s.nick,
      auth: 'offline',
      hideErrors: false,
      checkTimeoutInterval: 60000,
      connectTimeout: ATTEMPT_TIMEOUT,
    };

    const failures = [];
    for (const v of candidates) {
      if (s.stopped) return;
      const r = await attempt(s, baseOpts, v);
      if (s.stopped) {
        hardStop(s);
        return;
      }
      if (r.ok) {
        setupBot(s, r.bot, say);
        return;
      }
      failures.push(`${v}: ${r.reason}`);

      // кік не через версію (білий список, бан, сервер офлайн тощо) — далі пробувати марно
      if (r.kicked && !VERSION_HINT.test(r.reason)) {
        cleanup(s);
        say(`🚫 Бота кікнуло: ${r.reason}`);
        return;
      }
      if (/ENOTFOUND|EAI_AGAIN/.test(r.reason)) {
        cleanup(s);
        say(`❌ Не вдалося знайти сервер "${s.host}". Перевір айпі.`);
        return;
      }
      if (/ECONNREFUSED/.test(r.reason)) {
        cleanup(s);
        say(`❌ Сервер відмовив у з'єднанні (${s.host}:${s.port}). Він вимкнений або порт неправильний.`);
        return;
      }
    }

    cleanup(s);
    say('❌ Не вдалося зайти жодною версією:\n' + failures.slice(0, 4).join('\n') +
      '\n\nЯкщо сервер на версії новішій за ' + (newest[0] || '?') +
      ', потрібен ViaBackwards на сервері або оновлення бібліотеки.');
  } catch (e) {
    console.error('runSession error:', e);
    cleanup(s);
    say(`❌ Помилка: ${e && e.message ? e.message : e}`);
  }
}

// ---------------------- команди ----------------------
const argsOf = (ctx) => (ctx.message.text || '').trim().split(/\s+/).slice(1);

tg.start((ctx) => ctx.reply(
  '👋 Привіт! Я AFK-бот для Minecraft. Я заходжу на твій сервер і стою AFK скільки треба.\n\n' +
  '📌 Команди:\n' +
  '/start_afk <айпі> <версія> <час> [нікнейм] [пароль]\n' +
  '   Приклад: /start_afk play.server.net auto 5г MyBot\n' +
  '   Версія: auto (рекомендовано) або конкретна, наприклад 26.1.2\n' +
  '   Нікнейм не обов\'язковий (за замовчуванням AFK_BOT).\n' +
  '   Пароль потрібен, якщо на сервері є /register і /login — бот зареєструється сам.\n' +
  '   Айпі можна з портом: play.server.net:25566\n\n' +
  '/stop_afk — бот виходить з сервера\n' +
  '/status — скільки ще залишилось\n\n' +
  '⏱ Час (максимум 2 роки):\n' +
  'с — секунди (266с)\n' +
  'х — хвилини (30х)\n' +
  'г — години (29г)\n' +
  'д — дні (3д)\n' +
  'т — тижні (2т)\n' +
  'м — місяці (6м)\n' +
  'р — роки (1р)\n\n' +
  '⚠️ Працює тільки на серверах з вимкненим online-mode (піратських).'
));

tg.command('start_afk', async (ctx) => {
  const userId = ctx.from.id;
  const chatId = ctx.chat.id;
  const args = argsOf(ctx);

  if (args.length < 3) {
    return ctx.reply('❌ Використання:\n/start_afk <айпі> <версія> <час> [нікнейм] [пароль]\n' +
      'Приклад: /start_afk play.server.net auto 5г');
  }
  if (sessions.has(userId)) {
    return ctx.reply('⚠️ У тебе вже запущений AFK-бот. Спочатку /stop_afk');
  }
  if (sessions.size >= MAX_SESSIONS) {
    return ctx.reply('⚠️ Зараз забагато активних ботів, спробуй пізніше.');
  }

  const [server, versionRaw, timeStr] = args;
  const nick = args[3] || DEFAULT_NICK;
  const password = args[4] || '';
  const version = versionRaw.toLowerCase();

  if (version !== 'auto' && !/^\d+\.\d+(\.\d+)?$/.test(version)) {
    return ctx.reply('❌ Неправильна версія. Напиши auto або, наприклад, 26.1.2');
  }

  const seconds = parseTime(timeStr);
  if (seconds === null || seconds <= 0) {
    return ctx.reply('❌ Неправильний час. Приклади: 266с, 30х, 29г, 3д, 6м, 1р');
  }
  if (seconds > MAX_SECONDS) return ctx.reply('❌ Максимальний час — 2 роки.');

  if (!/^[A-Za-z0-9_]{3,16}$/.test(nick)) {
    return ctx.reply('❌ Нікнейм: 3-16 символів, тільки латиниця, цифри та _');
  }

  const idx = server.lastIndexOf(':');
  const host = idx > 0 ? server.slice(0, idx) : server;
  const portStr = idx > 0 ? server.slice(idx + 1) : '25565';
  if (!/^\d{1,5}$/.test(portStr) || parseInt(portStr, 10) > 65535 || !host) {
    return ctx.reply('❌ Неправильний айпі або порт.');
  }
  const port = parseInt(portStr, 10);

  const s = {
    userId, chatId, server, host, port, nick, password, version,
    endTime: Date.now() + seconds * 1000,
    stopped: false,
    bot: null,
    pending: null,
    antiAfk: null,
    ticker: null,
  };
  sessions.set(userId, s);

  // таймер: перевіряємо раз на 5 с (setTimeout не вміє чекати довше ~24 днів)
  s.ticker = setInterval(() => {
    if (Date.now() >= s.endTime && !s.stopped) {
      cleanup(s);
      hardStop(s);
      send(chatId, `⏰ Час вийшов, бот ${nick} вийшов з ${server}.`);
    }
  }, 5000);

  await ctx.reply(`⏳ Підключаюсь до ${server} (версія ${version}) як ${nick}\nAFK на ${fmtTime(seconds)}...`);

  // запускаємо у фоні — обробник команди не чекає
  runSession(s);
});

tg.command('stop_afk', (ctx) => {
  if (stopSession(ctx.from.id)) return ctx.reply('👋 Бот вийшов з сервера.');
  return ctx.reply('ℹ️ У тебе немає запущеного AFK-бота.');
});

tg.command('status', (ctx) => {
  const s = sessions.get(ctx.from.id);
  if (!s) return ctx.reply('ℹ️ У тебе немає запущеного AFK-бота.');
  const left = Math.max(0, Math.floor((s.endTime - Date.now()) / 1000));
  const state = s.bot ? '🟢' : '🟡 підключається';
  return ctx.reply(`${state} ${s.nick} на ${s.server}\nЗалишилось: ${fmtTime(left)}`);
});

tg.catch((err, ctx) => {
  console.error('Помилка Telegram-обробника:', err);
  try { ctx.reply('❌ Внутрішня помилка, спробуй ще раз.'); } catch (_) {}
});

// ---------------------- запуск ----------------------
tg.launch({ dropPendingUpdates: true }).catch((e) => {
  console.error('Не вдалося запустити Telegram-бота:', e.message);
  process.exit(1);
});
console.log('Бот запущено');

const shutdown = () => {
  for (const id of [...sessions.keys()]) stopSession(id);
  try { tg.stop(); } catch (_) {}
  setTimeout(() => process.exit(0), 300);
};
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
