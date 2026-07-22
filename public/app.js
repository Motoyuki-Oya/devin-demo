const AUTHOR_KEY = 'devin-demo.author';

const form = document.getElementById('post-form');
const authorInput = document.getElementById('author');
const contentInput = document.getElementById('content');
const submitButton = document.getElementById('submit');
const counter = document.getElementById('counter');
const statusEl = document.getElementById('status');
const postsEl = document.getElementById('posts');
const emptyEl = document.getElementById('empty');

const seenIds = new Set();

// --- rendering ------------------------------------------------------------

function formatTime(ts) {
  return new Date(ts).toLocaleString('ja-JP', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

function renderPost(post, { prepend = false } = {}) {
  if (seenIds.has(post.id)) return;
  seenIds.add(post.id);

  const li = document.createElement('li');
  li.className = 'post';

  const head = document.createElement('div');
  head.className = 'post__head';

  const author = document.createElement('strong');
  author.className = 'post__author';
  author.textContent = post.author;

  const time = document.createElement('span');
  time.className = 'post__time';
  time.textContent = formatTime(post.createdAt);

  head.append(author, time);

  const body = document.createElement('div');
  body.className = 'post__body';
  body.textContent = post.content;

  li.append(head, body);

  if (prepend) {
    postsEl.prepend(li);
  } else {
    postsEl.append(li);
  }
  updateEmpty();
}

function updateEmpty() {
  emptyEl.style.display = postsEl.children.length === 0 ? '' : 'none';
}

function setStatus(state) {
  const labels = {
    open: '● 接続中',
    connecting: '○ 接続中...',
    closed: '○ 切断',
  };
  statusEl.textContent = labels[state] ?? labels.closed;
  statusEl.className = `status status--${state}`;
  submitButton.disabled = state !== 'open' || contentInput.value.trim().length === 0;
}

// --- websocket ------------------------------------------------------------

function connect() {
  setStatus('connecting');
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${proto}://${location.host}/ws`);

  ws.addEventListener('open', () => setStatus('open'));
  ws.addEventListener('close', () => {
    setStatus('closed');
    setTimeout(connect, 2000);
  });
  ws.addEventListener('message', (event) => {
    const msg = JSON.parse(event.data);
    if (msg.type === 'post_list') {
      postsEl.innerHTML = '';
      seenIds.clear();
      msg.posts.forEach((p) => renderPost(p));
      updateEmpty();
    } else if (msg.type === 'post_added') {
      renderPost(msg.post, { prepend: true });
    }
  });
}

// --- form -----------------------------------------------------------------

authorInput.value = localStorage.getItem(AUTHOR_KEY) ?? '';

contentInput.addEventListener('input', () => {
  counter.textContent = `${contentInput.value.length} / 500`;
  submitButton.disabled =
    statusEl.classList.contains('status--open') === false ||
    contentInput.value.trim().length === 0;
});

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const content = contentInput.value.trim();
  if (content.length === 0) return;

  const author = authorInput.value.trim();
  localStorage.setItem(AUTHOR_KEY, author);

  submitButton.disabled = true;
  try {
    await fetch('/api/posts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ author, content }),
    });
    contentInput.value = '';
    counter.textContent = '0 / 500';
  } catch (err) {
    console.error('投稿に失敗しました', err);
  } finally {
    submitButton.disabled = contentInput.value.trim().length === 0;
  }
});

connect();
