
import ws from 'k6/ws';
import { check } from 'k6';

export const options = {
  stages: [
    { duration: '30s', target: 50 }, // Ramp up to 50 users
    { duration: '1m', target: 50 },  // Stay at 50 users
    { duration: '30s', target: 0 },  // Ramp down
  ],
};

export default function () {
  const userId = `user-${__VU}-${Date.now()}`;
  const url = `wss://localhost:8443/ws/${userId}`;
  const params = {};

  const res = ws.connect(url, params, function (socket) {
    socket.on('open', function open() {
      // console.log(`connected: ${userId}`);

      // Send a message every second
      socket.setInterval(function timeout() {
        socket.send('INCREMENT');
      }, 1000);
    });

    socket.on('message', function (message) {
      check(message, { 'received echo': (m) => m.length > 0 });
    });

    socket.on('close', function () {
      // console.log(`disconnected: ${userId}`);
    });

    socket.on('error', function (e) {
      console.log(`error for ${userId}: ${e.error()}`);
    });

    // Close connection after 30 seconds
    socket.setTimeout(function () {
      socket.close();
    }, 30000);
  });

  check(res, { 'status is 101': (r) => r && r.status === 101 });
}
