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

// Role distribution
function distributeRoles(playerCount) {
  const roles = [];
  
  // Define role pools based on player count
  if (playerCount === 6) {
    // 2 Cheaters, 4 Keepers (including 2 Pets)
    roles.push('Michael', 'Wind', 'Abby', 'Kennedi', 'Kiko', 'Knox');
  } else if (playerCount === 7) {
    // 2 Cheaters, 5 Keepers (including 3 Pets)
    roles.push('Michael', 'Wind', 'Abby', 'Kennedi', 'Kiko', 'Knox', 'Nash');
  } else if (playerCount === 8) {
    // 3 Cheaters, 5 Keepers (including 2 Pets)
    roles.push('Michael', 'Jack', 'Wind', 'Abby', 'Kennedi', 'Ker', 'Kiko', 'Knox');
  } else if (playerCount === 9) {
    // 3 Cheaters, 6 Keepers (including 3 Pets)
    roles.push('Michael', 'Jack', 'Wind', 'Abby', 'Kennedi', 'Ker', 'Kiko', 'Knox', 'Nash');
  }
  
  // Shuffle the roles
  for (let i = roles.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [roles[i], roles[j]] = [roles[j], roles[i]];
  }
  
  return roles;
}

// Game state management
async function initializeGameState(roomId, players) {
  const gameState = {
    players: players.map(p => ({
      id: p.id,
      name: p.name,
      role: null,  // Will be assigned during role distribution
      position: null,  // Will be assigned during setup
      isHost: p.name === players[0].name
    })),
    roles: [],  // Will be populated during role distribution
    
    // UI State
    isDay: true,  // Track day/night state for background
    dayNightSwitchClicked: false,  // Track if switch button was clicked
    
    // Game Scores
    partyCount: 0,  // Track number of parties completed
    scandalScore: 0,  // Track scandal points
    closeKnotScore: 0,  // Track close-knot points
    voteCount: 0,  // Track number of votes cast
    loveCount: 0,  // Track love card count
    hateCount: 0,   // Track hate card count
    uiMessage: null,
    usedActions: {
      vote: {},
      love: {},
      hate: {},
      skills: {}
    }
  };
  
  await redis.hset(`room:${roomId}`, 'gameState', JSON.stringify(gameState));
  return gameState;
}

async function getGameState(roomId) {
  const room = await redis.hgetall(`room:${roomId}`);
  if (!room || !room.gameState) return null;
  return JSON.parse(room.gameState);
}

async function updateGameState(roomId, gameState) {
  await redis.hset(`room:${roomId}`, 'gameState', JSON.stringify(gameState));
}

// Helper: Broadcast UI message with expiration
async function broadcastUIMessage(roomId, text, durationMs) {
  const gameState = await getGameState(roomId);
  const expiresAt = durationMs > 0 ? Date.now() + durationMs : null;
  gameState.uiMessage = { text, expiresAt };
  await updateGameState(roomId, gameState);
  io.to(roomId).emit('uiMessage', gameState.uiMessage);
  if (durationMs > 0) {
    setTimeout(async () => {
      const gs = await getGameState(roomId);
      if (gs && gs.uiMessage && gs.uiMessage.expiresAt === expiresAt) {
        gs.uiMessage = null;
        await updateGameState(roomId, gs);
        io.to(roomId).emit('uiMessage', null);
      }
    }, durationMs);
  }
}

// Helper: Reset game state to default
async function resetGameState(roomId) {
  const room = await redis.hgetall(`room:${roomId}`);
  if (!room) return;
  const players = JSON.parse(room.players || '[]');
  const gameState = {
    players: players.map(p => ({
      id: p.id,
      name: p.name,
      role: null,
      position: null,
      isHost: p.name === players[0].name
    })),
    roles: [],
    isDay: false,
    partyCount: 0,
    scandalScore: 0,
    closeKnotScore: 0,
    voteCount: 0,
    loveCount: 0,
    hateCount: 0,
    uiMessage: null,
    usedActions: {
      vote: {},
      love: {},
      hate: {},
      skills: {}
    }
  };
  await updateGameState(roomId, gameState);
  io.to(roomId).emit('gameStateUpdate', gameState);
  return gameState;
}

