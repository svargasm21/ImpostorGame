const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require("path");

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(express.static(path.join(__dirname, 'public')));
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

// Game state
let players = {}; // socketId -> { name, word, hint, ready }
let gameState = 'lobby'; // lobby | playing | roundResult
let rounds = [];
let currentRound = 0;
let impostorId = null;
let votes = {}; // socketId -> targetId ('blank' for blank vote)
let roundEliminated = []; // eliminated within current round only
let pendingTimeout = null; // track timeouts to avoid orphans

function broadcastLobby() {
  const playerList = Object.entries(players).map(([id, p]) => ({
    id, name: p.name, ready: p.ready
  }));
  io.emit('lobbyUpdate', { players: playerList, gameState });
}

function buildRounds() {
  rounds = [];
  Object.entries(players).forEach(([authorId, p]) => {
    if (p.word && p.hint) {
      rounds.push({ word: p.word, hint: p.hint, authorId });
    }
  });
  // Shuffle rounds
  for (let i = rounds.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [rounds[i], rounds[j]] = [rounds[j], rounds[i]];
  }
}

function getActivePlayers() {
  return Object.keys(players).filter(id => !roundEliminated.includes(id));
}

function startRound() {
  if (currentRound >= rounds.length) {
    // All rounds played - back to lobby
    goToLobby();
    return;
  }

  const round = rounds[currentRound];
  roundEliminated = []; // reset per-round eliminations
  const allPlayers = Object.keys(players);

  // Pick impostor: must not be the author of this round's word
  const eligible = allPlayers.filter(id => id !== round.authorId);
  if (eligible.length === 0) {
    impostorId = allPlayers[Math.floor(Math.random() * allPlayers.length)];
  } else {
    impostorId = eligible[Math.floor(Math.random() * eligible.length)];
  }

  votes = {};
  gameState = 'playing';

  // Send each player their role privately
  allPlayers.forEach(id => {
    const isImpostor = id === impostorId;
    io.to(id).emit('roundStart', {
      round: currentRound + 1,
      totalRounds: rounds.length,
      role: isImpostor ? 'impostor' : 'inocente',
      secret: isImpostor ? round.hint : round.word,
      players: allPlayers.map(pid => ({ id: pid, name: players[pid].name }))
    });
  });
}

function startVoting() {
  votes = {};
  gameState = 'playing';
  const active = getActivePlayers();
  io.emit('continueVoting', {
    players: active.map(id => ({ id, name: players[id].name }))
  });
}

function checkAllVoted() {
  const active = getActivePlayers();
  return active.every(id => votes[id]);
}

function tallyVotes() {
  const tally = {};
  Object.entries(votes).forEach(([voterId, targetId]) => {
    if (targetId === 'blank') return; // blank votes don't count
    tally[targetId] = (tally[targetId] || 0) + 1;
  });

  let maxVotes = 0;
  let votedOut = null;
  let isTie = false;

  Object.entries(tally).forEach(([id, count]) => {
    if (count > maxVotes) {
      maxVotes = count;
      votedOut = id;
      isTie = false;
    } else if (count === maxVotes) {
      isTie = true;
    }
  });

  // If all blank or tie, no one is voted out
  if (maxVotes === 0 || isTie) return null;
  return votedOut;
}

function processVoteResult() {
  const votedOut = tallyVotes();
  const round = rounds[currentRound];

  if (votedOut === null) {
    // Tie or all blank - re-vote
    io.emit('roundResult', {
      type: 'tie',
      message: 'Empate o todos votaron en blanco. ¡Voten de nuevo!'
    });
    pendingTimeout = setTimeout(() => startVoting(), 5000);
    return;
  }

  const wasImpostor = votedOut === impostorId;

  if (wasImpostor) {
    // Impostor caught! Innocents win this round.
    gameState = 'roundResult';
    const hasMoreRounds = (currentRound + 1) < rounds.length;

    io.emit('roundResult', {
      type: 'impostorCaught',
      votedOutId: votedOut,
      votedOutName: players[votedOut]?.name,
      impostorId,
      impostorName: players[impostorId]?.name,
      word: round.word,
      hint: round.hint,
      hasMoreRounds
    });

    currentRound++;
    if (hasMoreRounds) {
      pendingTimeout = setTimeout(() => startRound(), 10000);
    } else {
      pendingTimeout = setTimeout(() => goToLobby(), 12000);
    }
  } else {
    // Innocent voted out - eliminated for this round only
    roundEliminated.push(votedOut);
    const remaining = getActivePlayers();

    // Check if impostor wins (1v1 with one innocent)
    const impostorWins = remaining.length <= 2 && remaining.includes(impostorId);

    if (impostorWins) {
      gameState = 'roundResult';
      const hasMoreRounds = (currentRound + 1) < rounds.length;

      io.emit('roundResult', {
        type: 'impostorWins',
        votedOutId: votedOut,
        votedOutName: players[votedOut]?.name,
        impostorId,
        impostorName: players[impostorId]?.name,
        word: round.word,
        hint: round.hint,
        hasMoreRounds
      });

      currentRound++;
      if (hasMoreRounds) {
        pendingTimeout = setTimeout(() => startRound(), 10000);
      } else {
        pendingTimeout = setTimeout(() => goToLobby(), 12000);
      }
    } else {
      // Continue voting - impostor is still hidden
      io.emit('roundResult', {
        type: 'innocentOut',
        votedOutId: votedOut,
        votedOutName: players[votedOut]?.name
      });
      pendingTimeout = setTimeout(() => startVoting(), 10000);
    }
  }
}

