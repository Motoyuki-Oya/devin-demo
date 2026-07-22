// WebSocket increment round-trip / throughput benchmark.
// 使い方: node --experimental-websocket bench-rtt.mjs [wsBase] [idleConns] [senders] [durationSec]
// 例:     node --experimental-websocket bench-rtt.mjs ws://localhost:8080 100 20 10
//
// 構成:
//   - idleConns 本のアイドル接続(ブロードキャスト受信のみ) → O(N) fan-out 負荷を再現
//   - RTT フェーズ: 単一プローブが send→次の broadcast 受信を逐次計測(帰属が明確)
//   - スループットフェーズ: senders 本がクローズドループで increment を送信

const [, , base = 'ws://localhost:8080', idleArg = '100', senderArg = '20', durArg = '10'] = process.argv;
const IDLE_N = Number(idleArg);
const SENDER_N = Number(senderArg);
const DURATION_MS = Number(durArg) * 1000;

function encodeIncrement(userId) {
    const u = new TextEncoder().encode(userId);
    const inner = new Uint8Array([0x0a, u.length, ...u]);
    return new Uint8Array([0x0a, inner.length, ...inner]);
}

function openWS(id, onMsg) {
    return new Promise((resolve, reject) => {
        const ws = new WebSocket(`${base}/ws/${id}`);
        ws.binaryType = 'arraybuffer';
        const t = setTimeout(() => reject(new Error(`open timeout: ${id}`)), 15000);
        ws.onopen = () => { clearTimeout(t); resolve(ws); };
        ws.onerror = () => { clearTimeout(t); reject(new Error(`ws error: ${id}`)); };
        if (onMsg) ws.onmessage = onMsg;
    });
}

function percentile(sorted, p) {
    return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length * p) / 100))];
}

const run = crypto.randomUUID().slice(0, 8);
let idleMsgCount = 0;

// 1) 接続バースト(handshake: origin チェック + userId 正規表現 + Redis SETEX を含む)
const t0 = performance.now();
const idles = [];
const BATCH = 25;
for (let i = 0; i < IDLE_N; i += BATCH) {
    const batch = [];
    for (let j = i; j < Math.min(i + BATCH, IDLE_N); j++) {
        batch.push(openWS(`bench-${run}-idle-${j}`, () => { idleMsgCount++; }));
    }
    idles.push(...(await Promise.all(batch)));
}
const connectMs = performance.now() - t0;
console.log(`connect_burst: ${IDLE_N} conns in ${connectMs.toFixed(0)} ms (${(IDLE_N / (connectMs / 1000)).toFixed(0)} conn/s)`);

// 2) RTT フェーズ: 単一プローブ、逐次 send→broadcast 受信
let probeResolve = null;
const probe = await openWS(`bench-${run}-probe`, () => { if (probeResolve) { const r = probeResolve; probeResolve = null; r(); } });
const probeMsg = encodeIncrement(`bench-${run}-probe`);
await new Promise((r) => setTimeout(r, 500));

// warmup (JIT)
for (let i = 0; i < 200; i++) {
    const p = new Promise((r) => { probeResolve = r; });
    probe.send(probeMsg);
    await p;
}

const rtts = [];
for (let i = 0; i < 500; i++) {
    const start = performance.now();
    const p = new Promise((r) => { probeResolve = r; });
    probe.send(probeMsg);
    await p;
    rtts.push(performance.now() - start);
}
rtts.sort((a, b) => a - b);
console.log(`rtt_ms: p50=${percentile(rtts, 50).toFixed(2)} p95=${percentile(rtts, 95).toFixed(2)} p99=${percentile(rtts, 99).toFixed(2)} max=${rtts[rtts.length - 1].toFixed(2)} (n=${rtts.length}, idle fan-out=${IDLE_N})`);

// 3) スループットフェーズ: SENDER_N 本のクローズドループ
const senders = [];
for (let i = 0; i < SENDER_N; i++) {
    senders.push(await openWS(`bench-${run}-sender-${i}`, null));
}
await new Promise((r) => setTimeout(r, 300));

const idleCountStart = idleMsgCount;
const deadline = performance.now() + DURATION_MS;
let completed = 0;

await Promise.all(
    senders.map((ws, i) => {
        const msg = encodeIncrement(`bench-${run}-sender-${i}`);
        return new Promise((resolve) => {
            let pending = null;
            ws.onmessage = () => { if (pending) { const r = pending; pending = null; r(); } };
            (async () => {
                while (performance.now() < deadline) {
                    const p = new Promise((r) => { pending = r; });
                    ws.send(msg);
                    await p;
                    completed++;
                }
                resolve();
            })();
        });
    }),
);

const fanout = idleMsgCount - idleCountStart;
console.log(`throughput: ${(completed / (DURATION_MS / 1000)).toFixed(0)} increments/s (senders=${SENDER_N}, closed-loop)`);
console.log(`fanout_delivery: ${(fanout / (DURATION_MS / 1000)).toFixed(0)} msgs/s delivered to ${IDLE_N} idle conns`);

for (const ws of [...idles, ...senders, probe]) ws.close();
console.log('done');
process.exit(0);