// Helper: Enable love/hate for eligible players
function enableLoveHateForEligiblePlayers(roomId) {
  // This is a client-side responsibility, but you can broadcast a state change if needed
  // For now, just broadcast the UI message
}

// Helper: Enable vote for all
function enableVoteForAll(roomId) {
  // This is a client-side responsibility, but you can broadcast a state change if needed
  // For now, just broadcast the UI message
}

// Helper: Can player vote?
function canPlayerVote(gameState, playerName) {
  return !gameState.usedActions.vote[playerName];
}

// Helper: Can player use skill?
function canPlayerUseSkill(gameState, playerName, skill) {
  const player = gameState.players.find(p => p.name === playerName);
  if (!player) return false;
  
  // Check if skill is already used
  if (gameState.usedActions.skills[playerName]?.[skill]) return false;
  
  // Role-specific skill checks
  switch (skill) {
    case 'molest':
      return player.role === 'Jack' && !gameState.isDay;
    case 'mislead':
      return player.role === 'Wind';
    case 'protectingparty':
      return player.role === 'Kennedi';
    case 'findabby':
      return player.role === 'Michael';
    case 'thechosenone':
      return player.role === 'Ker';
    default:
      return false;
  }
}

// Helper: Mark vote used
function markVoteUsed(gameState, playerName) {
  if (!gameState.usedActions.vote) gameState.usedActions.vote = {};
  gameState.usedActions.vote[playerName] = true;
}

// Helper: Mark love/hate used
function markLoveHateUsed(gameState, playerName, type) {
  if (!gameState.usedActions[type]) gameState.usedActions[type] = {};
  gameState.usedActions[type][playerName] = true;
}

// Helper: Mark skill used
function markSkillUsed(gameState, playerName, skill) {
  if (!gameState.usedActions.skills[playerName]) gameState.usedActions.skills[playerName] = {};
  gameState.usedActions.skills[playerName][skill] = true;
}

// Helper: Apply skill effect
function applySkillEffect(gameState, playerName, skill, extraData) {
  switch (skill) {
    case 'molest':
      gameState.scandalScore += 2;
      break;
    case 'mislead':
      // Flip love to hate
      const temp = gameState.loveCount;
      gameState.loveCount = gameState.hateCount;
      gameState.hateCount = temp;
      break;
    case 'protectingparty':
      // All helpers count as love
      gameState.loveCount += gameState.players.filter(p => p.role === 'Helper').length;
      break;
    case 'findabby':
      // Just show message, no effect on game state
      break;
    case 'thechosenone':
      // Helper swap is handled in the UI message
      break;
  }
}

