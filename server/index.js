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
  if (playerCount === 5) {
    // 2 Cheaters, 3 Keepers (including 1 Pet)
    roles.push('Michael', 'Wind', 'Abby', 'Kennedi', 'Kiko');
  } else if (playerCount === 6) {
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
  const room = await redis.hgetall(`room:${roomId}`);
  const hostName = room && room.hostName ? room.hostName : (players[0]?.name || '');
  const gameState = {
    players: players.map(p => ({
      id: p.id,
      name: p.name,
      role: null,  // Will be assigned during role distribution
      position: null,  // Will be assigned during setup
      isHost: p.name === hostName,
      isPartyHost: false  // Initialize party host status
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
  
  // Redistribute roles randomly
  const roles = distributeRoles(players.length);
  
  const hostName = room && room.hostName ? room.hostName : (players[0]?.name || '');
  const gameState = {
    players: players.map((p, index) => ({
      id: p.id,
      name: p.name,
      role: roles[index], // Assign new random role
      position: index,
      isHost: p.name === hostName,
      isPartyHost: false // Reset party host status
    })),
    roles: roles, // Store the new role distribution
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
      return player.role === 'Wind' && !gameState.isDay;
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
      // Effect will be applied during resolution phase, not here
      break;
    case 'protectingparty':
      // Effect will be applied during resolution phase, not here
      break;
    case 'findabby':
      // Just show message, no effect on game state
      break;
    case 'thechosenone':
      // Helper swap is handled in the UI message
      break;
  }
}

// --- Action/Skill Phase State ---
const actionPhaseState = {};

// --- Voice Chat State Management ---
const voiceChatState = {};

// --- Sequential Voice Chat Joining Queue ---
const voiceChatJoinQueue = {};

// Game state
const rooms = {};
const readyStates = {};
const gameStates = {};
const partyHosts = {}; // Add this line to store party hosts for each room

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
    // Don't add host to player list yet - they will join like any other player
    const players = [];
    const readyStates = {};
    await redis.hmset(`room:${roomId}`,
      'password', password,
      'maxPlayers', maxPlayers,
      'roomName', roomName || '',
      'players', JSON.stringify(players),
      'readyStates', JSON.stringify(readyStates),
      'hostName', hostName // Store host name for later host assignment
    );
    socket.join(roomId);
    callback({ success: true });
    io.to(roomId).emit('playerListUpdate', {
      players: players.map(p => p.name),
      roomName: roomName,
      password: password,
      readyStates: readyStates,
      maxPlayers: maxPlayers
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

    let players = JSON.parse(room.players || '[]');
    let isReconnect = false;
    // Check if player already exists in the room (reconnection scenario)
    const existingPlayerIndex = players.findIndex(p => p.name === playerName);
    if (existingPlayerIndex !== -1) {
      // Player exists, update their socket ID (reconnection)
      console.log('[joinRoom] Player reconnecting:', playerName);
      players[existingPlayerIndex].id = socket.id;
      // Clean up disconnected state
      delete players[existingPlayerIndex].disconnectedAt;
      isReconnect = true;
    } else {
      if (players.length >= parseInt(room.maxPlayers)) {
        console.log('[joinRoom] Room is full:', roomId);
        return callback({ success: false, message: 'Room is full.' });
      }
      // Add new player
      players.push({ id: socket.id, name: playerName });
    }
    await setPlayerList(roomId, players);
    socket.join(roomId);
    // Log the full player list after join
    console.log(`[joinRoom] Player list for room ${roomId}:`, players.map(p => ({ name: p.name, id: p.id })));

    // Always check and emit the latest game state if roles are assigned
    let gameState = await getGameState(roomId);
    if (gameState && gameState.players) {
      // Update socket ID in gameState.players for this player
      const gsPlayerIdx = gameState.players.findIndex(p => p.name === playerName);
      if (gsPlayerIdx !== -1) {
        gameState.players[gsPlayerIdx].id = socket.id;
        await updateGameState(roomId, gameState);
      }
    }
    gameState = await getGameState(roomId);
    if (gameState && gameState.players && gameState.players.every(p => p.role)) {
      socket.emit('initialGameState', gameState);
    } else if (!isReconnect && players.length === parseInt(room.maxPlayers)) {
      // Wait 2 seconds before assigning roles
      setTimeout(async () => {
        // Re-fetch the latest player list
        const roomCheck = await redis.hgetall(`room:${roomId}`);
        const playersCheck = JSON.parse(roomCheck.players || '[]');
        // Only assign roles if all players are still present and connected
        const allConnected = playersCheck.length === parseInt(room.maxPlayers) && playersCheck.every(p => p.id);
        if (!allConnected) {
          console.log(`[joinRoom] Not all players connected after grace period in room ${roomId}. Waiting to assign roles.`);
          return;
        }
        const roles = distributeRoles(playersCheck.length);
        const newGameState = await initializeGameState(roomId, playersCheck);
        newGameState.players = newGameState.players.map((player, index) => ({
          ...player,
          role: roles[index]
        }));
        // Update socket IDs in gameState.players
        newGameState.players.forEach((p, idx) => {
          const matchingPlayer = playersCheck.find(pl => pl.name === p.name);
          if (matchingPlayer) newGameState.players[idx].id = matchingPlayer.id;
        });
        await updateGameState(roomId, newGameState);
        io.to(roomId).emit('initialGameState', newGameState);
        console.log(`[joinRoom] Roles assigned after grace period for room ${roomId}:`, newGameState.players.map(p => ({ name: p.name, role: p.role, id: p.id })));
      }, 2000);
    }

    callback({ success: true });
    io.to(roomId).emit('playerListUpdate', {
      players: players.map(p => p.name),
      roomName: room.roomName,
      password: room.password,
      readyStates: room.readyStates,
      maxPlayers: room.maxPlayers
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
      readyStates: readyStates,
      maxPlayers: room.maxPlayers
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
      const hostName = room && room.hostName ? room.hostName : (players[0]?.name || '');
      const gameState = await initializeGameState(roomId, players);
      // Emit game start with initial state
      io.to(roomId).emit('startGame', { gameState });
      // Start role distribution
      const roles = distributeRoles(players.length);
      gameState.roles = roles;
      // Assign roles to players
      players.forEach((player, index) => {
        gameState.players[index].role = roles[index];
        gameState.players[index].position = index;
        gameState.players[index].isHost = player.name === hostName;
        // Always update socket ID in gameState.players to match player list
        const matchingPlayer = players.find(p => p.name === gameState.players[index].name);
        if (matchingPlayer) {
          gameState.players[index].id = matchingPlayer.id;
        }
      });
      await updateGameState(roomId, gameState);
      // Log the full gameState.players after roles are assigned
      console.log(`[startGame] gameState.players for room ${roomId}:`, gameState.players.map(p => ({ name: p.name, role: p.role, id: p.id })));
      io.to(roomId).emit('gameStateUpdate', gameState);
      io.to(roomId).emit('initialGameState', gameState);

      // When starting game, initialize empty party hosts
      partyHosts[roomId] = [];
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
          // Clear any ongoing action phase state
          if (actionPhaseState[roomId]) {
            clearTimeout(actionPhaseState[roomId].skillWindowTimer);
            clearTimeout(actionPhaseState[roomId].resolveTimer);
            delete actionPhaseState[roomId];
          }
          
          // Reset game state with new role distribution
          const newGameState = await resetGameState(roomId);
          
          // Ensure all counts are reset to 0
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
          
          // Update and broadcast the new game state
          await updateGameState(roomId, newGameState);
          io.to(roomId).emit('gameStateUpdate', newGameState);
          
          // Inform players that roles have been redistributed
          await broadcastUIMessage(roomId, 'Game restarted! Roles have been redistributed randomly.', 8000);
          
          console.log('[restartGame] Game restarted with new roles:', newGameState.players.map(p => ({ name: p.name, role: p.role })));
        }, 5000);
        break;

      case 'takeLoveHateAction': {
        if (!isHost) return;
        // Start first 10s window
        if (!actionPhaseState[roomId]) {
          actionPhaseState[roomId] = {
            phase: 1,
            loveClicks: {},
            hateClicks: {},
            windUsed: false,
            kennediUsed: false,
            skillWindowTimer: null,
            resolveTimer: null
          };
        }
        await broadcastUIMessage(roomId, 'Host and helpers can do their action right now!', 10000);
        // After 10s, if no one clicked, auto-start skill window
        actionPhaseState[roomId].skillWindowTimer = setTimeout(() => {
          startSkillWindow(roomId);
        }, 10000);
        break;
      }

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

      case 'useSkill':
        console.log('[useSkill] Received skill action:', { playerName, skill: data.skill });
        if (!canPlayerUseSkill(gameState, playerName, data.skill)) {
          console.log('[useSkill] Player cannot use skill:', { playerName, skill: data.skill });
          return;
        }
        applySkillEffect(gameState, playerName, data.skill, data.extraData);
        markSkillUsed(gameState, playerName, data.skill);
        
        // Send specific UI messages for certain skills
        if (data.skill === 'molest') {
          console.log('[useSkill] Sending molest UI message');
          await broadcastUIMessage(roomId, "The priest Wind decide to molest a boy tonight, it is worse than cheating, so scandal score +2 plz!", 10000);
        } else if (data.skill === 'findabby') {
          console.log('[useSkill] Sending findabby UI message');
          await broadcastUIMessage(roomId, "Michael think he find abby now!", 10000);
        }
        
        await updateGameState(roomId, gameState);
        io.to(roomId).emit('gameStateUpdate', gameState);
        break;

      case 'theChosenOne':
        if (!canPlayerUseSkill(gameState, playerName, 'thechosenone')) return;
        markSkillUsed(gameState, playerName, 'thechosenone');
        await broadcastUIMessage(roomId, `Ker swap ${data.oldHelper} helper to ${data.newHelper} as new helper!`, 10000);
        await updateGameState(roomId, gameState);
        io.to(roomId).emit('gameStateUpdate', gameState);
        break;
    }
  });

  // --- Love/Hate Click Handler ---
  socket.on('loveHateAction', async ({ type }) => {
    const roomId = Array.from(socket.rooms)[1];
    if (!roomId) return;
    const player = (await getGameState(roomId)).players.find(p => p.id === socket.id);
    if (!player) return;
    if (!actionPhaseState[roomId]) return;
    // Only allow one click per player per phase
    if (actionPhaseState[roomId].loveClicks[player.name] || actionPhaseState[roomId].hateClicks[player.name]) return;
    if (type === 'love') {
      actionPhaseState[roomId].loveClicks[player.name] = true;
    } else {
      actionPhaseState[roomId].hateClicks[player.name] = true;
    }
    // If in phase 1, start skill window immediately
    if (actionPhaseState[roomId].phase === 1) {
      actionPhaseState[roomId].phase = 2;
      clearTimeout(actionPhaseState[roomId].skillWindowTimer);
      startSkillWindow(roomId);
    }
  });

  // --- Skill Use Handler ---
  socket.on('useSkill', async ({ skill }) => {
    const roomId = Array.from(socket.rooms)[1];
    if (!roomId) return;
    const gameState = await getGameState(roomId);
    if (!gameState) return;
    const player = gameState.players.find(p => p.id === socket.id);
    if (!player) return;
    if (!actionPhaseState[roomId] || actionPhaseState[roomId].phase !== 2) return;
    
    console.log('[useSkill socket] Player using skill:', { playerName: player.name, skill });
    
    // Only allow Wind and Kennedi to use their skills during skill window
    if (player.role === 'Wind' && skill === 'mislead') {
      actionPhaseState[roomId].windUsed = true;
      console.log('[useSkill socket] Wind used Mislead');
    }
    if (player.role === 'Kennedi' && skill === 'protectingparty') {
      actionPhaseState[roomId].kennediUsed = true;
      console.log('[useSkill socket] Kennedi used Protecting Party');
    }
    
    // Mark skill as used in gameState (so button disables)
    markSkillUsed(gameState, player.name, skill);
    await updateGameState(roomId, gameState);
  });

  // --- Start Skill Window ---
  async function startSkillWindow(roomId) {
    if (!actionPhaseState[roomId]) return;
    actionPhaseState[roomId].phase = 2;
    broadcastUIMessage(roomId, 'Host and helpers please take your action, and Wind and Kennedi can use their skills now!', 10000);
    // After 10s, resolve all actions
    actionPhaseState[roomId].resolveTimer = setTimeout(() => {
      resolveActionPhase(roomId);
    }, 10000);
  }

  // --- Resolve All Actions ---
  async function resolveActionPhase(roomId) {
    const state = actionPhaseState[roomId];
    if (!state) return;
    const gameState = await getGameState(roomId);
    if (!gameState) return;
    
    console.log('[resolveActionPhase] Starting resolution with state:', state);
    
    // Calculate base love/hate counts from clicks
    let love = Object.keys(state.loveClicks).length;
    let hate = Object.keys(state.hateClicks).length;
    
    console.log('[resolveActionPhase] Base counts - Love:', love, 'Hate:', hate);
    console.log('[resolveActionPhase] Skills used - Wind:', state.windUsed, 'Kennedi:', state.kennediUsed);
    
    // Apply skills in correct order (Wind's skill takes precedence if both are used)
    if (state.windUsed && state.kennediUsed) {
      // Both skills used - Wind's skill wins
      console.log('[resolveActionPhase] Both skills used - Wind takes precedence');
      if (love > 0) {
        love -= 1;
        hate += 1;
        console.log('[resolveActionPhase] Wind Mislead applied: Love ->', love, 'Hate ->', hate);
      }
    } else if (state.windUsed) {
      // Only Wind used Mislead: convert one love to hate (if any love exists)
      console.log('[resolveActionPhase] Only Wind used Mislead');
      if (love > 0) {
        love -= 1;
        hate += 1;
        console.log('[resolveActionPhase] Wind Mislead applied: Love ->', love, 'Hate ->', hate);
      }
    } else if (state.kennediUsed) {
      // Only Kennedi used Protecting Party: all hate becomes love
      console.log('[resolveActionPhase] Only Kennedi used Protecting Party');
      if (hate > 0) {
        love += hate;
        hate = 0;
        console.log('[resolveActionPhase] Kennedi Protecting Party applied: Love ->', love, 'Hate ->', hate);
      }
    }
    
    // Update the game state with final counts
    gameState.loveCount = love;
    gameState.hateCount = hate;
    
    console.log('[resolveActionPhase] Final counts - Love:', love, 'Hate:', hate);
    
    await updateGameState(roomId, gameState);
    io.to(roomId).emit('gameStateUpdate', gameState);
    
    // Reset phase state
    clearTimeout(state.skillWindowTimer);
    clearTimeout(state.resolveTimer);
    delete actionPhaseState[roomId];
    
    console.log('[resolveActionPhase] Resolution complete');
  }

  // --- Voice Chat Event Handlers ---
  
  // Player joins voice chat
  socket.on('voiceChat:join', async ({ roomId, playerName }) => {
    console.log('[voiceChat:join]', { roomId, playerName });
    
    // Initialize queue for this room if it doesn't exist
    if (!voiceChatJoinQueue[roomId]) {
      voiceChatJoinQueue[roomId] = {
        queue: [],
        processing: false,
        currentPlayer: null
      };
    }
    
    const queue = voiceChatJoinQueue[roomId];
    
    // Add player to queue
    queue.queue.push({ socketId: socket.id, playerName });
    console.log('[voiceChat:join] Added to queue:', { roomId, playerName, queueLength: queue.queue.length });
    
    // Notify player they're in queue
    socket.emit('voiceChat:joinStatus', { 
      status: 'queued', 
      position: queue.queue.length,
      message: `You are #${queue.queue.length} in the voice chat queue` 
    });
    
    // Process queue if not already processing
    if (!queue.processing) {
      processVoiceChatQueue(roomId);
    }
  });
  
  // Process voice chat join queue sequentially
  async function processVoiceChatQueue(roomId) {
    const queue = voiceChatJoinQueue[roomId];
    if (!queue || queue.processing || queue.queue.length === 0) {
      return;
    }
    
    queue.processing = true;
    
    while (queue.queue.length > 0) {
      const { socketId, playerName } = queue.queue.shift();
      queue.currentPlayer = playerName;
      
      console.log('[voiceChat:join] Processing player:', { roomId, playerName });
      
      // Initialize voice chat state for room if needed
      if (!voiceChatState[roomId]) {
        voiceChatState[roomId] = {
          participants: {},
          audioSessions: {}
        };
      }
      
      // Add player to voice chat state
      voiceChatState[roomId].participants[playerName] = {
        socketId: socketId,
        isMuted: true, // Start muted by default
        audioStream: null,
        joinedAt: Date.now()
      };
      
      // Notify the specific player they can join
      io.to(socketId).emit('voiceChat:joinStatus', { 
        status: 'joining', 
        message: 'Initializing voice chat...' 
      });
      
      // Notify other players in room
      socket.to(roomId).emit('voiceChat:playerJoined', { playerName });
      
      // Send current participants to the joining player
      const participants = Object.keys(voiceChatState[roomId].participants);
      io.to(socketId).emit('voiceChat:participantsList', { participants });
      
      console.log('[voiceChat:join] Player joined voice chat:', { roomId, playerName, totalParticipants: participants.length });
      
      // Wait 2 seconds before processing next player to prevent race conditions
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
    
    queue.processing = false;
    queue.currentPlayer = null;
    console.log('[voiceChat:join] Queue processing complete for room:', roomId);
  }

  // Player leaves voice chat
  socket.on('voiceChat:leave', async ({ roomId, playerName }) => {
    console.log('[voiceChat:leave]', { roomId, playerName });
    
    if (voiceChatState[roomId]?.participants[playerName]) {
      delete voiceChatState[roomId].participants[playerName];
      
      // Clean up room if empty
      if (Object.keys(voiceChatState[roomId].participants).length === 0) {
        delete voiceChatState[roomId];
      }
      
      // Notify other players
      socket.to(roomId).emit('voiceChat:playerLeft', { playerName });
      
      console.log('[voiceChat:leave] Player left voice chat:', { roomId, playerName });
    }
  });

  // Player toggles mute
  socket.on('voiceChat:toggleMute', async ({ roomId, playerName, isMuted }) => {
    console.log('[voiceChat:toggleMute]', { roomId, playerName, isMuted });
    
    if (voiceChatState[roomId]?.participants[playerName]) {
      voiceChatState[roomId].participants[playerName].isMuted = isMuted;
      
      // Notify other players
      socket.to(roomId).emit('voiceChat:playerMuteChanged', { playerName, isMuted });
      
      console.log('[voiceChat:toggleMute] Player mute changed:', { roomId, playerName, isMuted });
    }
  });

  // WebRTC signaling - Offer
  socket.on('voiceChat:offer', ({ roomId, targetPlayer, offer }) => {
    console.log('[voiceChat:offer]', { roomId, targetPlayer });
    
    const targetSocketId = voiceChatState[roomId]?.participants[targetPlayer]?.socketId;
    if (targetSocketId) {
      socket.to(targetSocketId).emit('voiceChat:offer', { 
        from: socket.id, 
        offer,
        roomId 
      });
    }
  });

  // WebRTC signaling - Answer
  socket.on('voiceChat:answer', ({ roomId, targetPlayer, answer }) => {
    console.log('[voiceChat:answer]', { roomId, targetPlayer });
    
    const targetSocketId = voiceChatState[roomId]?.participants[targetPlayer]?.socketId;
    if (targetSocketId) {
      socket.to(targetSocketId).emit('voiceChat:answer', { 
        from: socket.id, 
        answer,
        roomId 
      });
    }
  });

  // WebRTC signaling - ICE Candidate
  socket.on('voiceChat:iceCandidate', ({ roomId, targetPlayer, candidate }) => {
    const targetSocketId = voiceChatState[roomId]?.participants[targetPlayer]?.socketId;
    if (targetSocketId) {
      socket.to(targetSocketId).emit('voiceChat:iceCandidate', { 
        from: socket.id, 
        candidate,
        roomId 
      });
    }
  });

  // Get voice chat participants
  socket.on('voiceChat:getParticipants', ({ roomId }) => {
    const participants = voiceChatState[roomId]?.participants || {};
    const participantList = Object.keys(participants);
    socket.emit('voiceChat:participantsList', { participants: participantList });
  });

  // Handle disconnect
  socket.on('disconnect', async () => {
    console.log('User disconnected:', socket.id);
    
    // Clean up voice chat state
    for (const [roomId, roomState] of Object.entries(voiceChatState)) {
      for (const [playerName, participant] of Object.entries(roomState.participants)) {
        if (participant.socketId === socket.id) {
          delete roomState.participants[playerName];
          
          // Clean up room if empty
          if (Object.keys(roomState.participants).length === 0) {
            delete voiceChatState[roomId];
          } else {
            // Notify other players
            io.to(roomId).emit('voiceChat:playerLeft', { playerName });
          }
          
          console.log('[voiceChat:disconnect] Cleaned up voice chat for:', { roomId, playerName });
          break;
        }
      }
    }
    
    // Clean up voice chat join queue
    for (const [roomId, queue] of Object.entries(voiceChatJoinQueue)) {
      const playerIndex = queue.queue.findIndex(item => item.socketId === socket.id);
      if (playerIndex !== -1) {
        const removedPlayer = queue.queue.splice(playerIndex, 1)[0];
        console.log('[voiceChat:disconnect] Removed from queue:', { roomId, playerName: removedPlayer.playerName });
        
        // Clean up queue if empty
        if (queue.queue.length === 0 && !queue.processing) {
          delete voiceChatJoinQueue[roomId];
        }
      }
    }
    
    // Find all rooms (scan keys) - but don't immediately remove players
    // Give them a grace period to reconnect (for page transitions)
    const keys = await redis.keys('room:*');
    for (const key of keys) {
      const roomId = key.split(':')[1];
      const room = await redis.hgetall(key);
      let players = JSON.parse(room.players || '[]');
      let readyStates = JSON.parse(room.readyStates || '{}');
      const idx = players.findIndex(p => p.id === socket.id);
      if (idx !== -1) {
        const playerName = players[idx].name;
        
        // Mark player as disconnected but keep them in the room for a grace period
        players[idx].disconnectedAt = Date.now();
        players[idx].id = null; // Clear socket ID to indicate disconnected state
        
        await setPlayerList(roomId, players);
        
        // Schedule removal after 30 seconds if they don't reconnect
        setTimeout(async () => {
          const currentRoom = await redis.hgetall(`room:${roomId}`);
          if (currentRoom) {
            const currentPlayers = JSON.parse(currentRoom.players || '[]');
            const playerStillDisconnected = currentPlayers.find(p => 
              p.name === playerName && p.id === null && 
              p.disconnectedAt && (Date.now() - p.disconnectedAt) > 30000
            );
            
            if (playerStillDisconnected) {
              // Remove the player after grace period
              const updatedPlayers = currentPlayers.filter(p => p.name !== playerName);
              const updatedReadyStates = JSON.parse(currentRoom.readyStates || '{}');
              delete updatedReadyStates[playerName];
              
              if (updatedPlayers.length === 0) {
                // Room is empty, delete it
                await deleteRoom(roomId);
                console.log('Room deleted after grace period:', roomId);
              } else {
                // Update room with remaining players
                await setPlayerList(roomId, updatedPlayers);
                await redis.hset(`room:${roomId}`, 'readyStates', JSON.stringify(updatedReadyStates));
                io.to(roomId).emit('playerListUpdate', {
                  players: updatedPlayers.map(p => p.name),
                  roomName: currentRoom.roomName,
                  password: currentRoom.password,
                  readyStates: updatedReadyStates,
                  maxPlayers: currentRoom.maxPlayers
                });
                console.log('Player removed after grace period:', { roomId, playerName });
              }
            }
          }
        }, 30000); // 30 second grace period
        
        break;
      }
    }

    // When game ends or room is deleted, clean up party hosts
    delete partyHosts[roomId];

    // Party host selection handlers
    socket.on('togglePartyHost', async (data) => {
      const roomId = Object.keys(socket.rooms)[1];
      if (!roomId) return;

      const gameState = await getGameState(roomId);
      if (!gameState) return;

      // Only allow the room host to toggle party hosts
      const currentPlayer = gameState.players.find(p => p.id === socket.id);
      if (!currentPlayer || !currentPlayer.isHost) return;

      // Toggle party host status for the selected player
      const targetPlayer = gameState.players.find(p => p.name === data.playerName);
      if (targetPlayer) {
        targetPlayer.isPartyHost = !targetPlayer.isPartyHost;
        await updateGameState(roomId, gameState);
        
        // Broadcast the update to all players in the room
        io.to(roomId).emit('partyHostsUpdate', gameState.players);
        io.to(roomId).emit('gameStateUpdate', gameState);
      }
    });

    socket.on('resetPartyHosts', async () => {
      const roomId = Object.keys(socket.rooms)[1];
      if (!roomId) return;

      const gameState = await getGameState(roomId);
      if (!gameState) return;

      // Only allow the room host to reset party hosts
      const currentPlayer = gameState.players.find(p => p.id === socket.id);
      if (!currentPlayer || !currentPlayer.isHost) return;

      // Reset party host status for all players
      gameState.players.forEach(p => p.isPartyHost = false);
      await updateGameState(roomId, gameState);
      
      // Broadcast the update to all players in the room
      io.to(roomId).emit('partyHostsUpdate', gameState.players);
      io.to(roomId).emit('gameStateUpdate', gameState);
    });
  });

  // Handle party hosts update
  socket.on('updatePartyHosts', ({ roomId, hosts }) => {
    if (!rooms[roomId]) return;
    
    partyHosts[roomId] = hosts;
    io.to(roomId).emit('partyHostsUpdate', { hosts });
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));