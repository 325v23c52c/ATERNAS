// Запуск: node afk.js <host> <port> <nick> <version|auto>
const mineflayer = require('mineflayer');

const [host, port, nick, version] = process.argv.slice(2);
const say = (t) => console.log(t);

const opts = {
  host,
  port: parseInt(port, 10) || 25565,
  username: nick,
  auth: 'offline',
  hideErrors: true,
  checkTimeoutInterval: 60000,
};
// "auto" -> бібліотека сама пінгує сервер і підбирає версію
if (version && version !== 'auto') opts.version = version;

let bot;
try {
  bot = mineflayer.createBot(opts);
} catch (e) {
  say('AFK_ERROR ' + e.message);
  process.exit(1);
}

let antiAfk = null;

bot.once('spawn', () => {
  say('AFK_SPAWN');
  // легкий анти-AFK: повертаємо голову та махаємо рукою
  let yaw = 0;
  antiAfk = setInterval(() => {
    try {
      yaw += 0.6;
      bot.look(yaw, 0, true);
      bot.swingArm('right');
    } catch (_) {}
  }, 20000);
});

// приймаємо ресурспак, якщо сервер його вимагає
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

bot.on('end', () => {
  if (antiAfk) clearInterval(antiAfk);
  say('AFK_END');
  process.exit(0);
});

process.on('SIGTERM', () => {
  try { bot.quit(); } catch (_) {}
  process.exit(0);
});
