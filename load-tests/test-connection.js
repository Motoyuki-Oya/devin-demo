import ws from 'k6/ws';
import { check } from 'k6';

export default function () {
    const userId = `test-user-${Date.now()}`;
    const url = `wss://localhost:8443/ws/${userId}`;

    const res = ws.connect(url, {}, function (socket) {
        socket.on('open', function open() {
            console.log(`✓ Connected: ${userId}`);
        });

        socket.on('message', function (message) {
            console.log(`✓ Received: ${message}`);
        });

        socket.on('close', function () {
            console.log(`✓ Connection closed`);
        });

        socket.on('error', function (e) {
            console.log(`✗ Error: ${e.error()}`);
        });

        // Close after 2 seconds to test onClose
        socket.setTimeout(function () {
            console.log('Closing connection...');
            socket.close();
        }, 2000);
    });

    check(res, { 'WebSocket handshake successful': (r) => r && r.status === 101 });
}
