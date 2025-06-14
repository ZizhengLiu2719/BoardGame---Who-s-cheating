const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const Redis = require('ioredis');

const app = express();
const server = http.createServer(app);
const io = new Server(server);
const redis = new Redis(process.env.REDIS_URL);

// Serve static files from the client directory
app.use(express.static(path.join(__dirname, '../client')));

// Optional: Serve titlePage.html for any unknown routes
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../client', 'titlePage.html'));
});

// Helper: get player list for a room from Redis
async function getPlayerList(roomId) {
  const room = await redis.hgetall(`room:${roomId}`);
  if (!room || !room.players) return [];
  return JSON.parse(room.players);
}

// Helper: update player list in Redis
async function setPlayerList(roomId, players) {
  await redis.hset(`room:${roomId}`, 'players', JSON.stringify(players));
}

// Helper: delete room from Redis
async function deleteRoom(roomId) {
  await redis.del(`room:${roomId}`);
}

// Socket.IO connection handler
io.on('connection', (socket) => {
  console.log('A user connected:', socket.id);

  // Host creates a room
  socket.on('createRoom', async ({ roomId, password, maxPlayers, hostName, roomName }, callback) => {
    const exists = await redis.exists(`room:${roomId}`);
    if (exists) {
      return callback({ success: false, message: 'Room already exists.' });
    }
    const players = [{ id: socket.id, name: hostName }];
    await redis.hmset(`room:${roomId}`,
      'password', password,
      'maxPlayers', maxPlayers,
      'roomName', roomName || '',
      'players', JSON.stringify(players)
    );
    socket.join(roomId);
    callback({ success: true });
    io.to(roomId).emit('playerListUpdate', {
      players: players.map(p => p.name),
      roomName: roomName,
      password: password
    });
  });

  // Player joins a room
  socket.on('joinRoom', async ({ roomId, password, playerName }, callback) => {
    const room = await redis.hgetall(`room:${roomId}`);
    if (!room || !room.password) {
      return callback({ success: false, message: 'Room does not exist.' });
    }
    if (room.password !== password) {
      return callback({ success: false, message: 'Incorrect password.' });
    }
    let players = JSON.parse(room.players || '[]');
    if (players.length >= Number(room.maxPlayers) && !players.some(p => p.name === playerName)) {
      return callback({ success: false, message: 'Room is full.' });
    }
    // If name already exists, update socket ID (allow host to rejoin)
    const existing = players.find(p => p.name === playerName);
    if (existing) {
      existing.id = socket.id;
    } else {
      players.push({ id: socket.id, name: playerName });
    }
    await setPlayerList(roomId, players);
    socket.join(roomId);
    callback({ success: true });
    io.to(roomId).emit('playerListUpdate', {
      players: players.map(p => p.name),
      roomName: room.roomName,
      password: room.password
    });
  });

  // Handle disconnect
  socket.on('disconnect', async () => {
    // Find all rooms (scan keys)
    const keys = await redis.keys('room:*');
    for (const key of keys) {
      const roomId = key.split(':')[1];
      const room = await redis.hgetall(key);
      let players = JSON.parse(room.players || '[]');
      const idx = players.findIndex(p => p.id === socket.id);
      if (idx !== -1) {
        players.splice(idx, 1);
        if (players.length === 0) {
          await deleteRoom(roomId);
        } else {
          await setPlayerList(roomId, players);
          io.to(roomId).emit('playerListUpdate', {
            players: players.map(p => p.name),
            roomName: room.roomName,
            password: room.password
          });
        }
        break;
      }
    }
    console.log('User disconnected:', socket.id);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));