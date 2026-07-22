import { createSignal, onCleanup, onMount } from 'solid-js';
import { createIncrementMessage, parseServerMessage } from '../lib/proto';
import { EdgeCellTransport } from '../lib/transport';

export default function Counter() {
  const [count, setCount] = createSignal<number>(0);
  const [status, setStatus] = createSignal<'connecting' | 'open' | 'closed' | 'error'>('closed');
  const [transport, setTransport] = createSignal<EdgeCellTransport | null>(null);

  // Use a random ID for this session (UUID: 衝突しない & サーバ側の userId 形式チェックに適合)
  const userId = `user-${crypto.randomUUID()}`;

  onMount(() => {
    connect();
  });

  onCleanup(() => {
    transport()?.close();
  });

  const connect = () => {
    setStatus('connecting');

    const t = new EdgeCellTransport({
      url: 'https://localhost:8443',
      userId,
      onConnect: () => {
        setStatus('open');
        console.log(`Connected via ${t.getProtocol()}`);
      },
      onDisconnect: () => {
        setStatus('closed');
        console.log('Disconnected');
      },
      onError: (error) => {
        setStatus('error');
        console.error('Transport error:', error);
      },
      autoReconnect: true,
      reconnectDelay: 3000,
    });

    // Register message handler
    t.onMessage((data) => {
      try {
        const serverMessage = parseServerMessage(data);

        if (serverMessage.counterUpdate) {
          setCount(Number(serverMessage.counterUpdate.value));
          console.log(`Counter updated: ${serverMessage.counterUpdate.value}`);
        }
      } catch (error) {
        console.error('Failed to parse message:', error);
      }
    });

    setTransport(t);
  };

  const increment = () => {
    const t = transport();
    if (t && t.isConnected()) {
      const message = createIncrementMessage(userId);
      t.send(message);
    }
  };

  return (
    <div style={{ display: 'flex', 'align-items': 'center', gap: '16px' }}>
      <button
        type="button"
        onClick={increment}
        disabled={status() !== 'open'}
        style={{
          padding: '12px 24px',
          'border-radius': '10px',
          border: '1px solid #ccc',
          'background-color': status() === 'open' ? '#e3f2fd' : '#f4f4f4',
          cursor: status() === 'open' ? 'pointer' : 'not-allowed',
          'font-size': '1.3em',
          'font-weight': 'bold',
          transition: 'all 0.2s'
        }}
      >
        +1
      </button>

      <div style={{
        'font-size': '2.5em',
        'font-weight': 'bold',
        'min-width': '80px',
        'text-align': 'center',
        color: status() === 'open' ? '#1976d2' : '#999'
      }}>
        {count()}
      </div>

      <div style={{
        'font-size': '0.85em',
        color: status() === 'open' ? '#4caf50' : '#999',
        'font-weight': '500'
      }}>
        {status() === 'open' ? '● 接続中' : status() === 'connecting' ? '○ 接続中...' : '○ 切断'}
      </div>
    </div>
  );
}
