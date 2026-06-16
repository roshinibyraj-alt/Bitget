'use strict';
const bot = require('./bitget-bot');

async function main() {
  try {
    await bot.start(
      (event, data) => { if (event === 'snapshot') process.stdout.write('.'); },
      (msg) => console.log(msg)
    );
  } catch(e) {
    console.error('FATAL:', e.message, e.stack);
  }
}

process.on('unhandledRejection', (err) => console.error('UNHANDLED:', err?.message, err?.stack));
process.on('uncaughtException', (err) => console.error('UNCAUGHT:', err?.message, err?.stack));

setTimeout(() => {
  console.log('TIMEOUT - checking snapshot...');
  const snap = bot.buildSnapshot();
  console.log('Pairs:', snap.pairs.length);
  console.log('Balance:', snap.balance);
  process.exit(0);
}, 35000);

main();
