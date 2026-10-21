require('dotenv').config();
const { Worker } = require('node:worker_threads');
const path = require('node:path');
const readline = require('node:readline');
const mineflayer = require('mineflayer');

const MAX_GUARDS = 5;
const count = clampInt(process.env.BODYGUARD_COUNT || 1, 1, MAX_GUARDS);
const config = {
  host: process.env.MC_HOST || 'localhost',
  port: Number(process.env.MC_PORT || 25565),
  version: process.env.MC_VERSION || undefined,
  auth: process.env.MC_AUTH || 'offline',
  username: process.env.BOT_USERNAME || 'Bodyguard',
  password: process.env.AUTHME_PASSWORD || '',
  registerCommand: process.env.AUTHME_REGISTER_COMMAND || '/register',
  loginCommand: process.env.AUTHME_LOGIN_COMMAND || '/login',
  followDistance: clampInt(process.env.FOLLOW_DISTANCE || 3, 1, 8)
};

let owner = process.env.OWNER_NAME || 'tails1154';
let stopping = false;
let guardsStarted = false;
let masterAuthAttempted = false;
let masterAuthTimer;
let masterAuthComplete = false;
const workers = new Map();
const log = message => console.log(`[${new Date().toISOString()}] [master] ${message}`);
const master = mineflayer.createBot({
  host: config.host,
  port: config.port,
  username: `${config.username}_master`,
  auth: config.auth,
  ...(config.version ? { version: config.version } : {})
});

log(`starting controller as ${config.username}_master for ${config.host}:${config.port}; clones=${count}`);
if (!config.password) log('AUTHME_PASSWORD is empty; AuthMe login/register will be skipped.');

master.on('spawn', () => {
  log('controller spawned');
  attemptMasterAuth();
});
master.on('chat', (sender, message) => {
  if (sender !== master.username) {
    log(`chat from ${sender}: ${message}`);
    handleChat(sender, message);
  }
});
master.on('messagestr', message => {
  if (isAuthMessage(message)) {
    log(`AuthMe response: ${message}`);
    if (isAuthSuccess(message)) {
      masterAuthComplete = true;
      clearTimeout(masterAuthTimer);
      masterAuthTimer = undefined;
      log('controller authentication appears successful');
    } else {
      attemptMasterAuth(message);
    }
  }
});
master.on('error', error => log(`error: ${error.message}`));
master.on('kicked', reason => log(`kicked: ${reason}`));
master.on('end', () => {
  if (!stopping) log('connection ended');
});

function attemptMasterAuth(message = '') {
  if (!config.password || masterAuthComplete || masterAuthTimer || !master.chat) return;
  if (message && !isAuthMessage(message)) return;
  masterAuthAttempted = true;
  log('sending AuthMe register command, then login command');
  master.chat(`${config.registerCommand} ${config.password} ${config.password}`);
  setTimeout(() => {
    if (!stopping && !masterAuthComplete && master.chat) {
      log('sending AuthMe login command');
      master.chat(`${config.loginCommand} ${config.password}`);
    }
  }, 2200);
  masterAuthTimer = setTimeout(() => {
    masterAuthTimer = undefined;
    if (!masterAuthComplete && masterAuthAttempted) attemptMasterAuth();
  }, 7000);
}

function isAuthMessage(message) {
  return /\b(login|log in|register|registr|password|authenticate|unauthenticated)\b/i.test(message);
}

function isAuthSuccess(message) {
  return /success|successful|logged[ -]?in|already logged|registration complete|registered successfully/i.test(message) && !/not logged|failed|invalid|wrong|error/i.test(message);
}

function startGuards() {
  if (guardsStarted) return false;
  guardsStarted = true;
  log(`deploying ${count} clone workers`);
  for (let i = 1; i <= count; i += 1) startGuard(i);
  return true;
}

