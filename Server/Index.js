import express from "express";
import http from "http";
import { Server } from "socket.io";
import cors from "cors";
import { dealCards, getTrump } from "./gameLogic.js";
import { calculateAIBid, selectAICard } from "./aiLogic.js";

const app = express();
app.use(cors());

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] },
});

const rooms = {};

// ===== Helper Functions =====
function rankToValue(rank) {
  const order = ["2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K", "A"];
  return order.indexOf(rank);
}

function suitValue(suit) {
  const order = ["Spades", "Hearts", "Diamonds", "Clubs"];
  return order.indexOf(suit);
}

function sortHand(cards) {
  return cards.sort((a, b) => {
    const s = suitValue(a.suit) - suitValue(b.suit);
    return s !== 0 ? s : rankToValue(a.rank) - rankToValue(b.rank);
  });
}

function determineTrickWinner(trick, trump) {
  const leadSuit = trick[0].card.suit;
  let winning = trick[0];
  for (const play of trick) {
    const c = play.card;
    if (c.suit === winning.card.suit && rankToValue(c.rank) > rankToValue(winning.card.rank)) {
      winning = play;
    } else if (c.suit === trump && winning.card.suit !== trump) {
      winning = play;
    }
  }
  return winning.playerId;
}

function buildRoundSequence(playerCount) {
  const maxCards = Math.floor(52 / playerCount);
  const seq = [];
  for (let i = maxCards; i >= 1; i--) seq.push(i);
  for (let i = 1; i < playerCount; i++) seq.push(1);
  for (let i = 2; i <= maxCards; i++) seq.push(i);
  return seq;
}

function getBiddingOrder(players, roundIndex) {
  const dealerIndex = roundIndex % players.length;
  const order = [];
  for (let i = 1; i <= players.length; i++) {
    order.push(players[(dealerIndex + i) % players.length].id);
  }
  return order;
}

function getFullGameState(room) {
  return {
    roundIndex: room.roundIndex,
    trumpIndex: room.trumpIndex,
    roundSequence: room.roundSequence,
    hands: room.hands,
    bids: room.bids,
    tricksWon: room.tricksWon,
    scores: room.scores,
    playOrder: room.playOrder,
    currentTrick: room.currentTrick,
    currentBidder: room.biddingOrder?.[room.currentBidIndex],
    currentPlayer: room.playOrder?.[room.currentTurnIndex],
    phase:
      room.biddingOrder?.length > 0 && Object.keys(room.bids).length < room.players.length
        ? "bidding"
        : "play",
  };
}

