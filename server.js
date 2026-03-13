const express = require('express');
const http = require('http');
const WebSocket = require('ws');

const app = express();
app.use(express.json());
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// rooms: Map<roomCode, [ws1, ws2]>
const rooms = new Map();

app.get('/', (req, res) => {
  res.json({ status: 'WatchChat running', rooms: rooms.size });
});

app.post('/join', (req, res) => {
  res.json({ ok: true });
});

wss.on('connection', (ws) => {
  let myRoom = null;
  let myUsername = null;

  ws.on('message', (data) => {
    let msg;
    try { msg = JSON.parse(data); } catch { return; }

    if (msg.type === 'join_room') {
      myUsername = msg.username;
      myRoom = msg.room;

      if (!rooms.has(myRoom)) {
        rooms.set(myRoom, []);
      }

      const room = rooms.get(myRoom);

      // Max 2 per room
      if (room.length >= 2) {
        ws.send(JSON.stringify({ type: 'error', message: 'Room full' }));
        return;
      }

      room.push({ ws, username: myUsername });
      ws.send(JSON.stringify({ type: 'joined', room: myRoom }));

      // Notify the other person if already in room
      if (room.length === 2) {
        const other = room.find(p => p.ws !== ws);
        if (other) {
          other.ws.send(JSON.stringify({ type: 'partner_joined', username: myUsername }));
          ws.send(JSON.stringify({ type: 'partner_joined', username: other.username }));
        }
      }
    }

    if (msg.type === 'message') {
      if (!myRoom) return;
      const room = rooms.get(myRoom);
      if (!room) return;
      const other = room.find(p => p.ws !== ws);
      if (other && other.ws.readyState === WebSocket.OPEN) {
        other.ws.send(JSON.stringify({
          type: 'message',
          from: myUsername,
          content: msg.content
        }));
      }
      // Echo to sender
      ws.send(JSON.stringify({
        type: 'message',
        from: myUsername,
        content: msg.content
      }));
    }

    if (msg.type === 'typing') {
      if (!myRoom) return;
      const room = rooms.get(myRoom);
      if (!room) return;
      const other = room.find(p => p.ws !== ws);
      if (other && other.ws.readyState === WebSocket.OPEN) {
        other.ws.send(JSON.stringify({
          type: 'typing',
          isTyping: msg.isTyping
        }));
      }
    }
  });

  ws.on('close', () => {
    if (!myRoom) return;
    const room = rooms.get(myRoom);
    if (!room) return;

    // Remove this user from room
    const updated = room.filter(p => p.ws !== ws);
    if (updated.length === 0) {
      rooms.delete(myRoom);
    } else {
      rooms.set(myRoom, updated);
      // Notify partner
      updated.forEach(p => {
        if (p.ws.readyState === WebSocket.OPEN) {
          p.ws.send(JSON.stringify({ type: 'partner_left' }));
        }
      });
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log('WatchChat on port ' + PORT));
