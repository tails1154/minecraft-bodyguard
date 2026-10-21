const { parentPort, workerData } = require('node:worker_threads');
const { Worker } = require('node:worker_threads');
const mineflayer = require('mineflayer');
const { pathfinder, Movements, goals } = require('mineflayer-pathfinder');
const { plugin: PvP } = require('mineflayer-pvp');

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
let lastFollowTarget = null;
let spawned = false;
let announcedReady = false;
let authTimer;
let authComplete = false;
let followTimer;
let lastFollowDiagnostic = 0;
let followingGoal = false;
let eating = false;
const signalThread = new Worker(require.resolve('./signal.js'));

signalThread.on('message', message => {
  if (message.type === 'alert') parentPort.postMessage({ type: 'defend', target: message.target });
});

connect();

function connect() {
  authAttempted = false;
  authComplete = false;
  clearTimeout(authTimer);
  authTimer = undefined;
  clearInterval(followTimer);
  followTimer = undefined;
  spawned = false;
  announcedReady = false;
  log(`connecting as ${username} to ${config.host}:${config.port}`);
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
    spawned = true;
    log(`spawned in ${bot.game?.dimension || 'unknown dimension'}`);
    movements = new Movements(bot);
    movements.canDig = false;
    bot.pathfinder.setMovements(movements);
    followTimer = setInterval(followOwner, 1000);
    parentPort.postMessage({ type: 'ready', username });
    attemptAuth();
    announceReady();
  });

  bot.on('chat', (sender, message) => {
    if (sender !== bot.username) {
      log(`chat from ${sender}: ${message}`);
      parentPort.postMessage({ type: 'chat', username: sender, message });
    }
  });

  bot.on('messagestr', message => {
    if (isAuthMessage(message)) {
      log(`AuthMe response: ${message}`);
      if (isAuthSuccess(message)) {
        authComplete = true;
        clearTimeout(authTimer);
        authTimer = undefined;
        log('authentication appears successful');
      } else {
        attemptAuth(message);
      }
    }
  });

  bot.on('playerCollect', (collector, collected) => {
    if (!bot.entity || collector.id !== bot.entity.id || typeof collected.getDroppedItem !== 'function') return;
    let item;
    try {
      item = collected.getDroppedItem();
    } catch (error) {
      log(`collected an item but could not read it: ${error.message}`);
      return;
    }
    if (!item) {
      log('collected an item but Mineflayer returned no item data');
      return;
    }
    const destination = equipmentDestination(item?.name);
    if (!destination) {
      log(`picked up ${item.count} ${item.displayName || item.name}; not armor or a supported weapon`);
      return;
    }
    bot.chat('Thanks!');
    log(`picked up ${item.count} ${item.displayName}; equipping to ${destination}`);
    setTimeout(() => equipCollectedItem(item.name, destination), 250);
  });

  bot.on('entityHurt', entity => {
    if (!entity || !bot.entity || !isProtected(entity)) return;
    const attacker = nearestAttacker(entity);
    if (attacker) {
      log(`protected entity was hurt; signaling ${targetLabel(attacker)}`);
      signalThread.postMessage({ type: 'hit', target: serializeTarget(attacker) });
      fight(attacker);
    }
  });

  // A nearby entity swinging at a protected player is an earlier signal than damage.
  bot.on('entitySwingArm', entity => {
    if (entity?.username && entity.username.toLowerCase() === String(owner || '').toLowerCase()) {
      const target = nearestAttacker(entity);
      if (target) {
        signalThread.postMessage({ type: 'hit', target: serializeTarget(target) });
        fight(target);
      }
      return;
    }
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
    eatIfHungry();
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
  if (!config.password || authComplete || authTimer || !bot?.chat) return;
  if (message && !isAuthMessage(message)) return;
  authAttempted = true;
  log('sending AuthMe register command, then login command');
  bot.chat(`${config.registerCommand} ${config.password} ${config.password}`);
  setTimeout(() => {
    if (!authComplete && bot?.chat) {
      log('sending AuthMe login command');
      bot.chat(`${config.loginCommand} ${config.password}`);
    }
  }, 2200);
  authTimer = setTimeout(() => {
    authTimer = undefined;
    if (!authComplete && authAttempted) attemptAuth();
  }, 7000);
}

function isAuthMessage(message) {
  return /\b(login|log in|register|registr|password|authenticate|unauthenticated)\b/i.test(message);
}

function isAuthSuccess(message) {
  return /success|successful|logged[ -]?in|already logged|registration complete|registered successfully/i.test(message) && !/not logged|failed|invalid|wrong|error/i.test(message);
}

function announceReady() {
  if (!spawned || !owner || announcedReady || !bot?.chat) return;
  announcedReady = true;
  bot.chat(`Bodyguard for ${owner}. Ready for commands.`);
  log(`announced readiness for ${owner}`);
}

function eatIfHungry() {
  if (eating || !bot?.inventory || bot.food == null || bot.food > 14) return;
  const food = bot.inventory.items().find(item => {
    const definition = bot.registry.items[item.type];
    return definition?.foodPoints > 0;
  });
  if (!food) return;
  eating = true;
  bot.equip(food, 'hand')
    .then(() => bot.consume())
    .then(() => log(`ate ${food.displayName || food.name} automatically`))
    .catch(error => log(`could not auto-eat ${food.name}: ${error.message}`))
    .finally(() => { eating = false; });
}

function equipmentDestination(itemName = '') {
  if (/(helmet|turtle_shell|turtle_helmet)$/.test(itemName)) return 'head';
  if (/(chestplate|elytra)$/.test(itemName)) return 'torso';
  if (/leggings$/.test(itemName)) return 'legs';
  if (/(boots|horse_armor)$/.test(itemName)) return 'feet';
  if (/(sword|axe|trident|bow|crossbow|mace)$/.test(itemName)) return 'hand';
  return null;
}

async function equipCollectedItem(itemName, destination) {
  if (!bot?.inventory) return;
  const item = bot.inventory.items().find(candidate => candidate.name === itemName);
  if (!item) {
    log(`could not find collected ${itemName} in inventory`);
    return;
  }
  try {
    await bot.equip(item, destination);
    log(`equipped ${itemName} in ${destination}`);
  } catch (error) {
    log(`could not equip ${itemName}: ${error.message}`);
  }
}

function followOwner() {
  if (!owner || !bot.entity || !movements) return;
  const target = findPlayer(owner);
  if (!target) {
    if (lastFollowTarget) log(`owner ${owner} is no longer visible`);
    lastFollowTarget = null;
    if (Date.now() - lastFollowDiagnostic > 5000) {
      lastFollowDiagnostic = Date.now();
      log(`owner ${owner} is not currently visible; waiting for an entity`);
    }
    return;
  }
  if (lastFollowTarget !== target.id) {
    lastFollowTarget = target.id;
    log(`following owner ${owner}`);
  }
  if (betrayed) {
    fight(target);
    return;
  }
  const distance = bot.entity.position.distanceTo(target.position);
  if (distance > config.followDistance + 1) {
    bot.pathfinder.setGoal(new goals.GoalNear(target.position.x, target.position.y, target.position.z, config.followDistance));
    bot.setControlState('sprint', true);
    bot.setControlState('jump', true);
    if (!followingGoal) {
      followingGoal = true;
      log(`pathfinding toward ${owner} (${Math.round(distance)} blocks away)`);
    }
  } else if (followingGoal) {
    bot.pathfinder.setGoal(null);
    bot.setControlState('sprint', false);
    bot.setControlState('jump', false);
    followingGoal = false;
    log(`within follow distance of ${owner}`);
  }
}

function fight(entity, refreshThreat = true) {
  if (!entity || !bot.pvp || attackCooldown > 0) return;
  if (combatTarget?.id !== entity.id) {
    log(`switching from follow to attack: ${targetLabel(entity)}`);
    bot.pathfinder.setGoal(null);
    followingGoal = false;
  }
  combatTarget = entity;
  if (refreshThreat) lastThreatAt = Date.now();
  fleeing = false;
  attackCooldown = 10;
  bot.setControlState('sprint', true);
  bot.setControlState('jump', true);
  bot.pvp.attack(entity);
}

function maintainCombat() {
  if (!combatTarget) return;
  if (!bot.entity || bot.health <= 6) {
    if (!fleeing) log(`health is ${bot.health}; fleeing from ${targetLabel(combatTarget)}`);
    fleeFrom(combatTarget);
    return;
  }
  if (!bot.entities[combatTarget.id] || combatTarget.health === 0 || Date.now() - lastThreatAt > 4000) {
    log(`combat ended with ${targetLabel(combatTarget)}`);
    combatTarget = null;
    fleeing = false;
    bot.pvp.stop();
    bot.setControlState('sprint', false);
    bot.setControlState('jump', false);
    return;
  }
  if (!fleeing) fight(combatTarget, false);
}

function fleeFrom(threat) {
  if (!bot.entity || !threat?.position || !movements) return;
  if (bot.pvp) bot.pvp.stop();
  bot.pathfinder.setGoal(null);
  if (fleeing) return;
  fleeing = true;
  log(`pathfinding away from ${targetLabel(threat)}`);
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
  const player = bot.players[name] || Object.values(bot.players).find(candidate => candidate.username && candidate.username.toLowerCase() === wanted);
  return player?.entity || Object.values(bot.entities).find(entity => entity.username && entity.username.toLowerCase() === wanted) || null;
}

function serializeTarget(entity) {
  return { id: entity.id, username: entity.username || null };
}

function targetLabel(entity) {
  return entity?.username || `entity ${entity?.id ?? 'unknown'}`;
}

function log(message) {
  parentPort.postMessage({ type: 'log', message });
}

parentPort.on('message', message => {
  if (message.type === 'owner') {
    owner = message.owner;
    log(`owner set to ${owner}`);
    announceReady();
    followOwner();
  }
  if (message.type === 'follow') {
    owner = message.owner;
    log(`follow mode enabled for ${owner}`);
  }
  if (message.type === 'betray') {
    betrayed = message.enabled;
    log(`betray mode ${betrayed ? 'enabled' : 'disabled'}`);
  }
  if (message.type === 'defend') {
    const target = Object.values(bot.entities).find(entity => entity.id === message.target.id || (message.target.username && entity.username === message.target.username));
    if (target) fight(target);
  }
  if (message.type === 'attack') {
    const target = findPlayer(message.target);
    if (target && !isProtected(target)) fight(target);
  }
  if (message.type === 'say' && bot?.chat) bot.chat(message.message);
  if (message.type === 'shutdown') {
    log('shutdown requested');
    clearInterval(followTimer);
    followTimer = undefined;
    if (bot) {
      bot.setControlState('sprint', false);
      bot.setControlState('jump', false);
    }
    signalThread.postMessage({ type: 'shutdown' });
    clearTimeout(reconnectTimer);
    reconnectTimer = undefined;
    if (bot) bot.quit('Bodyguard dismissed');
    setTimeout(() => process.exit(0), 1000).unref();
  }
});
