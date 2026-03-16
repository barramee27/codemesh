/**
 * Multiplayer Browser - Backend Server
 * Rooms, cursor sync, navigation sync, text chat, voice signaling (WebRTC)
 */
require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');
const path = require('path');

const app = express();
app.use(cors({ origin: '*' }));
app.use(express.json());

const server = http.createServer(app);

const io = new Server(server, {
  cors: { origin: '*' },
  pingInterval: 10000,
  pingTimeout: 5000,
  maxHttpBufferSize: 1e6,
});

// In-memory room state
const rooms = new Map(); // roomId -> { users: Map<socketId, {id, name, color}>, createdAt }

const COLORS = [
  '#FF6B6B', '#4ECDC4', '#45B7D1', '#96CEB4', '#FFEAA7', '#DDA0DD',
  '#98D8C8', '#F7DC6F', '#BB8FCE', '#85C1E9', '#F1948A', '#82E0AA'
];

function getColor(index) {
  return COLORS[index % COLORS.length];
}

function ensureRoom(roomId) {
  if (!rooms.has(roomId)) {
    rooms.set(roomId, {
      users: new Map(),
      createdAt: Date.now(),
      messages: [],
    });
  }
  return rooms.get(roomId);
}

io.on('connection', (socket) => {
  socket.on('join-room', ({ roomId, userName }) => {
    const room = ensureRoom(roomId);
    const userCount = room.users.size;
    const color = getColor(userCount);

    socket.join(roomId);
    socket.roomId = roomId;
    socket.userName = userName || `User_${socket.id.slice(-6)}`;
    socket.userColor = color;

    room.users.set(socket.id, {
      id: socket.id,
      name: socket.userName,
      color,
    });

    // Send current room state to joiner
    const users = Array.from(room.users.entries()).map(([sid, u]) => ({
      id: sid,
      name: u.name,
      color: u.color,
    }));
    socket.emit('room-joined', {
      roomId,
      myId: socket.id,
      users,
      messages: room.messages.slice(-50),
      currentUrl: room.currentUrl || null,
    });

    // Broadcast to others
    socket.to(roomId).emit('user-joined', {
      id: socket.id,
      name: socket.userName,
      color,
    });
  });

  socket.on('cursor-move', (data) => {
    if (socket.roomId) {
      socket.to(socket.roomId).emit('cursor-move', {
        id: socket.id,
        name: socket.userName,
        color: socket.userColor,
        x: data.x,
        y: data.y,
      });
    }
  });

  socket.on('navigate', (url) => {
    if (socket.roomId) {
      const room = rooms.get(socket.roomId);
      if (room) room.currentUrl = url;
      socket.to(socket.roomId).emit('navigate', { url, by: socket.userName });
    }
  });

  socket.on('chat-message', (text) => {
    if (socket.roomId && text && text.trim()) {
      const room = rooms.get(socket.roomId);
      const msg = {
        id: uuidv4(),
        userId: socket.id,
        userName: socket.userName,
        userColor: socket.userColor,
        text: text.trim().slice(0, 2000),
        ts: Date.now(),
      };
      if (room) {
        room.messages.push(msg);
        if (room.messages.length > 200) room.messages = room.messages.slice(-100);
      }
      io.to(socket.roomId).emit('chat-message', msg);
    }
  });

  socket.on('annotation-add', (data) => {
    if (socket.roomId) {
      socket.to(socket.roomId).emit('annotation-add', {
        ...data,
        userId: socket.id,
        userName: socket.userName,
        userColor: socket.userColor,
      });
    }
  });

  socket.on('annotation-remove', (id) => {
    if (socket.roomId) {
      socket.to(socket.roomId).emit('annotation-remove', id);
    }
  });

  socket.on('scroll-sync', (data) => {
    if (socket.roomId) {
      socket.to(socket.roomId).emit('scroll-sync', {
        id: socket.id,
        scrollX: data.scrollX,
        scrollY: data.scrollY,
      });
    }
  });

  // WebRTC voice signaling
  socket.on('voice-offer', ({ to, offer }) => {
    io.to(to).emit('voice-offer', { from: socket.id, offer, userName: socket.userName });
  });
  socket.on('voice-answer', ({ to, answer }) => {
    io.to(to).emit('voice-answer', { from: socket.id, answer });
  });
  socket.on('voice-ice', ({ to, candidate }) => {
    io.to(to).emit('voice-ice', { from: socket.id, candidate });
  });

  socket.on('disconnect', () => {
    if (socket.roomId) {
      const room = rooms.get(socket.roomId);
      if (room) {
        room.users.delete(socket.id);
        if (room.users.size === 0) {
          rooms.delete(socket.roomId);
        }
      }
      socket.to(socket.roomId).emit('user-left', { id: socket.id });
    }
  });
});

app.get('/api/room', (req, res) => {
  const roomId = uuidv4().slice(0, 8);
  ensureRoom(roomId);
  res.json({ roomId });
});

app.post('/api/room', (req, res) => {
  const roomId = uuidv4().slice(0, 8);
  ensureRoom(roomId);
  res.json({ roomId });
});

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});
app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 4000;
server.listen(PORT, () => {
  console.log(`Multiplayer Browser server on http://localhost:${PORT}`);
});
