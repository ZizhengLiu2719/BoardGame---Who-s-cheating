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
    const readyStates = { [hostName]: false };
    await redis.hmset(`room:${roomId}`,
      'password', password,
      'maxPlayers', maxPlayers,
      'roomName', roomName || '',
      'players', JSON.stringify(players),
      'readyStates', JSON.stringify(readyStates)
    );
    socket.join(roomId);
    callback({ success: true });
    io.to(roomId).emit('playerListUpdate', {
      players: players.map(p => p.name),
      roomName: roomName,
      password: password,
      readyStates: readyStates
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
    let readyStates = JSON.parse(room.readyStates || '{}');
    if (players.length >= Number(room.maxPlayers) && !players.some(p => p.name === playerName)) {
      return callback({ success: false, message: 'Room is full.' });
    }
    // If name already exists, update socket ID (allow host to rejoin)
    const existing = players.find(p => p.name === playerName);
    if (existing) {
      existing.id = socket.id;
    } else {
      players.push({ id: socket.id, name: playerName });
      readyStates[playerName] = false;
    }
    await setPlayerList(roomId, players);
    await redis.hset(`room:${roomId}`, 'readyStates', JSON.stringify(readyStates));
    socket.join(roomId);
    callback({ success: true });
    io.to(roomId).emit('playerListUpdate', {
      players: players.map(p => p.name),
      roomName: room.roomName,
      password: room.password,
      readyStates: readyStates
    });
  });

  // Player toggles ready/unready
  socket.on('setReadyState', async ({ roomId, playerName, isReady }) => {
    const room = await redis.hgetall(`room:${roomId}`);
    if (!room) return;
    let readyStates = JSON.parse(room.readyStates || '{}');
    readyStates[playerName] = isReady;
    await redis.hset(`room:${roomId}`, 'readyStates', JSON.stringify(readyStates));
    const players = JSON.parse(room.players || '[]');
    io.to(roomId).emit('playerListUpdate', {
      players: players.map(p => p.name),
      roomName: room.roomName,
      password: room.password,
      readyStates: readyStates
    });
  });

  // Host starts the game
  socket.on('startGame', async ({ roomId }) => {
    const room = await redis.hgetall(`room:${roomId}`);
    if (!room) return;
    const players = JSON.parse(room.players || '[]');
    const readyStates = JSON.parse(room.readyStates || '{}');
    const allReady = players.length === Number(room.maxPlayers) && players.every(p => readyStates[p.name]);
    if (allReady) {
      // Initialize game state
      const gameState = {
        nightCount: 0,
        scandal: 0,
        closeKnot: 0,
        roles: {},
        dramaCards: {},
        votes: {},
        usedPowers: {},
        currentPhase: 'night',
        playerStates: {},
        gameOver: false,
        winners: null
      };
      
      // Assign roles randomly
      const roles = ['Abby', 'Jack', 'Wind', 'Michael', 'Kennedi', 'Ker'];
      const shuffledRoles = roles.sort(() => Math.random() - 0.5);
      players.forEach((player, index) => {
        gameState.roles[player.name] = shuffledRoles[index];
        gameState.playerStates[player.name] = {
          hasVoted: false,
          hasPlayedDrama: false
        };
      });
      
      // Save game state
      await redis.hset(`room:${roomId}`, 'gameState', JSON.stringify(gameState));
      
      // Start game
      io.to(roomId).emit('startGame', gameState);
    }
  });

  // Handle game actions
  socket.on('gameAction', async ({ roomId, action, data }) => {
    const room = await redis.hgetall(`room:${roomId}`);
    if (!room) return;
    
    let gameState = JSON.parse(room.gameState || '{}');
    
    switch (action) {
      case 'usePower':
        if (!gameState.usedPowers[data.playerName]) {
          gameState.usedPowers[data.playerName] = true;
          const role = gameState.roles[data.playerName];
          
          switch (data.power) {
            case 'protectingParty': // Kennedi
              if (role === 'Kennedi') {
                gameState.closeKnot += 3;
              }
              break;
              
            case 'mislead': // Wind
              if (role === 'Wind') {
                gameState.scandal += 1;
                // Find one Love card and flip it to Hate
                const loveCards = Object.entries(gameState.dramaCards)
                  .filter(([_, card]) => card === 'love');
                if (loveCards.length > 0) {
                  const [playerName] = loveCards[0];
                  gameState.dramaCards[playerName] = 'hate';
                  gameState.closeKnot -= 1;
                  gameState.scandal += 1;
                }
              }
              break;
              
            case 'molestBoy': // Wind
              if (role === 'Wind') {
                gameState.scandal += 2;
              }
              break;
              
            case 'findAbby': // Michael
              if (role === 'Michael') {
                const targetName = data.targetName;
                if (gameState.roles[targetName] === 'Abby') {
                  // Cheaters win immediately
                  gameState.gameOver = true;
                  gameState.winners = 'cheaters';
                } else {
                  // Keepers win immediately
                  gameState.gameOver = true;
                  gameState.winners = 'keepers';
                }
              }
              break;
              
            case 'swapHelper': // Ker
              if (role === 'Ker') {
                const { oldHelper, newHelper } = data;
                if (gameState.currentHelpers.includes(oldHelper)) {
                  const idx = gameState.currentHelpers.indexOf(oldHelper);
                  gameState.currentHelpers[idx] = newHelper;
                }
              }
              break;
          }
        }
        break;
        
      case 'vote':
        gameState.votes[data.playerName] = data.vote;
        gameState.playerStates[data.playerName].hasVoted = true;
        
        // Check if all players have voted
        const allVoted = Object.values(gameState.playerStates).every(state => state.hasVoted);
        if (allVoted) {
          // Count votes
          const voteCounts = Object.values(gameState.votes).reduce((acc, vote) => {
            acc[vote] = (acc[vote] || 0) + 1;
            return acc;
          }, {});
          
          // Update scores based on votes
          if (voteCounts.love > voteCounts.hate) {
            gameState.closeKnot += 1;
          } else if (voteCounts.hate > voteCounts.love) {
            gameState.scandal += 1;
          }
          
          // Reset votes for next round
          gameState.votes = {};
          Object.values(gameState.playerStates).forEach(state => {
            state.hasVoted = false;
          });
          
          // Move to next phase
          gameState.currentPhase = gameState.currentPhase === 'night' ? 'party' : 'night';
          gameState.nightCount += 1;
        }
        break;
        
      case 'playDramaCard':
        gameState.dramaCards[data.playerName] = data.card;
        gameState.playerStates[data.playerName].hasPlayedDrama = true;
        
        // Check if all players have played their cards
        const allPlayed = Object.values(gameState.playerStates).every(state => state.hasPlayedDrama);
        if (allPlayed) {
          // Count cards
          const cardCounts = Object.values(gameState.dramaCards).reduce((acc, card) => {
            acc[card] = (acc[card] || 0) + 1;
            return acc;
          }, {});
          
          // Update scores based on cards
          if (cardCounts.love > cardCounts.hate) {
            gameState.closeKnot += 2;
          } else if (cardCounts.hate > cardCounts.love) {
            gameState.scandal += 2;
          }
          
          // Reset cards for next round
          gameState.dramaCards = {};
          Object.values(gameState.playerStates).forEach(state => {
            state.hasPlayedDrama = false;
          });
        }
        break;
        
      case 'changeStat':
        const { stat, delta } = data;
        if (gameState[stat] !== undefined) {
          gameState[stat] += delta;
          if (gameState[stat] < 0) gameState[stat] = 0;
        }
        break;
    }
    
    // Save updated game state
    await redis.hset(`room:${roomId}`, 'gameState', JSON.stringify(gameState));
    
    // Broadcast updated state to all players
    io.to(roomId).emit('gameStateUpdate', gameState);
  });

  // Handle disconnect
  socket.on('disconnect', async () => {
    // Find all rooms (scan keys)
    const keys = await redis.keys('room:*');
    for (const key of keys) {
      const roomId = key.split(':')[1];
      const room = await redis.hgetall(key);
      let players = JSON.parse(room.players || '[]');
      let readyStates = JSON.parse(room.readyStates || '{}');
      const idx = players.findIndex(p => p.id === socket.id);
      if (idx !== -1) {
        const playerName = players[idx].name;
        players.splice(idx, 1);
        delete readyStates[playerName];
        if (players.length === 0) {
          // Add a 5-second delay before deleting the room
          setTimeout(async () => {
            const checkRoom = await redis.hgetall(`room:${roomId}`);
            const checkPlayers = JSON.parse(checkRoom.players || '[]');
            if (checkPlayers.length === 0) {
              await deleteRoom(roomId);
              console.log('Room deleted after delay:', roomId);
            }
          }, 5000);
        } else {
          await setPlayerList(roomId, players);
          await redis.hset(`room:${roomId}`, 'readyStates', JSON.stringify(readyStates));
          io.to(roomId).emit('playerListUpdate', {
            players: players.map(p => p.name),
            roomName: room.roomName,
            password: room.password,
            readyStates: readyStates
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