// ===== SHARED CARD PLAYING LOGIC =====
function handleCardPlay(roomCode, room, playerId, card) {
  const playerHand = room.hands[playerId];
  if (!playerHand) return false;

  const leadSuit = room.currentTrick[0]?.card.suit;
  const hasLeadSuit = leadSuit && playerHand.some((c) => c.suit === leadSuit);

  if (leadSuit && card.suit !== leadSuit && hasLeadSuit) {
    return false; // Invalid play
  }

  room.hands[playerId] = playerHand.filter(
    (c) => !(c.rank === card.rank && c.suit === card.suit)
  );

  room.currentTrick.push({ playerId, card });
  if (room.currentTrick.length === 1) room.leadSuit = card.suit;

  io.to(roomCode).emit("cardPlayed", { trick: room.currentTrick });
  // Add a small delay before sending handUpdate to ensure cardPlayed is processed first
  setTimeout(() => {
    io.to(roomCode).emit("handUpdate", room.hands);
  }, 100);

  if (room.currentTrick.length === room.players.length) {
    const trump = getTrump(room.trumpIndex % 5);
    const winner = determineTrickWinner(room.currentTrick, trump);
    room.tricksWon[winner] = (room.tricksWon[winner] || 0) + 1;

    // Determine next player (winner leads next trick)
    let nextPlayer = winner; // Default to winner
    if (room.playOrder && Array.isArray(room.playOrder)) {
      const winnerIndex = room.playOrder.indexOf(winner);
      nextPlayer = winnerIndex !== -1 ? winner : (room.playOrder[0] || winner);
    }
    
    io.to(roomCode).emit("trickComplete", { winner, tricksWon: room.tricksWon, nextPlayer });
    room.currentTrick = [];
    room.leadSuit = null;

    const cardsLeft = Object.values(room.hands).reduce((sum, hand) => sum + hand.length, 0);
    if (cardsLeft === 0) {
      room.scores = room.scores || {};
      for (const player of room.players) {
        const id = player.id;
        const tricks = room.tricksWon[id] || 0;
        const bid = room.bids[id] || 0;
        const metBid = tricks === bid;
        const roundScore = metBid ? 10 + tricks : tricks;
        room.scores[id] = (room.scores[id] || 0) + roundScore;
      }

      io.to(roomCode).emit("roundOver", {
        tricksWon: room.tricksWon,
        bids: room.bids,
        scores: room.scores,
        roundNumber: `${room.roundIndex + 1}/${room.roundSequence.length}`,
        cardsThisRound: room.roundSequence[room.roundIndex],
        trump: getTrump(room.trumpIndex % 5),
        buriedCards: room.buriedCards || [],
      });

      room.roundIndex++;
      room.trumpIndex++;
      if (room.roundIndex >= room.roundSequence.length) {
        io.to(roomCode).emit("gameOver", { 
          scores: room.scores,
          tricksWon: room.tricksWon,
          bids: room.bids,
        });
        return true; // Game over
      }

      const nextRoundNumber = room.roundSequence[room.roundIndex];
      const nextTrump = getTrump(room.trumpIndex % 5);
      const { hands: newHands, buriedCards: newBuriedCards } = dealCards(room.players, nextRoundNumber);
      for (const pid in newHands) newHands[pid] = sortHand(newHands[pid]);

      room.hands = newHands;
      room.buriedCards = newBuriedCards;
      room.tricksWon = Object.fromEntries(room.players.map((p) => [p.id, 0]));
      room.currentTrick = [];
      room.leadSuit = null;
      room.bids = {};

      const playerCount = room.players.length;
      const dealerIndex = room.roundIndex % playerCount;
      room.biddingOrder = [];
      for (let i = 1; i <= playerCount; i++) {
        room.biddingOrder.push(room.players[(dealerIndex + i) % playerCount].id);
      }
      room.currentBidIndex = 0;

      for (const player of room.players) {
        const psocket = player.socketId;
        if (!psocket) continue;
        io.to(psocket).emit("roundStarted", {
          displayRound: `${room.roundIndex + 1}/${room.roundSequence.length}`,
          cardsThisRound: nextRoundNumber,
          trump: nextTrump,
          hands: { [player.id]: newHands[player.id] },
          currentBidder: room.biddingOrder[0],
        });
      }

      io.to(roomCode).emit("startBidding", {
        round: `${room.roundIndex + 1}/${room.roundSequence.length}`,
        trump: nextTrump,
        currentBidder: room.biddingOrder[0],
      });
      
      processAIBid(roomCode, room);
      return true; // Round over, new round started
    }

    if (room.playOrder && Array.isArray(room.playOrder)) {
      const winnerIndex = room.playOrder.indexOf(winner);
      if (winnerIndex === -1) {
        console.error(`❌ Winner ${winner} not found in playOrder!`, room.playOrder);
        // Fallback: use first player
        room.currentTurnIndex = 0;
      } else {
        room.currentTurnIndex = winnerIndex;
      }
      io.to(roomCode).emit("turnUpdate", { currentPlayer: winner });
    } else {
      console.error(`❌ room.playOrder is undefined or not an array!`);
      // Fallback: use first player
      room.currentTurnIndex = 0;
      if (room.players && room.players.length > 0) {
        io.to(roomCode).emit("turnUpdate", { currentPlayer: room.players[0].id });
      }
    }
    processAIPlay(roomCode, room);
  } else {
    if (room.playOrder && Array.isArray(room.playOrder)) {
      room.currentTurnIndex = (room.currentTurnIndex + 1) % room.players.length;
      const nextPlayer = room.playOrder[room.currentTurnIndex];
      io.to(roomCode).emit("turnUpdate", { currentPlayer: nextPlayer });
    } else {
      console.error(`❌ room.playOrder is undefined or not an array!`);
      // Fallback: cycle through players
      room.currentTurnIndex = (room.currentTurnIndex + 1) % room.players.length;
      if (room.players && room.players[room.currentTurnIndex]) {
        io.to(roomCode).emit("turnUpdate", { currentPlayer: room.players[room.currentTurnIndex].id });
      }
    }
    processAIPlay(roomCode, room);
  }
  return true;
}

