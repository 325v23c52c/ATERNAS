// Запуск: node afk.js <host> <port> <nick> <version|auto> [password]
const mineflayer = require('mineflayer');

const [host, port, nick, version, password] = process.argv.slice(2);
const say = (t) => console.log(t);

process.on('uncaughtException', (e) => {
  say('AFK_ERROR ' + (e && e.message ? e.message : String(e)));
  process.exit(1);
});
process.on('unhandledRejection', (e) => {
  say('AFK_ERROR ' + (e && e.message ? e.message : String(e)));
  process.exit(1);
});

const opts = {
  host,
  port: parseInt(port, 10) || 25565,
  username: nick,
  auth: 'offline',
  hideErrors: false,
  checkTimeoutInterval: 60000,
};
if (version && version !== 'auto') opts.version = version;

let bot;
try {
  bot = mineflayer.createBot(opts);
} catch (e) {
  say('AFK_ERROR ' + e.message);
  process.exit(1);
}

let joined = false;
let antiAfk = null;
let chatCount = 0;
let registered = false;
let loggedIn = false;

// якщо за 30 секунд сервер не пустив — повідомляємо
const connectTimer = setTimeout(() => {
  if (!joined) {
    say('AFK_ERROR Сервер не відповів за 30с (перевір айпі/порт, чи онлайн сервер, чи вимкнений online-mode)');
    process.exit(1);
  }
}, 30000);

// гравець зайшов на сервер
bot.once('login', () => {
  joined = true;
  clearTimeout(connectTimer);
  say('AFK_JOINED ' + (bot.version || '?'));
});

bot.once('spawn', () => {
  say('AFK_SPAWN');
  let yaw = 0;
  antiAfk = setInterval(() => {
    try {
      yaw += 0.6;
      bot.look(yaw, 0, true);
      bot.swingArm('right');
    } catch (_) {}
  }, 20000);
});

// повідомлення сервера в чаті (щоб бачити /register, /login тощо)
bot.on('messagestr', (msg) => {
  const m = String(msg || '').trim();
  if (!m) return;
  const low = m.toLowerCase();

  if (password) {
    if (!registered && (low.includes('/register') || low.includes('зареєстр'))) {
      registered = true;
      setTimeout(() => bot.chat(`/register ${password} ${password}`), 1000);
    } else if (!loggedIn && (low.includes('/login') || low.includes('авториз') || low.includes('увійд'))) {
      loggedIn = true;
      setTimeout(() => bot.chat(`/login ${password}`), 1000);
    }
  }

  if (chatCount < 5 || low.includes('/register') || low.includes('/login')) {
    chatCount++;
    say('AFK_CHAT ' + m.slice(0, 200));
  }
});

bot.on('resourcePack', () => {
  try { bot.acceptResourcePack(); } catch (_) {}
});

bot.on('kicked', (reason) => {
  let text = reason;
  try {
    const parsed = typeof reason === 'string' ? JSON.parse(reason) : reason;
    text = JSON.stringify(parsed);
  } catch (_) {}
  say('AFK_KICKED ' + String(text).slice(0, 250));
});

bot.on('error', (err) => {
  say('AFK_ERROR ' + (err && err.message ? err.message : String(err)));
});

bot.on('end', (reason) => {
  if (antiAfk) clearInterval(antiAfk);
  say('AFK_END ' + (reason || ''));
  setTimeout(() => process.exit(0), 200);
});

process.on('SIGTERM', () => {
  try { bot.quit(); } catch (_) {}
  process.exit(0);
});
