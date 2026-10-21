require('dotenv').config();
const { Worker } = require('node:worker_threads');
const path = require('node:path');
const readline = require('node:readline');

const MAX_GUARDS = 5;
const count = clampInt(process.env.BODYGUARD_COUNT || 1, 1, MAX_GUARDS);
const config = {
  host: process.env.MC_HOST || 'localhost',
  port: Number(process.env.MC_PORT || 25565),
  version: process.env.MC_VERSION || undefined,
  auth: process.env.MC_AUTH || 'offline',
  username: process.env.BOT_USERNAME || 'Bodyguard',
  password: process.env.AUTHME_PASSWORD || '',
  followDistance: clampInt(process.env.FOLLOW_DISTANCE || 3, 1, 8)
};

let owner = process.env.OWNER_NAME || null;
let stopping = false;
const workers = new Map();
const knownGuards = new Set();

if (!config.password) {
  console.warn('[bodyguard] AUTHME_PASSWORD is empty; AuthMe login/register will be skipped.');
}

for (let i = 1; i <= count; i += 1) startGuard(i);

function startGuard(id) {
  const worker = new Worker(path.join(__dirname, 'worker.js'), {
    workerData: { id, config }
  });
  workers.set(id, worker);
  worker.on('message', message => onWorkerMessage(id, message));
  worker.on('error', error => console.error(`[guard ${id}] worker error:`, error.message));
  worker.on('exit', code => {
    workers.delete(id);
    if (!stopping && code !== 0) console.error(`[guard ${id}] stopped with code ${code}`);
  });
}

function onWorkerMessage(id, message) {
  if (message.type === 'ready') {
    knownGuards.add(message.username);
    sendTo(id, { type: 'owner', owner });
    return;
  }

  if (message.type === 'chat') {
    handleChat(message.username, message.message);
    return;
  }

  if (message.type === 'defend') {
    broadcast({ type: 'defend', target: message.target });
    return;
  }

  if (message.type === 'log') console.log(`[guard ${id}] ${message.message}`);
}

function handleChat(sender, message) {
  const command = message.trim().split(/\s+/);
  const verb = command[0].toLowerCase();

  if (verb === '!claim') {
    if (!owner) {
      owner = sender;
      broadcast({ type: 'owner', owner });
      broadcast({ type: 'say', message: `Bodyguard detail assigned to ${owner}.` });
      console.log(`[bodyguard] ${owner} claimed the bodyguards.`);
    } else if (sender.toLowerCase() === owner.toLowerCase()) {
      broadcast({ type: 'say', message: 'You already own the bodyguards.' });
    }
    return;
  }

  if (!owner || sender.toLowerCase() !== owner.toLowerCase()) return;

  if (verb === '!guards' || verb === '!bodyguard') {
    const action = (command[1] || 'status').toLowerCase();
    if (action === 'off' || action === 'stop' || action === 'disconnect' || action === 'release') {
      broadcast({ type: 'say', message: 'Bodyguards disconnecting.' });
      shutdown();
    } else if (action === 'status') {
      broadcast({ type: 'say', message: `${workers.size}/${count} bodyguards are connected.` });
    } else if (action === 'follow' || action === 'on') {
      broadcast({ type: 'betray', enabled: false });
      broadcast({ type: 'follow', owner });
      broadcast({ type: 'say', message: 'Bodyguards following.' });
    } else if (action === 'betray') {
      broadcast({ type: 'betray', enabled: true });
      broadcast({ type: 'say', message: 'The bodyguards have turned against their owner.' });
    }
  }
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
  for (const worker of workers.values()) worker.postMessage({ type: 'shutdown' });
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