function goToLobby() {
  gameState = 'lobby';
  roundEliminated = [];
  rounds = [];
  currentRound = 0;
  impostorId = null;
  votes = {};
  Object.keys(players).forEach(id => {
    players[id].word = '';
    players[id].hint = '';
    players[id].ready = false;
  });
  broadcastLobby();
}

io.on('connection', (socket) => {
  console.log('Connected:', socket.id);

  socket.on('join', ({ name, word, hint }) => {
    if (players[socket.id]) {
      players[socket.id].word = word.trim();
      players[socket.id].hint = hint.trim();
      players[socket.id].ready = false;
    } else {
      players[socket.id] = { name, word: word.trim(), hint: hint.trim(), ready: false };
    }
    broadcastLobby();
  });

  socket.on('setReady', (ready) => {
    if (players[socket.id]) {
      // Can't be ready without a word and hint
      if (ready && (!players[socket.id].word || !players[socket.id].hint)) {
        socket.emit('error', 'Debes poner una palabra y pista antes de estar listo.');
        return;
      }
      players[socket.id].ready = ready;
      broadcastLobby();
    }
  });

  socket.on('startGame', () => {
    if (gameState !== 'lobby') return;
    const allReady = Object.values(players).every(p => p.ready);
    if (!allReady || Object.keys(players).length < 3) {
      socket.emit('error', 'Todos deben estar listos y debe haber al menos 3 jugadores.');
      return;
    }
    currentRound = 0;
    roundEliminated = [];
    buildRounds();
    startRound();
  });

  socket.on('vote', (targetId) => {
    if (gameState !== 'playing') return;
    const active = getActivePlayers();
    if (!active.includes(socket.id)) return;
    if (votes[socket.id]) return; // no double vote

    // Validate target: must be 'blank' or an active player that isn't self
    if (targetId === 'blank') {
      votes[socket.id] = 'blank';
    } else if (active.includes(targetId) && targetId !== socket.id) {
      votes[socket.id] = targetId;
    } else {
      return;
    }

    const voteCount = Object.keys(votes).length;
    io.emit('voteUpdate', { voteCount, total: active.length });

    if (checkAllVoted()) {
      // Small delay then process
      pendingTimeout = setTimeout(() => processVoteResult(), 3000);
    }
  });

  socket.on('disconnect', () => {
    if (players[socket.id]) {
      const wasInGame = gameState !== 'lobby';
      const wasImpostorPlayer = socket.id === impostorId;
      delete players[socket.id];

      const remainingPlayers = Object.keys(players);
      if (remainingPlayers.length === 0) {
        if (pendingTimeout) clearTimeout(pendingTimeout);
        pendingTimeout = null;
        gameState = 'lobby';
        players = {};
        rounds = [];
        currentRound = 0;
        roundEliminated = [];
        votes = {};
        impostorId = null;
      } else if (wasInGame) {
        delete votes[socket.id];
        // Remove votes targeting disconnected player
        Object.keys(votes).forEach(voterId => {
          if (votes[voterId] === socket.id) delete votes[voterId];
        });

        if (wasImpostorPlayer) {
          if (pendingTimeout) clearTimeout(pendingTimeout);
          const hasMoreRounds = (currentRound + 1) < rounds.length;
          io.emit('roundResult', {
            type: 'impostorCaught',
            votedOutId: null,
            votedOutName: 'El impostor (desconectado)',
            impostorId: null,
            impostorName: 'Desconectado',
            word: rounds[currentRound]?.word,
            hint: rounds[currentRound]?.hint,
            hasMoreRounds
          });
          currentRound++;
          if (hasMoreRounds && remainingPlayers.length >= 3) {
            pendingTimeout = setTimeout(() => startRound(), 5000);
          } else {
            pendingTimeout = setTimeout(() => goToLobby(), 5000);
          }
        } else if (remainingPlayers.length < 3) {
          if (pendingTimeout) clearTimeout(pendingTimeout);
          pendingTimeout = setTimeout(() => goToLobby(), 3000);
        } else if (gameState === 'playing') {
          // Check if all remaining active have voted
          const active = getActivePlayers();
          io.emit('activePlayers', active.map(id => ({ id, name: players[id].name })));
          if (checkAllVoted()) {
            pendingTimeout = setTimeout(() => processVoteResult(), 3000);
          }
        }
      }
      broadcastLobby();
    }
    console.log('Disconnected:', socket.id);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
