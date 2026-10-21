const { parentPort, workerData } = require('node:worker_threads');
const { Worker } = require('node:worker_threads');
const mineflayer = require('mineflayer');
const { pathfinder, Movements, goals } = require('mineflayer-pathfinder');
const { PvP } = require('mineflayer-pvp');

const { id, config } = workerData;
const username = `${config.username}_${id}`;
let owner = null;
let bot;
let movements;
let attackCooldown = 0;
let authAttempted = false;
let reconnectTimer;
let betrayed = false;
let combatTarget = null;
let lastThreatAt = 0;
let fleeing = false;
const signalThread = new Worker(require.resolve('./signal.js'));

signalThread.on('message', message => {
  if (message.type === 'alert') parentPort.postMessage({ type: 'defend', target: message.target });
});

connect();

function connect() {
  authAttempted = false;
  bot = mineflayer.createBot({
    host: config.host,
    port: config.port,
    username,
    auth: config.auth,
    ...(config.version ? { version: config.version } : {})
  });
  bot.loadPlugin(pathfinder);
  bot.loadPlugin(PvP);

  bot.once('spawn', () => {
    movements = new Movements(bot);
    movements.canDig = false;
    bot.pathfinder.setMovements(movements);
    parentPort.postMessage({ type: 'ready', username });
    attemptAuth();
  });

  bot.on('chat', (sender, message) => {
    if (sender !== bot.username) parentPort.postMessage({ type: 'chat', username: sender, message });
  });

  bot.on('messagestr', message => {
    if (/\b(login|log in|register|registr|password)\b/i.test(message)) attemptAuth(message);
  });

  bot.on('entityHurt', entity => {
    if (!entity || !bot.entity || !isProtected(entity)) return;
    const attacker = nearestAttacker(entity);
    if (attacker) {
      signalThread.postMessage({ type: 'hit', target: serializeTarget(attacker) });
      fight(attacker);
    }
  });

  // A nearby entity swinging at a protected player is an earlier signal than damage.
  bot.on('entitySwingArm', entity => {
    if (entity && isProtected(entity) === false && isNearProtected(entity, 4)) {
      const protectedEntity = nearestProtected(entity);
      if (protectedEntity && entity.type !== 'object') {
        signalThread.postMessage({ type: 'hit', target: serializeTarget(entity) });
        fight(entity);
      }
    }
  });

  bot.on('physicsTick', () => {
    if (attackCooldown > 0) attackCooldown -= 1;
    maintainCombat();
    if (!combatTarget) followOwner();
  });

  bot.on('kicked', reason => parentPort.postMessage({ type: 'log', message: `kicked: ${reason}` }));
  bot.on('error', error => parentPort.postMessage({ type: 'log', message: error.message }));
  bot.on('end', () => {
    if (!reconnectTimer) {
      parentPort.postMessage({ type: 'log', message: 'connection ended; reconnecting in 5s' });
      reconnectTimer = setTimeout(() => {
        reconnectTimer = undefined;
        connect();
      }, 5000);
    }
  });
}

function attemptAuth(message = '') {
  if (!config.password || authAttempted || !bot || !bot.chat) return;
  if (!message || /\b(register|registr|login|log in|password)\b/i.test(message)) {
    authAttempted = true;
    setTimeout(() => bot.chat(`/register ${config.password} ${config.password}`), 700);
    setTimeout(() => bot.chat(`/login ${config.password}`), 1400);
  }
}

function followOwner() {
  if (!owner || !bot.entity || !movements) return;
  const target = findPlayer(owner);
  if (!target) return;
  if (betrayed) {
    fight(target);
    return;
  }
  const distance = bot.entity.position.distanceTo(target.position);
  if (distance > config.followDistance + 1) {
    bot.pathfinder.setGoal(new goals.GoalNear(target.position.x, target.position.y, target.position.z, config.followDistance));
  } else if (bot.pathfinder.goal && distance <= config.followDistance) {
    bot.pathfinder.setGoal(null);
  }
}

function fight(entity, refreshThreat = true) {
  if (!entity || !bot.pvp || attackCooldown > 0) return;
  combatTarget = entity;
  if (refreshThreat) lastThreatAt = Date.now();
  fleeing = false;
  attackCooldown = 10;
  bot.pvp.attack(entity);
}

function maintainCombat() {
  if (!combatTarget) return;
  if (!bot.entity || bot.health <= 6) {
    fleeFrom(combatTarget);
    return;
  }
  if (!bot.entities[combatTarget.id] || combatTarget.health === 0 || Date.now() - lastThreatAt > 4000) {
    combatTarget = null;
    fleeing = false;
    bot.pvp.stop();
    return;
  }
  if (!fleeing) fight(combatTarget, false);
}

function fleeFrom(threat) {
  if (!bot.entity || !threat?.position || !movements) return;
  if (bot.pvp) bot.pvp.stop();
  if (fleeing) return;
  fleeing = true;
  const direction = bot.entity.position.minus(threat.position);
  const length = Math.max(direction.norm(), 0.01);
  const destination = bot.entity.position.plus(direction.scaled(12 / length));
  bot.pathfinder.setGoal(new goals.GoalNear(destination.x, destination.y, destination.z, 2));
}

function isProtected(entity) {
  return entity === bot.entity || Boolean(entity.username && (entity.username.toLowerCase() === String(owner || '').toLowerCase() || entity.username.toLowerCase().startsWith(`${config.username.toLowerCase()}_`)));
}

function isNearProtected(entity, distance) {
  return nearestProtected(entity, distance) !== null;
}

function nearestProtected(entity, distance = 6) {
  const protectedEntities = Object.values(bot.entities).filter(candidate => isProtected(candidate));
  return protectedEntities
    .filter(candidate => candidate.position && entity.position.distanceTo(candidate.position) <= distance)
    .sort((a, b) => entity.position.distanceTo(a.position) - entity.position.distanceTo(b.position))[0] || null;
}

function nearestAttacker(hurtEntity) {
  return Object.values(bot.entities)
    .filter(entity => entity !== bot.entity && !isProtected(entity) && entity.position && hurtEntity.position.distanceTo(entity.position) <= 5)
    .sort((a, b) => hurtEntity.position.distanceTo(a.position) - hurtEntity.position.distanceTo(b.position))[0] || null;
}

function findPlayer(name) {
  const wanted = name.toLowerCase();
  return Object.values(bot.players).find(player => player.username && player.username.toLowerCase() === wanted)?.entity;
}

function serializeTarget(entity) {
  return { id: entity.id, username: entity.username || null };
}

parentPort.on('message', message => {
  if (message.type === 'owner') owner = message.owner;
  if (message.type === 'follow') owner = message.owner;
  if (message.type === 'betray') betrayed = message.enabled;
  if (message.type === 'defend') {
    const target = Object.values(bot.entities).find(entity => entity.id === message.target.id || (message.target.username && entity.username === message.target.username));
    if (target) fight(target);
  }
  if (message.type === 'say' && bot?.chat) bot.chat(message.message);
  if (message.type === 'shutdown') {
    signalThread.postMessage({ type: 'shutdown' });
    clearTimeout(reconnectTimer);
    reconnectTimer = undefined;
    if (bot) bot.quit('Bodyguard dismissed');
    setTimeout(() => process.exit(0), 1000).unref();
  }
});
