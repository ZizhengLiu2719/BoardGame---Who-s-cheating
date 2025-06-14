const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Serve static files from the client directory
app.use(express.static(path.join(__dirname, '../client')));

// Optional: Serve titlePage.html for any unknown routes
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../client', 'titlePage.html'));
});

// Room management
const rooms = {};

// Helper: get player list for a room
function getPlayerList(roomId) {
  return rooms[roomId]?.players.map(p => p.name) || [];
}

// Socket.IO connection handler
io.on('connection', (socket) => {
  console.log('A user connected:', socket.id);

  // Host creates a room
  socket.on('createRoom', ({ roomId, password, maxPlayers, hostName, roomName }, callback) => {
    if (rooms[roomId]) {
      return callback({ success: false, message: 'Room already exists.' });
    }
    rooms[roomId] = {
      password,
      maxPlayers: Number(maxPlayers),
      players: [{ id: socket.id, name: hostName }],
      roomName: roomName || '',
    };
    socket.join(roomId);
    callback({ success: true });
    io.to(roomId).emit('playerListUpdate', {
      players: getPlayerList(roomId),
      roomName: rooms[roomId].roomName,
      password: rooms[roomId].password
    });
  });

  // Player joins a room
  socket.on('joinRoom', ({ roomId, password, playerName }, callback) => {
    const room = rooms[roomId];
    if (!room) {
      return callback({ success: false, message: 'Room does not exist.' });
    }
    if (room.password !== password) {
      return callback({ success: false, message: 'Incorrect password.' });
    }
    if (room.players.length >= room.maxPlayers && !room.players.some(p => p.name === playerName)) {
      return callback({ success: false, message: 'Room is full.' });
    }
    // If name already exists, update socket ID (allow host to rejoin)
    const existing = room.players.find(p => p.name === playerName);
    if (existing) {
      existing.id = socket.id;
    } else {
      room.players.push({ id: socket.id, name: playerName });
    }
    socket.join(roomId);
    callback({ success: true });
    io.to(roomId).emit('playerListUpdate', {
      players: getPlayerList(roomId),
      roomName: room.roomName,
      password: room.password
    });
  });

  // Handle disconnect
  socket.on('disconnect', () => {
    for (const [roomId, room] of Object.entries(rooms)) {
      const idx = room.players.findIndex(p => p.id === socket.id);
      if (idx !== -1) {
        room.players.splice(idx, 1);
        io.to(roomId).emit('playerListUpdate', {
          players: getPlayerList(roomId),
          roomName: room.roomName,
          password: room.password
        });
        // Remove room if empty
        if (room.players.length === 0) {
          delete rooms[roomId];
        }
        break;
      }
    }
    console.log('User disconnected:', socket.id);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));