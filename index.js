'use strict';

const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');
const bot = require('./bitget-bot');

process.on('unhandledRejection', (err) => console.error('❌', err?.message));
process.on('uncaughtException',  (err) => console.error('❌', err?.message));

const PORT = process.env.PORT || 3000;
const app    = express();
const server = http.createServer(app);
const io     = new Server(server, {
  maxHttpBufferSize: 2e6, pingInterval: 15000, pingTimeout: 6000,
  cors: { origin: '*' }
});

app.use(express.static(path.join(__dirname)));
app.use(express.json());

app.get('/api/snapshot', (_req, res) => {
  try { res.json(bot.buildSnapshot()); } catch(e) { res.json({ error: e.message }); }
});

app.post('/api/signal', async (req, res) => {
  try {
    const { direction, pair, entry, tp, sl } = req.body;
    const result = await bot.submitManual(direction, pair, entry, tp, sl);
    res.json(result);
  } catch(e) {
    res.json({ error: e.message });
  }
});

app.get('/api/backtest', (_req, res) => {
  res.json({ error: 'Backtest removed — signal bot only' });
});

app.get('/healthz', (_req, res) => res.json({ ok: true }));

let lastEmit = 0;
function broadcast(snapshot) {
  const now = Date.now();
  if (now - lastEmit < 600) return;
  lastEmit = now;
  io.emit('snapshot', snapshot);
}

io.on('connection', (socket) => {
  console.log('🔌 Client ' + socket.id);
  try { socket.emit('snapshot', bot.buildSnapshot()); } catch (_) {}
  socket.on('disconnect', () => console.log('🔌 Left ' + socket.id));
});

async function main() {
  server.listen(PORT, () => console.log('🌐 http://localhost:' + PORT));
  bot.start(
    (event, data) => { if (event === 'snapshot') broadcast(data); },
    (msg) => console.log(msg)
  );
}

main();
