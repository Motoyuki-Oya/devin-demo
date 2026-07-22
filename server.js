import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { WebSocketServer } from 'ws';
import { createPost, listPosts } from './src/store.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// --- REST API -------------------------------------------------------------

// 投稿一覧を新しい順で返す
app.get('/api/posts', (_req, res) => {
  res.json({ posts: listPosts() });
});

// 新規投稿を作成し、全 WebSocket クライアントへ配信する
app.post('/api/posts', (req, res) => {
  const { author, content } = req.body ?? {};
  try {
    const post = createPost({ author, content });
    broadcast({ type: 'post_added', post });
    res.status(201).json({ post });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// --- HTTP + WebSocket -----------------------------------------------------

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', (socket) => {
  // 接続直後に既存の投稿一覧を送る
  socket.send(JSON.stringify({ type: 'post_list', posts: listPosts() }));
});

function broadcast(message) {
  const data = JSON.stringify(message);
  for (const client of wss.clients) {
    if (client.readyState === 1 /* OPEN */) {
      client.send(data);
    }
  }
}

server.listen(PORT, () => {
  console.log(`devin-demo 掲示板が http://localhost:${PORT} で起動しました`);
});