// Socket.IO connection handler
io.on('connection', (socket) => {
  console.log('A user connected:', socket.id);

  // Host creates a room
  socket.on('createRoom', async ({ roomId, password, maxPlayers, hostName, roomName }, callback) => {
    console.log('[createRoom]', { roomId, password, maxPlayers, hostName, roomName });
    const exists = await redis.exists(`room:${roomId}`);
    if (exists) {
      console.log('[createRoom] Room already exists:', roomId);
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
  socket.on('joinRoom', async ({ roomId, playerName }, callback) => {
    console.log('[joinRoom]', { roomId, playerName });
    const room = await redis.hgetall(`room:${roomId}`);
    if (!room) {
      console.log('[joinRoom] Room not found:', roomId);
      return callback({ success: false, message: 'Room not found.' });
    }

    const players = JSON.parse(room.players || '[]');
    // Prevent duplicate player names
    const existingPlayer = players.find(p => p.name === playerName);
    if (existingPlayer) {
      console.log('[joinRoom] Duplicate player name:', playerName);
      return callback({ success: false, message: 'Player name already exists in this room.' });
    }
    if (players.length >= parseInt(room.maxPlayers)) {
      console.log('[joinRoom] Room is full:', roomId);
      return callback({ success: false, message: 'Room is full.' });
    }

    // Add new player
    players.push({ id: socket.id, name: playerName });
    await setPlayerList(roomId, players);
    socket.join(roomId);

    // If this is the last player, distribute roles
    if (players.length === parseInt(room.maxPlayers)) {
      const roles = distributeRoles(players.length);
      const gameState = await initializeGameState(roomId, players);
      
      // Assign roles to players
      gameState.players = gameState.players.map((player, index) => ({
        ...player,
        role: roles[index]
      }));
      
      await updateGameState(roomId, gameState);
      console.log('[initialGameState] Emitting for room:', roomId, gameState);
      io.to(roomId).emit('initialGameState', gameState);
    }

    callback({ success: true });
    io.to(roomId).emit('playerListUpdate', {
      players: players.map(p => p.name),
      roomName: room.roomName
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
      const gameState = await initializeGameState(roomId, players);
      
      // Emit game start with initial state
      io.to(roomId).emit('startGame', { gameState });
      
      // Start role distribution
      const roles = distributeRoles(players.length);
      gameState.roles = roles;
      await updateGameState(roomId, gameState);
      
      // Assign roles to players
      players.forEach((player, index) => {
        gameState.players[index].role = roles[index];
        gameState.players[index].position = index;
      });
      
      await updateGameState(roomId, gameState);
      io.to(roomId).emit('gameStateUpdate', gameState);
    }
  });

  // Main gameAction handler
  socket.on('gameAction', async ({ roomId, action, data, playerName }) => {
    const gameState = await getGameState(roomId);
    if (!gameState) return;
    const isHost = gameState.players.find(p => p.name === playerName)?.isHost;

    switch (action) {
      case 'switchDayNight':
        if (!isHost) return;
        gameState.isDay = data.isDay;
        await updateGameState(roomId, gameState);
        io.to(roomId).emit('gameStateUpdate', gameState);
        break;

      case 'updateCount':
        if (!isHost) return;
        if ([
          'party', 'scandal', 'closeKnot', 'vote'
        ].includes(data.countType)) {
          // Map countType to correct game state property names
          let key;
          switch (data.countType) {
            case 'party':
              key = 'partyCount';
              break;
            case 'scandal':
              key = 'scandalScore';
              break;
            case 'closeKnot':
              key = 'closeKnotScore';
              break;
            case 'vote':
              key = 'voteCount';
              break;
            default:
              return;
          }
          gameState[key] += data.delta;
          if (gameState[key] < 0) gameState[key] = 0;
          await updateGameState(roomId, gameState);
          io.to(roomId).emit('gameStateUpdate', gameState);
        }
        break;

      case 'restartGame':
        if (!isHost) return;
        await broadcastUIMessage(roomId, 'The game restarts!', 5000);
        setTimeout(async () => {
          const newGameState = await resetGameState(roomId);
          // Reset all counts to 0
          newGameState.partyCount = 0;
          newGameState.scandalScore = 0;
          newGameState.closeKnotScore = 0;
          newGameState.voteCount = 0;
          newGameState.loveCount = 0;
          newGameState.hateCount = 0;
          // Set to night mode
          newGameState.isDay = false;
          // Reset used actions
          newGameState.usedActions = {
            vote: {},
            love: {},
            hate: {},
            skills: {}
          };
          await updateGameState(roomId, newGameState);
          io.to(roomId).emit('gameStateUpdate', newGameState);
        }, 5000);
        break;

      case 'takeLoveHateAction':
        if (!isHost) return;
        await broadcastUIMessage(roomId, 'Host and helpers can do their love or hate action now!', 10000);
        break;

      case 'resetLoveHateCount':
        if (!isHost) return;
        await broadcastUIMessage(roomId, 'The action count is reset!', 5000);
        gameState.loveCount = 0;
        gameState.hateCount = 0;
        // Reset used love/hate actions
        gameState.usedActions.love = {};
        gameState.usedActions.hate = {};
        await updateGameState(roomId, gameState);
        io.to(roomId).emit('gameStateUpdate', gameState);
        break;

      case 'resetVote':
        if (!isHost) return;
        await broadcastUIMessage(roomId, 'Every player can vote now!', 10000);
        // Reset used vote actions
        gameState.usedActions.vote = {};
        await updateGameState(roomId, gameState);
        io.to(roomId).emit('gameStateUpdate', gameState);
        break;

      case 'vote':
        if (!canPlayerVote(gameState, playerName)) return;
        gameState.voteCount += 1;
        markVoteUsed(gameState, playerName);
        await updateGameState(roomId, gameState);
        io.to(roomId).emit('gameStateUpdate', gameState);
        break;

      case 'playLoveHate':
        if (!canPlayerLoveHate(gameState, playerName, data.type)) return;
        if (data.type === 'love') gameState.loveCount += 1;
        if (data.type === 'hate') gameState.hateCount += 1;
        markLoveHateUsed(gameState, playerName, data.type);
        await updateGameState(roomId, gameState);
        io.to(roomId).emit('gameStateUpdate', gameState);
        break;

      case 'useSkill':
        if (!canPlayerUseSkill(gameState, playerName, data.skill)) return;
        applySkillEffect(gameState, playerName, data.skill, data.extraData);
        markSkillUsed(gameState, playerName, data.skill);
        if (data.skill === 'findAbby') {
          await broadcastUIMessage(roomId, 'Michael thinks he has found Abby now!', 5000);
        }
        await updateGameState(roomId, gameState);
        io.to(roomId).emit('gameStateUpdate', gameState);
        break;

      case 'theChosenOne':
        if (playerName !== 'Ker') return;
        await broadcastUIMessage(roomId, `Ker swap ${data.oldHelper} helper to ${data.newHelper} as new helper!`, 10000);
        break;
    }
  });

  // Handle love/hate actions
  socket.on('loveHateAction', async ({ type, count }) => {
    const roomId = Array.from(socket.rooms)[1]; // Get room ID
    if (!roomId) return;

    const gameState = await getGameState(roomId);
    if (!gameState) return;

    // Update temporary counts
    if (type === 'love') {
      gameState.loveCount = count;
    } else {
      gameState.hateCount = count;
    }

    await updateGameState(roomId, gameState);
    
    // Broadcast updated counts to all players
    io.to(roomId).emit('updateLoveHateCount', {
      love: gameState.loveCount,
      hate: gameState.hateCount
    });

    // Show skill phase message
    await broadcastUIMessage(roomId, "Wind and Kennedi are allowed to use their skills right now!", 10000);
  });

  // Handle skill usage
  socket.on('useSkill', async ({ skill }) => {
    const roomId = Array.from(socket.rooms)[1];
    if (!roomId) return;

    const gameState = await getGameState(roomId);
    if (!gameState) return;

    const player = gameState.players.find(p => p.id === socket.id);
    if (!player) return;

    // Check if player can use the skill
    if (!canPlayerUseSkill(gameState, player.name, skill)) {
      return;
    }

    // Apply skill effect
    applySkillEffect(gameState, player.name, skill);

    // Mark skill as used
    markSkillUsed(gameState, player.name, skill);

    // Update game state
    await updateGameState(roomId, gameState);

    // Broadcast updated counts
    io.to(roomId).emit('updateLoveHateCount', {
      love: gameState.loveCount,
      hate: gameState.hateCount
    });

    // Show confirmation message
    await broadcastUIMessage(roomId, `${player.name} used their ${skill} skill!`, 3000);
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