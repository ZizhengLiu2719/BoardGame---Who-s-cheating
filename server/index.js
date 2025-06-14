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

// Socket.IO connection handler
io.on('connection', (socket) => {
  console.log('A user connected:', socket.id);

  // You will add your game logic here

  socket.on('disconnect', () => {
    console.log('User disconnected:', socket.id);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));