const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const sqlite3 = require('sqlite3').verbose();
const crypto = require('crypto');

const app = express();
app.use(express.json());

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// --- DATABASE ---
const db = new sqlite3.Database('./chat.db');

db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    invite_code TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    from_user TEXT NOT NULL,
    to_user TEXT NOT NULL,
    content TEXT NOT NULL,
    type TEXT DEFAULT 'text',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  // Insert default invite code for testing
  db.run(`INSERT OR IGNORE INTO users (username, invite_code) VALUES ('admin', 'WATCH1')`);
});

// --- CONNECTED CLIENTS ---
// Map: username -> WebSocket
const clients = new Map();

// --- REST API ---

// Register new user
app.post('/register', (req, res) => {
  const { username, invite_code } = req.body;
  if (!username || !invite_code) {
    return res.status(400).json({ error: 'username and invite_code required' });
  }

  // Validate invite code (any valid code works)
  const validCodes = ['WATCH1', 'WATCH2', 'WATCH3', 'WATCH4', 'WATCH5',
                      'TEFILLIN', 'SHALOM', 'GALAXY', 'SMART1', 'CHAT1'];

  if (!validCodes.includes(invite_code.toUpperCase())) {
    return res.status(403).json({ error: 'Invalid invite code' });
  }

  db.run(`INSERT OR IGNORE INTO users (username, invite_code) VALUES (?, ?)`,
    [username.trim(), invite_code.toUpperCase()],
    function(err) {
      if (err) {
        return res.status(500).json({ error: 'DB error' });
      }
      if (this.changes === 0) {
        // Username already exists - allow login
        return res.json({ success: true, username: username.trim(), message: 'Welcome back!' });
      }
      res.json({ success: true, username: username.trim(), message: 'Registered!' });
    }
  );
});

// Get online users
app.get('/users', (req, res) => {
  const online = Array.from(clients.keys());
  res.json({ online });
});

// Get message history between two users
app.get('/history/:user1/:user2', (req, res) => {
  const { user1, user2 } = req.params;
  db.all(`
    SELECT * FROM messages
    WHERE (from_user = ? AND to_user = ?) OR (from_user = ? AND to_user = ?)
    ORDER BY created_at DESC LIMIT 50
  `, [user1, user2, user2, user1], (err, rows) => {
    if (err) return res.status(500).json({ error: 'DB error' });
    res.json({ messages: rows.reverse() });
  });
});

// Health check
app.get('/', (req, res) => {
  res.json({
    status: 'WatchChat Server Running',
    online: clients.size,
    invite_codes: ['WATCH1', 'WATCH2', 'WATCH3', 'WATCH4', 'WATCH5',
                   'TEFILLIN', 'SHALOM', 'GALAXY', 'SMART1', 'CHAT1']
  });
});

// --- WEBSOCKET ---
wss.on('connection', (ws) => {
  let currentUser = null;

  ws.on('message', (data) => {
    let msg;
    try {
      msg = JSON.parse(data);
    } catch {
      return;
    }

    switch (msg.type) {

      // LOGIN
      case 'login': {
        const username = msg.username ? msg.username.trim() : null;
        if (!username) {
          ws.send(JSON.stringify({ type: 'error', message: 'No username' }));
          return;
        }

        db.get(`SELECT * FROM users WHERE username = ?`, [username], (err, row) => {
          if (!row) {
            ws.send(JSON.stringify({ type: 'error', message: 'User not found. Register first.' }));
            return;
          }

          currentUser = username;
          clients.set(username, ws);

          ws.send(JSON.stringify({ type: 'login_ok', username }));

          // Notify all others
          broadcast({
            type: 'user_online',
            username,
            online: Array.from(clients.keys())
          }, username);
        });
        break;
      }

      // SEND MESSAGE
      case 'message': {
        if (!currentUser) return;
        const { to, content, msgType } = msg;
        if (!to || !content) return;

        // Save to DB
        db.run(`INSERT INTO messages (from_user, to_user, content, type) VALUES (?, ?, ?, ?)`,
          [currentUser, to, content, msgType || 'text']
        );

        const payload = JSON.stringify({
          type: 'message',
          from: currentUser,
          to,
          content,
          msgType: msgType || 'text',
          time: new Date().toISOString()
        });

        // Send to recipient
        const recipientWs = clients.get(to);
        if (recipientWs && recipientWs.readyState === WebSocket.OPEN) {
          recipientWs.send(payload);
        }

        // Echo back to sender
        ws.send(payload);
        break;
      }

      // TYPING INDICATOR
      case 'typing': {
        if (!currentUser) return;
        const { to, isTyping } = msg;
        const recipientWs = clients.get(to);
        if (recipientWs && recipientWs.readyState === WebSocket.OPEN) {
          recipientWs.send(JSON.stringify({
            type: 'typing',
            from: currentUser,
            isTyping
          }));
        }
        break;
      }

      // GET ONLINE USERS
      case 'get_users': {
        ws.send(JSON.stringify({
          type: 'users_list',
          online: Array.from(clients.keys())
        }));
        break;
      }
    }
  });

  ws.on('close', () => {
    if (currentUser) {
      clients.delete(currentUser);
      broadcast({
        type: 'user_offline',
        username: currentUser,
        online: Array.from(clients.keys())
      });
    }
  });
});

function broadcast(data, excludeUser = null) {
  const payload = JSON.stringify(data);
  clients.forEach((clientWs, username) => {
    if (username !== excludeUser && clientWs.readyState === WebSocket.OPEN) {
      clientWs.send(payload);
    }
  });
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log('WatchChat server running on port ' + PORT);
});
