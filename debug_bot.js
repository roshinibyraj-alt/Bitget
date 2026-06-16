'use strict';
const bot = require('./bitget-bot');
const fs = require('fs');

// Log everything
function log(m) {
  const line = new Date().toISOString() + ' ' + m;
  console.log(line);
  fs.appendFileSync('/tmp/debug.log', line + '\n');
}

process.on('unhandledRejection', (err) => {
  const line = new Date().toISOString() + ' UNHANDLED: ' + (err?.message || err) + ' ' + (err?.stack || '');
  console.error(line);
  fs.appendFileSync('/tmp/debug.log', line + '\n');
});

process.on('uncaughtException', (err) => {
  const line = new Date().toISOString() + ' UNCAUGHT: ' + (err?.message || err) + ' ' + (err?.stack || '');
  console.error(line);
  fs.appendFileSync('/tmp/debug.log', line + '\n');
});

fs.writeFileSync('/tmp/debug.log', 'Starting at ' + new Date().toISOString() + '\n');

bot.start(
  (e, d) => { if (e === 'snapshot') log('SNAPSHOT: ' + d.balance + ' pairs=' + d.pairs.length + ' pos=' + d.positions.length); },
  (m) => log(m)
).then(() => {
  log('Bot started OK');
}).catch(e => {
  log('START FAILED: ' + e.message);
});

setInterval(() => {}, 60000); // keep alive