// ===== AI HELPER FUNCTIONS =====
function processAIBid(roomCode, room) {
  const currentBidderId = room.biddingOrder[room.currentBidIndex];
  const currentBidder = room.players.find(p => p.id === currentBidderId);
  
  if (!currentBidder || !currentBidder.isAI) return;
  
  const roundCards = room.roundSequence[room.roundIndex];
  const trump = getTrump(room.trumpIndex % 5);
  const hand = room.hands[currentBidderId] || [];
  
  const bid = calculateAIBid(hand, roundCards, trump, room.bids, room.players.length);
  
  // Simulate AI thinking delay (300-800ms) - faster
  setTimeout(() => {
    // Re-check room state in case it changed
    if (!rooms[roomCode] || rooms[roomCode].biddingOrder[rooms[roomCode].currentBidIndex] !== currentBidderId) return;
    
    rooms[roomCode].bids[currentBidderId] = bid;
    const allBidsIn = Object.keys(rooms[roomCode].bids).length === rooms[roomCode].players.length;
    io.to(roomCode).emit("biddingUpdate", rooms[roomCode].bids);
    
    if (allBidsIn) {
      io.to(roomCode).emit("biddingComplete", { bids: rooms[roomCode].bids });
      rooms[roomCode].playOrder = [...rooms[roomCode].biddingOrder];
      rooms[roomCode].currentTurnIndex = 0;
      rooms[roomCode].currentTrick = [];
      rooms[roomCode].leadSuit = null;
      
      io.to(roomCode).emit("startPlay", {
        trump: getTrump(rooms[roomCode].trumpIndex % 5),
        currentPlayer: rooms[roomCode].playOrder[0],
      });
      
      // Check if first player is AI
      processAIPlay(roomCode, rooms[roomCode]);
    } else {
      rooms[roomCode].currentBidIndex = (rooms[roomCode].currentBidIndex + 1) % rooms[roomCode].players.length;
      const nextBidder = rooms[roomCode].biddingOrder[rooms[roomCode].currentBidIndex];
      io.to(roomCode).emit("biddingTurn", { currentBidder: nextBidder });
      
      // Check if next bidder is AI
      processAIBid(roomCode, rooms[roomCode]);
    }
  }, 300 + Math.random() * 500);
}

function processAIPlay(roomCode, room) {
  const currentPlayerId = room.playOrder[room.currentTurnIndex];
  const currentPlayer = room.players.find(p => p.id === currentPlayerId);
  
  if (!currentPlayer || !currentPlayer.isAI) return;
  
  const trump = getTrump(room.trumpIndex % 5);
  const hand = room.hands[currentPlayerId] || [];
  
  if (hand.length === 0) return;
  
  const card = selectAICard(hand, room.currentTrick, trump);
  
  if (!card) return;
  
  // Simulate AI thinking delay (400-1000ms) - faster
  setTimeout(() => {
    // Re-check room state
    if (!rooms[roomCode] || rooms[roomCode].playOrder[rooms[roomCode].currentTurnIndex] !== currentPlayerId) return;
    
    const currentRoom = rooms[roomCode];
    const expectedPlayer = currentRoom.playOrder[currentRoom.currentTurnIndex];
    if (currentPlayerId !== expectedPlayer) return;
    
    handleCardPlay(roomCode, currentRoom, currentPlayerId, card);
  }, 400 + Math.random() * 600);
}

