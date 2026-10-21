require('dotenv').config();
const { Worker } = require('node:worker_threads');
const path = require('node:path');
const readline = require('node:readline');
const mineflayer = require('mineflayer');
const { pathfinder, Movements, goals } = require('mineflayer-pathfinder');
const { plugin: PvP } = require('mineflayer-pvp');

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
let masterMovements;
let masterFollowTimer;
let masterCombatTarget;
let masterLastThreatAt = 0;
let masterFleeing = false;
let masterBetrayed = false;
let masterReadyAnnounced = false;
let masterEating = false;
const workers = new Map();
const log = message => console.log(`[${new Date().toISOString()}] [master] ${message}`);
const master = mineflayer.createBot({
  host: config.host,
  port: config.port,
  username: `${config.username}_master`,
  auth: config.auth,
  ...(config.version ? { version: config.version } : {})
});
master.loadPlugin(pathfinder);
master.loadPlugin(PvP);

log(`starting controller as ${config.username}_master for ${config.host}:${config.port}; clones=${count}`);
if (!config.password) log('AUTHME_PASSWORD is empty; AuthMe login/register will be skipped.');

master.on('spawn', () => {
  log('controller spawned');
  masterMovements = new Movements(master);
  masterMovements.canDig = false;
  master.pathfinder.setMovements(masterMovements);
  clearInterval(masterFollowTimer);
  masterFollowTimer = setInterval(masterMaintain, 1000);
  attemptMasterAuth();
  masterAnnounceReady();
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
      masterAnnounceReady();
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
master.on('entityHurt', entity => {
  if (!entity || !master.entity || !masterIsProtected(entity)) return;
  const attacker = masterNearestAttacker(entity);
  if (attacker) masterFight(attacker);
});
master.on('entitySwingArm', entity => {
  if (!entity?.username || entity.username.toLowerCase() !== String(owner || '').toLowerCase()) return;
  const target = masterNearestAttacker(entity);
  if (target) masterFight(target);
});
master.on('playerCollect', (collector, collected) => {
  if (!master.entity || collector.id !== master.entity.id || typeof collected.getDroppedItem !== 'function') return;
  let item;
  try {
    item = collected.getDroppedItem();
  } catch (error) {
    log(`master collected an item but could not read it: ${error.message}`);
    return;
  }
  const destination = equipmentDestination(item?.name);
  if (!item || !destination) return;
  master.chat('Thanks!');
  log(`master picked up ${item.count} ${item.displayName || item.name}; equipping to ${destination}`);
  setTimeout(() => masterEquipCollectedItem(item.name, destination), 250);
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

function masterAnnounceReady() {
  if (!master.entity || !owner || masterReadyAnnounced || !master.chat) return;
  masterReadyAnnounced = true;
  master.chat(`Bodyguard for ${owner}. Ready for commands.`);
  log(`master announced readiness for ${owner}`);
}

function masterMaintain() {
  if (!master.entity || !masterMovements || !owner) return;
  masterEatIfHungry();
  if (masterCombatTarget) {
    if (master.health <= 6) {
      masterFlee(masterCombatTarget);
      return;
    }
    if (!master.entities[masterCombatTarget.id] || masterCombatTarget.health === 0 || Date.now() - masterLastThreatAt > 4000) {
      log(`master combat ended with ${masterTargetLabel(masterCombatTarget)}`);
      masterCombatTarget = null;
      masterFleeing = false;
      master.pvp.stop();
    } else if (!masterFleeing) {
      master.pvp.attack(masterCombatTarget);
    }
    if (masterCombatTarget) return;
  }
  const target = masterFindPlayer(owner);
  if (!target) return;
  if (masterBetrayed) {
    masterFight(target);
    return;
  }
  const distance = master.entity.position.distanceTo(target.position);
  if (distance > config.followDistance + 1) {
    master.pathfinder.setGoal(new goals.GoalNear(target.position.x, target.position.y, target.position.z, config.followDistance));
    master.setControlState('sprint', true);
    master.setControlState('jump', true);
  } else if (master.pathfinder.goal) {
    master.pathfinder.setGoal(null);
    master.setControlState('sprint', false);
    master.setControlState('jump', false);
  }
}

function masterFight(target) {
  if (!target || !master.pvp) return;
  masterCombatTarget = target;
  masterLastThreatAt = Date.now();
  masterFleeing = false;
  log(`master attacking ${masterTargetLabel(target)}`);
  master.setControlState('sprint', true);
  master.setControlState('jump', true);
  master.pvp.attack(target);
}

function masterEatIfHungry() {
  if (masterEating || !master.inventory || master.food == null || master.food > 14) return;
  const food = master.inventory.items().find(item => master.registry.items[item.type]?.foodPoints > 0);
  if (!food) return;
  masterEating = true;
  master.equip(food, 'hand')
    .then(() => master.consume())
    .then(() => log(`master ate ${food.displayName || food.name} automatically`))
    .catch(error => log(`master could not auto-eat ${food.name}: ${error.message}`))
    .finally(() => { masterEating = false; });
}

function masterFlee(threat) {
  if (masterFleeing || !threat?.position) return;
  masterFleeing = true;
  master.pvp.stop();
  const direction = master.entity.position.minus(threat.position);
  const length = Math.max(direction.norm(), 0.01);
  const destination = master.entity.position.plus(direction.scaled(12 / length));
  log(`master fleeing from ${masterTargetLabel(threat)} at ${master.health} health`);
  master.pathfinder.setGoal(new goals.GoalNear(destination.x, destination.y, destination.z, 2));
}

function masterFindPlayer(name) {
  const wanted = name.toLowerCase();
  const player = master.players[name] || Object.values(master.players).find(candidate => candidate.username?.toLowerCase() === wanted);
  return player?.entity || Object.values(master.entities).find(entity => entity.username?.toLowerCase() === wanted) || null;
}

function masterIsProtected(entity) {
  return entity === master.entity || Boolean(entity.username && (entity.username.toLowerCase() === String(owner || '').toLowerCase() || entity.username.toLowerCase().startsWith(`${config.username.toLowerCase()}_`)));
}

function masterNearestAttacker(hurtEntity) {
  return Object.values(master.entities)
    .filter(entity => entity !== master.entity && !masterIsProtected(entity) && entity.position && hurtEntity.position.distanceTo(entity.position) <= 5)
    .sort((a, b) => hurtEntity.position.distanceTo(a.position) - hurtEntity.position.distanceTo(b.position))[0] || null;
}

function masterTargetLabel(entity) {
  return entity?.username || `entity ${entity?.id ?? 'unknown'}`;
}

function equipmentDestination(itemName = '') {
  if (/(helmet|turtle_shell|turtle_helmet)$/.test(itemName)) return 'head';
  if (/(chestplate|elytra)$/.test(itemName)) return 'torso';
  if (/leggings$/.test(itemName)) return 'legs';
  if (/(boots|horse_armor)$/.test(itemName)) return 'feet';
  if (/(sword|axe|trident|bow|crossbow|mace)$/.test(itemName)) return 'hand';
  return null;
}

async function masterEquipCollectedItem(itemName, destination) {
  const item = master.inventory?.items().find(candidate => candidate.name === itemName);
  if (!item) {
    log(`master could not find collected ${itemName} in inventory`);
    return;
  }
  try {
    await master.equip(item, destination);
    log(`master equipped ${itemName} in ${destination}`);
  } catch (error) {
    log(`master could not equip ${itemName}: ${error.message}`);
  }
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
    say('Commands: !claim, !clones, !attack <player>, !guards status, !guards follow, !guards off, !disconnect, !guards betray');
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

  if (verb === '!attack' && command[1]) {
    const targetName = command[1];
    const target = masterFindPlayer(targetName);
    if (targetName.toLowerCase() !== owner.toLowerCase() && (!target || !masterIsProtected(target))) {
      if (target) masterFight(target);
      broadcast({ type: 'attack', target: targetName });
      say(`Attacking ${targetName}.`);
    } else {
      say(`${targetName} is not visible or is protected.`);
    }
    return;
  }

  if (verb === '!disconnect') {
    say('Bodyguards disconnecting.');
    shutdown();
    return;
  }

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
      say(`${workers.size + 1}/${count + 1} bodyguards are connected (including master).`);
    } else if (action === 'follow' || action === 'on') {
      masterBetrayed = false;
      broadcast({ type: 'betray', enabled: false });
      broadcast({ type: 'follow', owner });
      say('Bodyguards following.');
    } else if (action === 'betray') {
      masterBetrayed = true;
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
  clearInterval(masterFollowTimer);
  master.setControlState('sprint', false);
  master.setControlState('jump', false);
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
