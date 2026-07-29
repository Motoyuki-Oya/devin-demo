import { createSignal, For, onCleanup, onMount, Show } from 'solid-js';
import {
  createPostMessage,
  editPostMessage,
  parseServerMessage,
  toggleReactionMessage,
} from '../lib/proto';
import { EdgeCellTransport } from '../lib/transport';
import { BACKEND_URL } from '../lib/config';

interface PostReaction {
  emoji: string;
  authors: string[];
}

interface BoardPost {
  id: string;
  author: string;
  content: string;
  cellId: string;
  timestamp: number;
  reactions: PostReaction[];
  // 投稿時にパスワードが設定された投稿だけ編集できる
  editable: boolean;
  editedAt: number;
}

type ConnStatus = 'connecting' | 'open' | 'closed' | 'error';

const AUTHOR_STORAGE_KEY = 'edgecell.board.author';
const MAX_CONTENT_LEN = 500;
const MAX_PASSWORD_LEN = 128;
// サーバ側の許可リスト（CellSocket.ALLOWED_EMOJIS）と一致させる
const REACTION_EMOJIS = ['\u{1F44D}', '\u{1F602}', '\u{1F622}', '\u{1F389}', '\u2764\uFE0F', '\u{1F64F}'];
// 認証がないため名前を識別子に使う。空欄はサーバ側と同じ既定名に寄せる。
const DEFAULT_AUTHOR = '名無しさん';

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
  const [password, setPassword] = createSignal<string>('');
  // 編集中の投稿（id と入力途中の本文・パスワード）。同時に 1 件だけ編集する。
  const [editingId, setEditingId] = createSignal<string | null>(null);
  const [editContent, setEditContent] = createSignal<string>('');
  const [editPassword, setEditPassword] = createSignal<string>('');
  const [editError, setEditError] = createSignal<string>('');
  const [transport, setTransport] = createSignal<EdgeCellTransport | null>(null);
  // 絵文字パレットを開いている投稿の id（同時に 1 つだけ）
  const [pickerFor, setPickerFor] = createSignal<string | null>(null);

  // このタブ限定のランダム userId（サーバ側 userId 形式チェックに適合）
  const userId = `user-${crypto.randomUUID()}`;

  const toReactions = (list: any): PostReaction[] =>
    (list ?? [])
      .map((r: any) => ({
        emoji: String(r.emoji ?? ''),
        authors: (r.authors ?? []).map((a: any) => String(a)),
      }))
      .filter((r: PostReaction) => r.emoji.length > 0 && r.authors.length > 0);

  const toBoardPost = (p: any): BoardPost => ({
    id: String(p.id ?? ''),
    author: String(p.author ?? DEFAULT_AUTHOR),
    content: String(p.content ?? ''),
    cellId: String(p.cellId ?? ''),
    // protobufjs は int64 を Long で返しうるので Number に正規化
    timestamp: typeof p.timestamp === 'object' ? Number(p.timestamp) : Number(p.timestamp ?? 0),
    reactions: toReactions(p.reactions),
    editable: Boolean(p.editable),
    editedAt: typeof p.editedAt === 'object' ? Number(p.editedAt) : Number(p.editedAt ?? 0),
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
        } else if (msg.postUpdated) {
          // 編集された投稿。リアクションも含む最新の全量が届く
          const post = toBoardPost(msg.postUpdated);
          setPosts((prev) => prev.map((p) => (p.id === post.id ? post : p)));
        } else if (msg.editResult) {
          // 成否は要求したセッションにのみ返る
          const postId = String(msg.editResult.postId ?? '');
          if (msg.editResult.ok) {
            if (editingId() === postId) closeEditor();
          } else {
            setEditError(String(msg.editResult.message ?? '編集できませんでした'));
          }
        } else if (msg.reactionUpdate) {
          // 差分ではなく該当投稿のリアクション全量が届く
          const postId = String(msg.reactionUpdate.postId ?? '');
          const reactions = toReactions(msg.reactionUpdate.reactions);
          setPosts((prev) =>
            prev.map((p) => (p.id === postId ? { ...p, reactions } : p))
          );
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

    t.send(createPostMessage(name, body, password()));
    setContent('');
    setPassword('');
  };

  const openEditor = (post: BoardPost) => {
    setEditingId(post.id);
    setEditContent(post.content);
    setEditPassword('');
    setEditError('');
    setPickerFor(null);
  };

  const closeEditor = () => {
    setEditingId(null);
    setEditContent('');
    setEditPassword('');
    setEditError('');
  };

  const submitEdit = (e: Event) => {
    e.preventDefault();
    const t = transport();
    const postId = editingId();
    const body = editContent().trim();
    if (!t || !t.isConnected() || !postId || body.length === 0) return;
    setEditError('');
    t.send(editPostMessage(postId, body, editPassword()));
  };

  /** リアクションの識別子。サーバ側の正規化と揃えて自分の分を判定できるようにする。 */
  const currentAuthor = () => author().trim() || DEFAULT_AUTHOR;

  /** 認証がないため名前一致で判定する。同名は同一人物扱いになる。 */
  const isMine = (post: BoardPost) => post.author === currentAuthor();

  const toggleReaction = (postId: string, emoji: string) => {
    const t = transport();
    if (!t || !t.isConnected()) return;
    t.send(toggleReactionMessage(postId, emoji, author().trim()));
    setPickerFor(null);
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
        <input
          type="password"
          placeholder="編集用パスワード（任意。入力するとこの投稿を後から編集できます）"
          maxLength={MAX_PASSWORD_LEN}
          autocomplete="new-password"
          value={password()}
          onInput={(e) => setPassword(e.currentTarget.value)}
          style={{
            padding: '10px 12px',
            'border-radius': '8px',
            border: '1px solid #ccc',
            'font-size': '0.95em',
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
                  border: isMine(post) ? '1px solid #1976d2' : '1px solid #e0e0e0',
                  'border-left': isMine(post) ? '4px solid #1976d2' : undefined,
                  'border-radius': '10px',
                  'background-color': isMine(post) ? '#e3f2fd' : '#fafafa',
                }}
              >
                <div style={{ display: 'flex', 'align-items': 'baseline', 'justify-content': 'space-between', gap: '8px', 'margin-bottom': '6px' }}>
                  <strong style={{ color: '#1976d2' }}>
                    {post.author}
                    <Show when={isMine(post)}>
                      <span
                        style={{
                          'margin-left': '6px',
                          padding: '1px 6px',
                          'border-radius': '10px',
                          'background-color': '#1976d2',
                          color: '#fff',
                          'font-size': '0.7em',
                          'font-weight': 'normal',
                        }}
                      >
                        自分
                      </span>
                    </Show>
                  </strong>
                  <span style={{ 'font-size': '0.75em', color: '#999' }}>
                    {formatTime(post.timestamp)}
                    {post.editedAt > 0 ? ' · 編集済み' : ''}
                    {post.cellId ? ` · ${post.cellId}` : ''}
                  </span>
                </div>

                <Show
                  when={editingId() === post.id}
                  fallback={
                    <div style={{ 'white-space': 'pre-wrap', 'word-break': 'break-word', color: '#222' }}>
                      {post.content}
                    </div>
                  }
                >
                  <form onSubmit={submitEdit} style={{ display: 'flex', 'flex-direction': 'column', gap: '8px' }}>
                    <textarea
                      rows={3}
                      maxLength={MAX_CONTENT_LEN}
                      value={editContent()}
                      onInput={(e) => setEditContent(e.currentTarget.value)}
                      style={{
                        padding: '8px 10px',
                        'border-radius': '8px',
                        border: '1px solid #ccc',
                        'font-size': '0.95em',
                        'font-family': 'inherit',
                        resize: 'vertical',
                      }}
                    />
                    <input
                      type="password"
                      placeholder="投稿時に設定したパスワード"
                      maxLength={MAX_PASSWORD_LEN}
                      autocomplete="off"
                      value={editPassword()}
                      onInput={(e) => setEditPassword(e.currentTarget.value)}
                      style={{
                        padding: '8px 10px',
                        'border-radius': '8px',
                        border: '1px solid #ccc',
                        'font-size': '0.95em',
                      }}
                    />
                    <Show when={editError().length > 0}>
                      <span style={{ 'font-size': '0.8em', color: '#d32f2f' }}>{editError()}</span>
                    </Show>
                    <div style={{ display: 'flex', gap: '8px' }}>
                      <button
                        type="submit"
                        disabled={status() !== 'open' || editContent().trim().length === 0}
                        style={{
                          padding: '6px 16px',
                          'border-radius': '8px',
                          border: '1px solid #1976d2',
                          'background-color': '#1976d2',
                          color: '#fff',
                          'font-size': '0.85em',
                          cursor: 'pointer',
                        }}
                      >
                        保存
                      </button>
                      <button
                        type="button"
                        onClick={closeEditor}
                        style={{
                          padding: '6px 16px',
                          'border-radius': '8px',
                          border: '1px solid #ccc',
                          'background-color': '#fff',
                          color: '#555',
                          'font-size': '0.85em',
                          cursor: 'pointer',
                        }}
                      >
                        キャンセル
                      </button>
                    </div>
                  </form>
                </Show>

                <div style={{ display: 'flex', 'align-items': 'center', 'flex-wrap': 'wrap', gap: '6px', 'margin-top': '10px' }}>
                  <For each={post.reactions}>
                    {(reaction) => {
                      const mine = () => reaction.authors.includes(currentAuthor());
                      return (
                        <button
                          type="button"
                          title={reaction.authors.join(', ')}
                          disabled={status() !== 'open'}
                          onClick={() => toggleReaction(post.id, reaction.emoji)}
                          style={{
                            display: 'inline-flex',
                            'align-items': 'center',
                            gap: '4px',
                            padding: '2px 8px',
                            'border-radius': '12px',
                            border: `1px solid ${mine() ? '#1976d2' : '#ddd'}`,
                            'background-color': mine() ? '#e3f2fd' : '#fff',
                            color: mine() ? '#1976d2' : '#555',
                            'font-size': '0.85em',
                            'line-height': '1.6',
                            cursor: status() === 'open' ? 'pointer' : 'not-allowed',
                          }}
                        >
                          <span>{reaction.emoji}</span>
                          <span style={{ 'font-weight': mine() ? 'bold' : 'normal' }}>{reaction.authors.length}</span>
                        </button>
                      );
                    }}
                  </For>

                  <button
                    type="button"
                    title="リアクションを追加"
                    disabled={status() !== 'open'}
                    onClick={() => setPickerFor(pickerFor() === post.id ? null : post.id)}
                    style={{
                      padding: '2px 8px',
                      'border-radius': '12px',
                      border: '1px dashed #bbb',
                      'background-color': '#fff',
                      color: '#777',
                      'font-size': '0.85em',
                      'line-height': '1.6',
                      cursor: status() === 'open' ? 'pointer' : 'not-allowed',
                    }}
                  >
                    ＋
                  </button>

                  <Show when={post.editable && editingId() !== post.id}>
                    <button
                      type="button"
                      disabled={status() !== 'open'}
                      onClick={() => openEditor(post)}
                      style={{
                        padding: '2px 8px',
                        'border-radius': '12px',
                        border: '1px solid #ddd',
                        'background-color': '#fff',
                        color: '#777',
                        'font-size': '0.85em',
                        'line-height': '1.6',
                        cursor: status() === 'open' ? 'pointer' : 'not-allowed',
                      }}
                    >
                      編集
                    </button>
                  </Show>

                  <Show when={pickerFor() === post.id}>
                    <div style={{ display: 'flex', gap: '2px', padding: '2px 6px', border: '1px solid #ddd', 'border-radius': '12px', 'background-color': '#fff' }}>
                      <For each={REACTION_EMOJIS}>
                        {(emoji) => (
                          <button
                            type="button"
                            onClick={() => toggleReaction(post.id, emoji)}
                            style={{
                              border: 'none',
                              background: 'none',
                              padding: '2px 4px',
                              'font-size': '1.1em',
                              cursor: 'pointer',
                            }}
                          >
                            {emoji}
                          </button>
                        )}
                      </For>
                    </div>
                  </Show>
                </div>
              </li>
            )}
          </For>
        </ul>
      </Show>
    </div>
  );
}