// ===== SOCKET CONNECTION =====
io.on("connection", (socket) => {
  console.log(`✅ Connected: ${socket.id}`);

  // ===== CREATE ROOM =====
  socket.on("createRoom", ({ roomCode, playerName, clientId }) => {
    if (rooms[roomCode]) {
      socket.emit("errorMessage", "Room already exists!");
      return;
    }

    rooms[roomCode] = {
      players: [{ id: clientId, socketId: socket.id, name: playerName }],
      roundIndex: 0,
      trumpIndex: 0,
      roundSequence: [],
      bids: {},
      tricksWon: {},
      scores: {},
      biddingOrder: [],
      currentBidIndex: 0,
      playOrder: [],
      currentTurnIndex: 0,
      currentTurnIndex: 0,
      currentTrick: [],
      hands: {},
      leadSuit: null,
      readyPlayers: new Set(),
    };

    socket.join(roomCode);
    
    // Convert Set to Array for JSON serialization
    const roomUpdate = {
      ...rooms[roomCode],
      readyPlayers: Array.from(rooms[roomCode].readyPlayers || []),
    };
    io.to(roomCode).emit("roomUpdate", roomUpdate);
  });

  // ===== JOIN / REJOIN ROOM =====
  socket.on("joinRoom", ({ roomCode, playerName, clientId }) => {
    const room = rooms[roomCode];
    if (!room) {
      socket.emit("errorMessage", "Room not found!");
      return;
    }

    let existingPlayer = room.players.find((p) => p.id === clientId);
    if (existingPlayer) {
      existingPlayer.socketId = socket.id;
      existingPlayer.name = playerName;
      console.log(`🔁 Reconnected: ${playerName} (${clientId})`);
    } else {
      room.players.push({ id: clientId, socketId: socket.id, name: playerName, isAI: false });
      console.log(`👤 New Player Joined: ${playerName} (${clientId})`);
    }

    socket.join(roomCode);
    
    // Convert Set to Array for JSON serialization
    const roomUpdate = {
      ...room,
      readyPlayers: Array.from(room.readyPlayers || []),
    };
    io.to(roomCode).emit("roomUpdate", roomUpdate);

    if (room.roundSequence.length > 0) {
      const gameState = getFullGameState(room);
      const playerHand = room.hands[clientId] || [];
      socket.emit("rejoinGame", { ...gameState, myHand: playerHand });
    }
  });

  // ===== ADD AI PLAYER =====
  socket.on("addAI", ({ roomCode }) => {
    const room = rooms[roomCode];
    if (!room) {
      socket.emit("errorMessage", "Room not found!");
      return;
    }

    if (room.players.length >= 4) {
      socket.emit("errorMessage", "Room is full! Maximum 4 players.");
      return;
    }

    const aiNames = ["AI Alice", "AI Bob", "AI Charlie", "AI Diana"];
    const usedNames = room.players.map(p => p.name);
    let aiName = aiNames.find(name => !usedNames.includes(name)) || `AI Player ${room.players.length + 1}`;
    
    const aiId = `ai_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    room.players.push({ id: aiId, socketId: null, name: aiName, isAI: true });
    
    // AI players are automatically ready
    if (!room.readyPlayers) {
      room.readyPlayers = new Set();
    }
    room.readyPlayers.add(aiId);
    
    console.log(`🤖 AI Player Added: ${aiName} (${aiId}) - Auto-ready`);
    
    // Convert Set to Array for JSON serialization
    const roomUpdate = {
      ...room,
      readyPlayers: Array.from(room.readyPlayers),
    };
    io.to(roomCode).emit("roomUpdate", roomUpdate);
    
    // Emit ready status for AI
    io.to(roomCode).emit("playerReady", { playerId: aiId, ready: true });
    
    // Check if all players are ready
    if (room.readyPlayers.size === room.players.length && room.players.length >= 3) {
      io.to(roomCode).emit("allPlayersReady");
    }
  });

  // ===== TOGGLE READY =====
  socket.on("toggleReady", ({ roomCode, playerId, ready }) => {
    const room = rooms[roomCode];
    if (!room) {
      socket.emit("errorMessage", "Room not found!");
      return;
    }

    // Validate player exists in room
    const player = room.players.find(p => p.id === playerId);
    if (!player) {
      socket.emit("errorMessage", "Player not found in room!");
      return;
    }

    // Initialize readyPlayers if it doesn't exist
    if (!room.readyPlayers) {
      room.readyPlayers = new Set();
    }

    if (ready) {
      room.readyPlayers.add(playerId);
      console.log(`✅ Player ${player.name} (${playerId}) is ready`);
    } else {
      room.readyPlayers.delete(playerId);
      console.log(`⏳ Player ${player.name} (${playerId}) is not ready`);
    }

    // Emit to all clients
    io.to(roomCode).emit("playerReady", { playerId, ready });
    
    // Convert Set to Array for JSON serialization
    const roomUpdate = {
      ...room,
      readyPlayers: Array.from(room.readyPlayers),
    };
    io.to(roomCode).emit("roomUpdate", roomUpdate);

    // Check if all players are ready
    if (room.readyPlayers.size === room.players.length && room.players.length >= 3) {
      io.to(roomCode).emit("allPlayersReady");
    }
  });

  // ===== START ROUND =====
  socket.on("startRound", ({ roomCode }) => {
    const room = rooms[roomCode];
    if (!room) return;

    // Check if all players are ready
    if (room.readyPlayers.size < room.players.length) {
      socket.emit("errorMessage", "All players must be ready before starting!");
      return;
    }

    // Reset ready states for next game
    room.readyPlayers.clear();

    const playerCount = room.players.length;
    room.roundSequence = buildRoundSequence(playerCount);
    room.roundIndex = 0;
    room.trumpIndex = 0;
    room.scores = room.scores || {};

    const roundNumber = room.roundSequence[0];
    const trump = getTrump(room.trumpIndex % 5);
    const { hands, buriedCards } = dealCards(room.players, roundNumber);
    for (const pid in hands) hands[pid] = sortHand(hands[pid]);

    room.hands = hands;
    room.buriedCards = buriedCards;
    room.tricksWon = Object.fromEntries(room.players.map((p) => [p.id, 0]));
    room.currentTrick = [];
    room.leadSuit = null;
    room.bids = {};
    room.biddingOrder = getBiddingOrder(room.players, room.roundIndex);
    room.currentBidIndex = 0;

    for (const player of room.players) {
      const psocket = player.socketId;
      if (!psocket) continue;
      io.to(psocket).emit("roundStarted", {
        displayRound: `1/${room.roundSequence.length}`,
        cardsThisRound: roundNumber,
        trump,
        hands: { [player.id]: hands[player.id] },
        currentBidder: room.biddingOrder[0],
      });
    }

    io.to(roomCode).emit("startBidding", {
      round: `1/${room.roundSequence.length}`,
      trump,
      currentBidder: room.biddingOrder[0],
    });
    
    // Check if first bidder is AI
    processAIBid(roomCode, room);
  });

  // ===== BIDDING =====
  socket.on("makeBid", ({ roomCode, playerId, bid }) => {
    const room = rooms[roomCode];
    if (!room) return;

    const roundCards = room.roundSequence[room.roundIndex];
    const expectedBidder = room.biddingOrder[room.currentBidIndex];
    if (playerId !== expectedBidder) {
      socket.emit("invalidBid", "❌ Not your turn to bid!");
      return;
    }

    // ✅ Prevent total = roundCards only for the LAST bidder
    const isLastBidder = room.currentBidIndex === room.biddingOrder.length - 1;
    if (isLastBidder) {
      const totalSoFar = Object.values(room.bids).reduce((a, b) => a + b, 0);
      const totalIfBid = totalSoFar + bid;
      if (totalIfBid === roundCards) {
        socket.emit("invalidBid", `❌ Invalid bid! Total bids cannot equal ${roundCards}.`);
        return;
      }
    }

    room.bids[playerId] = bid;
    const allBidsIn = Object.keys(room.bids).length === room.players.length;
    io.to(roomCode).emit("biddingUpdate", room.bids);

    if (allBidsIn) {
      io.to(roomCode).emit("biddingComplete", { bids: room.bids });
      // Ensure playOrder is set from biddingOrder
      if (room.biddingOrder && Array.isArray(room.biddingOrder)) {
        room.playOrder = [...room.biddingOrder];
      } else {
        console.error(`❌ room.biddingOrder is invalid when trying to set playOrder!`);
        // Fallback: create playOrder from players
        room.playOrder = room.players.map(p => p.id);
      }
      room.currentTurnIndex = 0;
      room.currentTrick = [];
      room.leadSuit = null;

      io.to(roomCode).emit("startPlay", {
        trump: getTrump(room.trumpIndex % 5),
        currentPlayer: room.playOrder && room.playOrder.length > 0 ? room.playOrder[0] : (room.players[0]?.id || null),
      });
      
      // Check if first player is AI
      processAIPlay(roomCode, room);
    } else {
      room.currentBidIndex = (room.currentBidIndex + 1) % room.players.length;
      const nextBidder = room.biddingOrder[room.currentBidIndex];
      io.to(roomCode).emit("biddingTurn", { currentBidder: nextBidder });
      
      // Check if next bidder is AI
      processAIBid(roomCode, room);
    }
  });

  // ===== PLAY CARD =====
  socket.on("playCard", ({ roomCode, playerId, card }) => {
    const room = rooms[roomCode];
    if (!room) return;

    const expectedPlayer = room.playOrder[room.currentTurnIndex];
    if (playerId !== expectedPlayer) {
      socket.emit("invalidPlay", "❌ Not your turn to play!");
      return;
    }

    if (!handleCardPlay(roomCode, room, playerId, card)) {
      socket.emit("invalidPlay", "❌ You must follow suit!");
      const playerSocket = room.players.find((p) => p.id === playerId)?.socketId;
      if (playerSocket) io.to(playerSocket).emit("turnUpdate", { currentPlayer: playerId });
    }
  });

  // ===== DISCONNECT =====
  socket.on("disconnect", () => {
    for (const [roomCode, room] of Object.entries(rooms)) {
      const player = room.players.find((p) => p.socketId === socket.id);
      if (player) {
        player.socketId = null;
        console.log(`❌ Disconnected: ${player.name} (${player.id})`);
        
        // Convert Set to Array for JSON serialization
        const roomUpdate = {
          ...room,
          readyPlayers: Array.from(room.readyPlayers || []),
        };
        io.to(roomCode).emit("roomUpdate", roomUpdate);
      }
    }
  });
});

const PORT = process.env.PORT || 4000;
server.listen(PORT, () => console.log(`🚀 Bugger Bridge server running on port ${PORT}`));
