// Запуск: node afk.js <host> <port> <nick> <version|auto> [password]
const dns = require('dns');
const net = require('net');
const mineflayer = require('mineflayer');

// Railway інколи віддає IPv6, на який сервер не слухає -> примусово IPv4 спочатку
try { dns.setDefaultResultOrder('ipv4first'); } catch (_) {}

const [argHost, argPort, nick, argVersion, password] = process.argv.slice(2);
const say = (t) => console.log(t);

process.on('uncaughtException', (e) => {
  say('AFK_ERROR ' + (e && e.message ? e.message : String(e)));
  process.exit(1);
});
process.on('unhandledRejection', (e) => {
  say('AFK_ERROR ' + (e && e.message ? e.message : String(e)));
  process.exit(1);
});

const withTimeout = (p, ms, msg) =>
  Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(msg)), ms))]);

// SRV-запис: play.server.net -> реальний хост:порт (так працює справжній клієнт Minecraft)
async function resolveTarget(host, port) {
  if (port === 25565 && net.isIP(host) === 0 && host !== 'localhost') {
    try {
      const r = await withTimeout(dns.promises.resolveSrv('_minecraft._tcp.' + host), 5000, 'srv timeout');
      if (r && r.length) {
        say(`AFK_INFO Знайдено SRV-запис: ${r[0].name}:${r[0].port}`);
        return { host: r[0].name, port: r[0].port };
      }
    } catch (_) {}
  }
  return { host, port };
}

// пінг сервера: показує, чи сервер взагалі відповідає і яка в нього версія
async function pingServer(host, port) {
  let mc;
  try { mc = require('minecraft-protocol'); } catch (_) { return null; }
  return withTimeout(
    new Promise((resolve, reject) => {
      mc.ping({ host, port }, (err, res) => (err ? reject(err) : resolve(res)));
    }),
    12000,
    'пінг не відповів за 12с'
  );
}

(async () => {
  const supported = mineflayer.supportedVersions || [];
  const target = await resolveTarget(argHost, parseInt(argPort, 10) || 25565);

  let serverVersion = null;
  try {
    const res = await pingServer(target.host, target.port);
    if (res && res.version) {
      serverVersion = res.version.name;
      const pl = res.players ? ` | гравців: ${res.players.online}/${res.players.max}` : '';
      say(`AFK_INFO Сервер відповідає: версія "${serverVersion}", протокол ${res.version.protocol}${pl}`);
    }
  } catch (e) {
    say('AFK_ERROR Сервер не відповів на пінг (' + (e.code || e.message) + '). Перевір айпі/порт, чи сервер увімкнений і чи не блокує він підключення з Railway.');
    process.exit(1);
  }

  // вибір версії
  const opts = {
    host: target.host,
    port: target.port,
    username: nick,
    auth: 'offline',
    hideErrors: false,
    checkTimeoutInterval: 60000,
    connectTimeout: 30000,
  };

  const found = serverVersion ? serverVersion.match(/\d+\.\d+(?:\.\d+)?/g) : null;
  let chosen = null;
  if (found && found.length === 1 && supported.includes(found[0])) chosen = found[0];
  else if (argVersion && argVersion !== 'auto' && supported.includes(argVersion)) chosen = argVersion;

  if (chosen) {
    opts.version = chosen;
    if (argVersion !== 'auto' && argVersion !== chosen) {
      say(`AFK_INFO Ти вказав ${argVersion}, але сервер на ${chosen} — використовую ${chosen}`);
    }
  } else if (found && found.length === 1 && !supported.includes(found[0])) {
    const newest = supported[supported.length - 1];
    say(`AFK_INFO Бібліотека ще не підтримує ${found[0]} (максимум ${newest}). Пробую підключитись через ${newest}...`);
    opts.version = newest;
  }
  // інакше версія визначається автоматично

  let bot;
  try {
    bot = mineflayer.createBot(opts);
  } catch (e) {
    say('AFK_ERROR ' + e.message);
    process.exit(1);
  }

  let joined = false;
  let stage = 'підключення';
  let antiAfk = null;
  let chatCount = 0;
  let registered = false;
  let loggedIn = false;

  try {
    bot._client.on('connect', () => { stage = 'TCP підключено'; });
    bot._client.on('state', (s) => { stage = 'стан: ' + s; });
  } catch (_) {}

  const connectTimer = setTimeout(() => {
    if (!joined) {
      say('AFK_ERROR Сервер не пустив бота за 40с. Останній етап: ' + stage +
        '. Можливі причини: потрібна авторизація (/register), неправильна версія, захист сервера від ботів.');
      process.exit(1);
    }
  }, 40000);

  bot.once('login', () => {
    joined = true;
    clearTimeout(connectTimer);
    say('AFK_JOINED ' + (bot.version || '?'));
  });

  bot.once('spawn', () => {
    say('AFK_SPAWN');
    let yaw = 0;
    antiAfk = setInterval(() => {
      try { yaw += 0.6; bot.look(yaw, 0, true); bot.swingArm('right'); } catch (_) {}
    }, 20000);
  });

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

  bot.on('resourcePack', () => { try { bot.acceptResourcePack(); } catch (_) {} });

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
})();