function startGuard(id) {
  const worker = new Worker(path.join(__dirname, 'worker.js'), {
    workerData: { id, config }
  });
  workers.set(id, worker);
  worker.on('message', message => onWorkerMessage(id, message));
  worker.on('error', error => console.error(`[guard ${id}] worker error:`, error.message));
  worker.on('exit', code => {
    workers.delete(id);
    log(`guard ${id} exited with code ${code}`);
    if (!stopping && code !== 0) log(`guard ${id} exited unexpectedly`);
  });
}

function onWorkerMessage(id, message) {
  if (message.type === 'ready') {
    log(`guard ${id} ready as ${message.username}`);
    sendTo(id, { type: 'owner', owner });
    return;
  }

  if (message.type === 'chat') {
    handleChat(message.username, message.message);
    return;
  }

  if (message.type === 'defend') {
    log(`guard ${id} reported a threat: ${message.target.username || `entity ${message.target.id}`}`);
    broadcast({ type: 'defend', target: message.target });
    return;
  }

  if (message.type === 'log') log(`[guard ${id}] ${message.message}`);
}

function handleChat(sender, message) {
  const command = message.trim().split(/\s+/);
  const verb = command[0].toLowerCase();

  if (verb === '!help') {
    say('Commands: !claim, !clones, !guards status, !guards follow, !guards off, !guards betray');
    return;
  }

  if (verb === '!claim') {
    if (!owner) {
      owner = sender;
      log(`${owner} claimed the bodyguards`);
      say(`Bodyguard detail assigned to ${owner}. Send !clones to deploy it.`);
      console.log(`[bodyguard] ${owner} claimed the bodyguards.`);
    } else if (sender.toLowerCase() === owner.toLowerCase()) {
      say('You already own the bodyguards.');
    }
    return;
  }

  if (!owner || sender.toLowerCase() !== owner.toLowerCase()) return;

  if (verb === '!clones') {
    log(`${sender} requested clone deployment`);
    if (startGuards()) {
      broadcast({ type: 'owner', owner });
      say(`Deploying ${count} bodyguards.`);
    } else {
      say('The bodyguards are already deployed.');
    }
    return;
  }

  if (verb === '!guards' || verb === '!bodyguard') {
    const action = (command[1] || 'status').toLowerCase();
    if (action === 'off' || action === 'stop' || action === 'disconnect' || action === 'release') {
      say('Bodyguards disconnecting.');
      shutdown();
    } else if (action === 'status') {
      say(`${workers.size}/${count} bodyguards are connected.`);
    } else if (action === 'follow' || action === 'on') {
      broadcast({ type: 'betray', enabled: false });
      broadcast({ type: 'follow', owner });
      say('Bodyguards following.');
    } else if (action === 'betray') {
      broadcast({ type: 'betray', enabled: true });
      say('The bodyguards have turned against their owner.');
    }
  }
}

function say(message) {
  log(`say: ${message}`);
  if (master.chat) master.chat(message);
}

function sendTo(id, message) {
  const worker = workers.get(id);
  if (worker) worker.postMessage(message);
}

function broadcast(message) {
  for (const worker of workers.values()) worker.postMessage(message);
}

function shutdown() {
  if (stopping) return;
  stopping = true;
  log('shutting down controller and clone workers');
  for (const worker of workers.values()) worker.postMessage({ type: 'shutdown' });
  if (master) master.quit('Bodyguard dismissed');
  setTimeout(() => process.exit(0), 5000).unref();
}

process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);

// This also makes it possible to stop the group from the terminal without chat.
if (process.stdin.isTTY) {
  const input = readline.createInterface({ input: process.stdin, output: process.stdout });
  input.on('line', line => {
    if (line.trim().toLowerCase() === 'stop') shutdown();
  });
}

function clampInt(value, min, max) {
  const number = Number.parseInt(value, 10);
  return Number.isFinite(number) ? Math.min(max, Math.max(min, number)) : min;
}
