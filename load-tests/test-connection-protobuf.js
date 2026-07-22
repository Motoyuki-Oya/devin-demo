import ws from 'k6/ws';
import { check } from 'k6';
import encoding from 'k6/encoding';

export default function () {
    const userId = `test-user-${Date.now()}`;
    const url = `wss://localhost:8443/ws/${userId}`;

    console.log(`Testing Protobuf WebSocket connection to ${url}`);

    const res = ws.connect(url, { binary: true }, function (socket) {
        socket.on('open', function open() {
            console.log(`✓ Connected: ${userId}`);

            // Send INCREMENT message as Protobuf binary
            // This is a manually encoded Protobuf message for testing
            // ClientMessage { increment: IncrementRequest { userId: "test" } }
            // Field 1 (increment) is a message, so: tag=0x0A (field 1, wire type 2)
            // IncrementRequest has field 1 (userId) as string: tag=0x0A (field 1, wire type 2)
            const userIdBytes = new TextEncoder().encode(userId);
            const incrementRequest = new Uint8Array([
                0x0A, userIdBytes.length, ...userIdBytes  // field 1: userId (string)
            ]);
            const clientMessage = new Uint8Array([
                0x0A, incrementRequest.length, ...incrementRequest  // field 1: increment (message)
            ]);

            console.log(`Sending INCREMENT (${clientMessage.length} bytes)`);
            socket.sendBinary(clientMessage.buffer);
        });

        socket.on('message', function (data) {
            if (data instanceof ArrayBuffer) {
                const bytes = new Uint8Array(data);
                console.log(`✓ Received binary message: ${bytes.length} bytes`);
                console.log(`  First bytes: ${Array.from(bytes.slice(0, 10)).map(b => '0x' + b.toString(16).padStart(2, '0')).join(' ')}`);
            } else {
                console.log(`✓ Received text message: ${data}`);
            }
        });

        socket.on('close', function () {
            console.log(`✓ Connection closed`);
        });

        socket.on('error', function (e) {
            console.log(`✗ Error: ${e.error()}`);
        });

        // Close after 3 seconds
        socket.setTimeout(function () {
            console.log('Closing connection...');
            socket.close();
        }, 3000);
    });

    check(res, {
        'WebSocket handshake successful': (r) => r && r.status === 101
    });
}
