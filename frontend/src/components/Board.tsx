import { createSignal, For, onCleanup, onMount, Show } from 'solid-js';
import { createPostMessage, parseServerMessage } from '../lib/proto';
import { EdgeCellTransport } from '../lib/transport';
import { BACKEND_URL } from '../lib/config';

interface BoardPost {
  id: string;
  author: string;
  content: string;
  cellId: string;
  timestamp: number;
}

type ConnStatus = 'connecting' | 'open' | 'closed' | 'error';

const AUTHOR_STORAGE_KEY = 'edgecell.board.author';
const MAX_CONTENT_LEN = 500;

function formatTime(ts: number): string {
  if (!ts) return '';
  const d = new Date(ts);
  return d.toLocaleString('ja-JP', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

export default function Board() {
  const [posts, setPosts] = createSignal<BoardPost[]>([]);
  const [status, setStatus] = createSignal<ConnStatus>('closed');
  const [author, setAuthor] = createSignal<string>('');
  const [content, setContent] = createSignal<string>('');
  const [transport, setTransport] = createSignal<EdgeCellTransport | null>(null);

  // このタブ限定のランダム userId（サーバ側 userId 形式チェックに適合）
  const userId = `user-${crypto.randomUUID()}`;

  const toBoardPost = (p: any): BoardPost => ({
    id: String(p.id ?? ''),
    author: String(p.author ?? '名無しさん'),
    content: String(p.content ?? ''),
    cellId: String(p.cellId ?? ''),
    // protobufjs は int64 を Long で返しうるので Number に正規化
    timestamp: typeof p.timestamp === 'object' ? Number(p.timestamp) : Number(p.timestamp ?? 0),
  });

  onMount(() => {
    if (typeof localStorage !== 'undefined') {
      setAuthor(localStorage.getItem(AUTHOR_STORAGE_KEY) ?? '');
    }
    connect();
  });

  onCleanup(() => {
    transport()?.close();
  });

  const connect = () => {
    setStatus('connecting');

    const t = new EdgeCellTransport({
      url: BACKEND_URL,
      userId,
      onConnect: () => setStatus('open'),
      onDisconnect: () => setStatus('closed'),
      onError: () => setStatus('error'),
      autoReconnect: true,
      reconnectDelay: 3000,
    });

    t.onMessage((data) => {
      try {
        const msg = parseServerMessage(data);

        if (msg.postList) {
          // 接続直後の初期一覧（新しい順で届く）
          const list = (msg.postList.posts ?? []).map(toBoardPost);
          setPosts(list);
        } else if (msg.postAdded) {
          const post = toBoardPost(msg.postAdded);
          // 重複配信に備えて id で去重し、先頭に追加
          setPosts((prev) => (prev.some((p) => p.id === post.id) ? prev : [post, ...prev]));
        }
      } catch (error) {
        console.error('Failed to parse message:', error);
      }
    });

    setTransport(t);
  };

  const submit = (e: Event) => {
    e.preventDefault();
    const t = transport();
    const body = content().trim();
    if (!t || !t.isConnected() || body.length === 0) return;

    const name = author().trim();
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(AUTHOR_STORAGE_KEY, name);
    }

    t.send(createPostMessage(name, body));
    setContent('');
  };

  const statusLabel = () =>
    status() === 'open' ? '● 接続中' : status() === 'connecting' ? '○ 接続中...' : '○ 切断';

  return (
    <div>
      <form
        onSubmit={submit}
        style={{ display: 'flex', 'flex-direction': 'column', gap: '10px', 'margin-bottom': '20px' }}
      >
        <input
          type="text"
          placeholder="名前（未入力なら名無しさん）"
          maxLength={50}
          value={author()}
          onInput={(e) => setAuthor(e.currentTarget.value)}
          style={{
            padding: '10px 12px',
            'border-radius': '8px',
            border: '1px solid #ccc',
            'font-size': '0.95em',
          }}
        />
        <textarea
          placeholder="投稿内容を入力..."
          rows={3}
          maxLength={MAX_CONTENT_LEN}
          value={content()}
          onInput={(e) => setContent(e.currentTarget.value)}
          style={{
            padding: '10px 12px',
            'border-radius': '8px',
            border: '1px solid #ccc',
            'font-size': '0.95em',
            'font-family': 'inherit',
            resize: 'vertical',
          }}
        />
        <div style={{ display: 'flex', 'align-items': 'center', 'justify-content': 'space-between', gap: '12px' }}>
          <span style={{ 'font-size': '0.8em', color: '#999' }}>
            {content().length} / {MAX_CONTENT_LEN}
          </span>
          <div style={{ display: 'flex', 'align-items': 'center', gap: '12px' }}>
            <span
              style={{
                'font-size': '0.85em',
                'font-weight': '500',
                color: status() === 'open' ? '#4caf50' : '#999',
              }}
            >
              {statusLabel()}
            </span>
            <button
              type="submit"
              disabled={status() !== 'open' || content().trim().length === 0}
              style={{
                padding: '10px 22px',
                'border-radius': '8px',
                border: '1px solid #1976d2',
                'background-color': status() === 'open' && content().trim().length > 0 ? '#1976d2' : '#b0bec5',
                color: '#fff',
                'font-weight': 'bold',
                cursor: status() === 'open' && content().trim().length > 0 ? 'pointer' : 'not-allowed',
              }}
            >
              投稿する
            </button>
          </div>
        </div>
      </form>

      <Show
        when={posts().length > 0}
        fallback={<p style={{ color: '#999', 'text-align': 'center', padding: '24px 0' }}>まだ投稿はありません。最初の投稿をしてみましょう。</p>}
      >
        <ul style={{ 'list-style': 'none', padding: '0', margin: '0', display: 'flex', 'flex-direction': 'column', gap: '12px' }}>
          <For each={posts()}>
            {(post) => (
              <li
                style={{
                  padding: '12px 14px',
                  border: '1px solid #e0e0e0',
                  'border-radius': '10px',
                  'background-color': '#fafafa',
                }}
              >
                <div style={{ display: 'flex', 'align-items': 'baseline', 'justify-content': 'space-between', gap: '8px', 'margin-bottom': '6px' }}>
                  <strong style={{ color: '#1976d2' }}>{post.author}</strong>
                  <span style={{ 'font-size': '0.75em', color: '#999' }}>
                    {formatTime(post.timestamp)}{post.cellId ? ` · ${post.cellId}` : ''}
                  </span>
                </div>
                <div style={{ 'white-space': 'pre-wrap', 'word-break': 'break-word', color: '#222' }}>
                  {post.content}
                </div>
              </li>
            )}
          </For>
        </ul>
      </Show>
    </div>
  );
}
