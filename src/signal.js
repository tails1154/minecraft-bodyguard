// One signaling worker belongs to each bodyguard worker. It intentionally has
// no Mineflayer state: it only forwards small, serializable alert messages.
const { parentPort } = require('node:worker_threads');

parentPort.on('message', message => {
  if (message.type === 'hit' && message.target) {
    parentPort.postMessage({ type: 'alert', target: message.target });
  }
  if (message.type === 'shutdown') process.exit(0);
});
