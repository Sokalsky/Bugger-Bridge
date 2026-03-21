import express from "express";
import http from "http";
import { Server } from "socket.io";
import cors from "cors";
import { dealCards, getTrump } from "./gameLogic.js";
import { calculateAIBid, selectAICard } from "./aiLogic.js";
import { initDatabase, shutdown as dbShutdown } from "./db.js";
import {
  logGameStart, logGameEnd,
  logRoundStart, logRoundEnd,
  logBid, logCardPlay, logTrickComplete,
  ensurePlayer,
  getOverallStats, getPlayerStats, getCardStats, getGameHistory, getBidAnalysis,
} from "./dataCollector.js";
import { getBidLearningData, getPlayLearningData } from "./aiLearning.js";
import { saveGameState, loadAllGameStates, deleteGameState, listActiveGames } from "./gameState.js";

const app = express();
app.use(cors());
app.use(express.json());

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
  const cardsThisRound = room.roundSequence[room.roundIndex] || 0;
  const trump = getTrump(room.trumpIndex % 5);
  const phase = room.biddingOrder?.length > 0 && Object.keys(room.bids).length < room.players.length
    ? "bidding"
    : "play";

  // Compute opponent hand sizes (card counts, not actual cards)
  const handSizes = {};
  for (const pid of Object.keys(room.hands || {})) {
    handSizes[pid] = room.hands[pid]?.length || 0;
  }

  return {
    // Display-ready round info
    displayRound: `${room.roundIndex + 1}/${room.roundSequence.length}`,
    cardsThisRound,
    trump,
    roundSequence: room.roundSequence,
    roundIndex: room.roundIndex,

    // Game state
    bids: room.bids,
    tricksWon: room.tricksWon,
    scores: room.scores,
    currentTrick: room.currentTrick,
    handSizes,

    // Turn info
    phase,
    currentBidder: room.biddingOrder?.[room.currentBidIndex],
    currentPlayer: room.playOrder?.[room.currentTurnIndex],
    playOrder: room.playOrder,
    biddingOrder: room.biddingOrder,

    // Players
    players: room.players.map(p => ({ id: p.id, name: p.name, isAI: p.isAI || false })),

    // Round history for scoresheet
    gameHistory: room.gameHistory || [],
  };
}

// ===== SHARED CARD PLAYING LOGIC =====
function handleCardPlay(roomCode, room, playerId, card) {
  room.lastActivityAt = Date.now();
  const playerHand = room.hands[playerId];
  if (!playerHand) return false;

  // Prevent double-play: if this player already played in this trick, reject
  if (room.currentTrick.some(p => p.playerId === playerId)) return false;

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

  // ===== DATABASE: Log card play =====
  const playingPlayer = room.players.find(p => p.id === playerId);
  const playerBid = room.bids[playerId] || 0;
  const playerTricksSoFar = room.tricksWon[playerId] || 0;
  logCardPlay(
    room.dbRoundId, room.dbGameId,
    (room.trickNumber || 0) + 1, room.currentTrick.length, playerId, card,
    {
      trump: getTrump(room.trumpIndex % 5),
      leadSuit: room.leadSuit,
      cardsPerPlayer: room.roundSequence[room.roundIndex],
      cardsRemaining: room.hands[playerId]?.length || 0,
      playerBid,
      playerTricksSoFar,
      tricksNeeded: playerBid - playerTricksSoFar,
      isAI: playingPlayer?.isAI || false,
    }
  ).catch(e => console.error("DB card log error:", e.message));

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
    
    // ===== DATABASE: Log trick complete =====
    room.trickNumber = (room.trickNumber || 0) + 1;
    const trickCopy = [...room.currentTrick];
    logTrickComplete(
      room.dbRoundId, room.dbGameId, room.trickNumber,
      trickCopy, winner, trump, room.roundSequence[room.roundIndex]
    ).catch(e => console.error("DB trick log error:", e.message));

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

      // ===== DATABASE: Log round end =====
      logRoundEnd(room.dbRoundId, room.dbGameId, room.bids, room.tricksWon, room.scores, room.players)
        .catch(e => console.error("DB round end log error:", e.message));

      // Store round history for rejoin
      const roundHistoryEntry = {
        tricksWon: { ...room.tricksWon },
        bids: { ...room.bids },
        scores: { ...room.scores },
        roundNumber: `${room.roundIndex + 1}/${room.roundSequence.length}`,
        cardsThisRound: room.roundSequence[room.roundIndex],
        trump: getTrump(room.trumpIndex % 5),
        buriedCards: room.buriedCards || [],
      };
      if (!room.gameHistory) room.gameHistory = [];
      room.gameHistory.push(roundHistoryEntry);

      io.to(roomCode).emit("roundOver", roundHistoryEntry);

      room.roundIndex++;
      room.trumpIndex++;
      if (room.roundIndex >= room.roundSequence.length) {
        logGameEnd(room.dbGameId, room.scores, room.players)
          .catch(e => console.error("DB game end log error:", e.message));
        deleteGameState(roomCode).catch(() => {});

        io.to(roomCode).emit("gameOver", {
          scores: room.scores,
          tricksWon: room.tricksWon,
          bids: room.bids,
          gameHistory: room.gameHistory || [],
        });
        return true; // Game over
      }

      // Delay next round setup so client processes roundOver/scoresheet first
      setTimeout(() => {
        if (!rooms[roomCode]) return;
        const r = rooms[roomCode];

        const nextRoundNumber = r.roundSequence[r.roundIndex];
        const nextTrump = getTrump(r.trumpIndex % 5);
        const { hands: newHands, buriedCards: newBuriedCards } = dealCards(r.players, nextRoundNumber);
        for (const pid in newHands) newHands[pid] = sortHand(newHands[pid]);

        r.hands = newHands;
        r.buriedCards = newBuriedCards;
        r.tricksWon = Object.fromEntries(r.players.map((p) => [p.id, 0]));
        r.currentTrick = [];
        r.leadSuit = null;
        r.bids = {};

        const playerCount = r.players.length;
        const dealerIndex = r.roundIndex % playerCount;
        r.biddingOrder = [];
        for (let i = 1; i <= playerCount; i++) {
          r.biddingOrder.push(r.players[(dealerIndex + i) % playerCount].id);
        }
        r.currentBidIndex = 0;
        r.trickNumber = 0;

        (async () => {
          try {
            r.dbRoundId = await logRoundStart(
              r.dbGameId, r.roundIndex, nextRoundNumber, nextTrump, dealerIndex, newHands, newBuriedCards
            );
          } catch (e) { console.error("DB round start log error:", e.message); }
        })();

        for (const player of r.players) {
          const psocket = player.socketId;
          if (!psocket) continue;
          io.to(psocket).emit("roundStarted", {
            displayRound: `${r.roundIndex + 1}/${r.roundSequence.length}`,
            cardsThisRound: nextRoundNumber,
            trump: nextTrump,
            hands: { [player.id]: newHands[player.id] },
            currentBidder: r.biddingOrder[0],
          });
        }

        io.to(roomCode).emit("startBidding", {
          round: `${r.roundIndex + 1}/${r.roundSequence.length}`,
          trump: nextTrump,
          currentBidder: r.biddingOrder[0],
        });

        loadRoundLearningCache(roomCode, r);
        saveGameState(roomCode, r).catch(() => {});
        processAIBid(roomCode, r);
      }, 2000); // 2 second delay — client shows scoresheet first

      return true; // Round over
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
      room.currentTurnIndex = 0;
      if (room.players && room.players.length > 0) {
        io.to(roomCode).emit("turnUpdate", { currentPlayer: room.players[0].id });
      }
    }
    saveGameState(roomCode, room).catch(() => {});
    processAIPlay(roomCode, room);
  } else {
    if (room.playOrder && Array.isArray(room.playOrder)) {
      room.currentTurnIndex = (room.currentTurnIndex + 1) % room.players.length;
      const nextPlayer = room.playOrder[room.currentTurnIndex];
      io.to(roomCode).emit("turnUpdate", { currentPlayer: nextPlayer });
    } else {
      console.error(`❌ room.playOrder is undefined or not an array!`);
      room.currentTurnIndex = (room.currentTurnIndex + 1) % room.players.length;
      if (room.players && room.players[room.currentTurnIndex]) {
        io.to(roomCode).emit("turnUpdate", { currentPlayer: room.players[room.currentTurnIndex].id });
      }
    }
    saveGameState(roomCode, room).catch(() => {});
    processAIPlay(roomCode, room);
  }
  return true;
}

// ===== AI HELPER FUNCTIONS =====
// Learning data is loaded ONCE per round into room.learningCache (async, non-blocking).
// AI decisions are fully synchronous — just setTimeout, no promises.

function loadRoundLearningCache(roomCode, room) {
  // Fire-and-forget: load learning data into room.learningCache for AI to use
  const roundCards = room.roundSequence[room.roundIndex];
  const trump = getTrump(room.trumpIndex % 5);

  // Load bid estimates for each AI player
  const aiPlayers = room.players.filter(p => p.isAI);
  for (const ai of aiPlayers) {
    const hand = room.hands[ai.id] || [];
    getBidLearningData(hand, roundCards, trump).then(data => {
      if (!room.learningCache) room.learningCache = {};
      room.learningCache[`bid_${ai.id}`] = data;
    }).catch(() => {});
  }
}

function processAIBid(roomCode, room) {
  const currentBidderId = room.biddingOrder[room.currentBidIndex];
  const currentBidder = room.players.find(p => p.id === currentBidderId);

  if (!currentBidder || !currentBidder.isAI) return;

  const roundCards = room.roundSequence[room.roundIndex];
  const trump = getTrump(room.trumpIndex % 5);
  const hand = room.hands[currentBidderId] || [];
  const isLastBidder = room.currentBidIndex === room.biddingOrder.length - 1;

  // Use cached learning data if available (loaded at round start)
  const learningData = room.learningCache?.[`bid_${currentBidderId}`] || null;
  const bid = calculateAIBid(hand, roundCards, trump, room.bids, room.players.length, isLastBidder, learningData);

  const capturedRoundIndex = room.roundIndex;

  setTimeout(() => {
    if (!rooms[roomCode]) return;
    if (rooms[roomCode].roundIndex !== capturedRoundIndex) return;
    if (rooms[roomCode].biddingOrder[rooms[roomCode].currentBidIndex] !== currentBidderId) return;

    rooms[roomCode].bids[currentBidderId] = bid;
    rooms[roomCode].lastActivityAt = Date.now();
    const allBidsIn = Object.keys(rooms[roomCode].bids).length === rooms[roomCode].players.length;
    io.to(roomCode).emit("biddingUpdate", rooms[roomCode].bids);
    saveGameState(roomCode, rooms[roomCode]).catch(() => {});

    logBid(
      rooms[roomCode].dbRoundId, rooms[roomCode].dbGameId, currentBidderId, bid,
      rooms[roomCode].currentBidIndex + 1, hand, roundCards, trump, true
    ).catch(e => console.error("DB AI bid log error:", e.message));

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
      processAIPlay(roomCode, rooms[roomCode]);
    } else {
      rooms[roomCode].currentBidIndex = (rooms[roomCode].currentBidIndex + 1) % rooms[roomCode].players.length;
      const nextBidder = rooms[roomCode].biddingOrder[rooms[roomCode].currentBidIndex];
      io.to(roomCode).emit("biddingTurn", { currentBidder: nextBidder });
      processAIBid(roomCode, rooms[roomCode]);
    }
  }, 300 + Math.random() * 200);
}

function processAIPlay(roomCode, room) {
  const currentPlayerId = room.playOrder?.[room.currentTurnIndex];
  if (!currentPlayerId) return;

  const currentPlayer = room.players.find(p => p.id === currentPlayerId);
  if (!currentPlayer || !currentPlayer.isAI) return;

  const trump = getTrump(room.trumpIndex % 5);
  const hand = room.hands[currentPlayerId];
  if (!hand || hand.length === 0) return;

  const aiBid = room.bids[currentPlayerId] || 0;
  const aiTricksWon = room.tricksWon[currentPlayerId] || 0;

  const card = selectAICard(hand, room.currentTrick, trump, aiBid, aiTricksWon, null);
  if (!card) return;

  // Capture round index to reject stale timeouts that survive across round transitions
  const capturedRoundIndex = room.roundIndex;

  setTimeout(() => {
    if (!rooms[roomCode]) return;
    const currentRoom = rooms[roomCode];
    // Reject if round changed (stale timeout from watchdog duplicate)
    if (currentRoom.roundIndex !== capturedRoundIndex) return;
    if (currentRoom.playOrder[currentRoom.currentTurnIndex] !== currentPlayerId) return;
    handleCardPlay(roomCode, currentRoom, currentPlayerId, card);
  }, 400 + Math.random() * 200);
}

// ===== AI WATCHDOG =====
// Only intervenes when a game is truly stalled (no activity for 10+ seconds).
// Uses room.lastActivityAt to avoid interfering with active games.
setInterval(() => {
  for (const [roomCode, room] of Object.entries(rooms)) {
    if (!room.playOrder || room.playOrder.length === 0) continue;
    if (!room.roundSequence || room.roundSequence.length === 0) continue;

    // Only intervene if game has been idle for 10+ seconds
    const now = Date.now();
    const lastActivity = room.lastActivityAt || 0;
    if (now - lastActivity < 10000) continue;

    // Check if we're in play phase
    const allBidsIn = Object.keys(room.bids).length === room.players.length;
    if (!allBidsIn) {
      const bidderId = room.biddingOrder?.[room.currentBidIndex];
      const bidder = bidderId && room.players.find(p => p.id === bidderId);
      if (bidder?.isAI && !room.bids[bidderId]) {
        console.log(`🔄 Watchdog: AI bidder ${bidder.name} stalled in ${roomCode} (idle ${Math.round((now-lastActivity)/1000)}s), retrying...`);
        processAIBid(roomCode, room);
      }
      continue;
    }

    const cardsLeft = Object.values(room.hands).reduce((sum, h) => sum + (h?.length || 0), 0);

    // ROUND END DETECTION: all hands empty but round didn't end
    if (cardsLeft === 0) {
      // If the last trick is still sitting there unprocessed, resolve it first
      if (room.currentTrick.length === room.players.length) {
        console.log(`🔧 Watchdog: Last trick unprocessed in ${roomCode} — resolving`);
        const trump = getTrump(room.trumpIndex % 5);
        const winner = determineTrickWinner(room.currentTrick, trump);
        room.tricksWon[winner] = (room.tricksWon[winner] || 0) + 1;
        room.trickNumber = (room.trickNumber || 0) + 1;
        logTrickComplete(room.dbRoundId, room.dbGameId, room.trickNumber, [...room.currentTrick], winner, trump, room.roundSequence[room.roundIndex]).catch(() => {});
        io.to(roomCode).emit("trickComplete", { winner, tricksWon: room.tricksWon, nextPlayer: winner });
        room.currentTrick = [];
        room.leadSuit = null;
      }

      // Clear any partial trick (shouldn't happen but safety net)
      if (room.currentTrick.length > 0 && room.currentTrick.length < room.players.length) {
        console.log(`🔧 Watchdog: Clearing partial trick (${room.currentTrick.length} cards) in ${roomCode}`);
        room.currentTrick = [];
        room.leadSuit = null;
      }

      console.log(`🔧 Watchdog: All cards played in ${roomCode} but round didn't end — triggering scoring`);

      // Calculate scores
      room.scores = room.scores || {};
      for (const player of room.players) {
        const id = player.id;
        const tricks = room.tricksWon[id] || 0;
        const bid = room.bids[id] || 0;
        const metBid = tricks === bid;
        const roundScore = metBid ? 10 + tricks : tricks;
        room.scores[id] = (room.scores[id] || 0) + roundScore;
      }

      // Log round end
      logRoundEnd(room.dbRoundId, room.dbGameId, room.bids, room.tricksWon, room.scores, room.players)
        .catch(e => console.error("DB round end log error:", e.message));

      const wdRoundEntry = {
        tricksWon: { ...room.tricksWon },
        bids: { ...room.bids },
        scores: { ...room.scores },
        roundNumber: `${room.roundIndex + 1}/${room.roundSequence.length}`,
        cardsThisRound: room.roundSequence[room.roundIndex],
        trump: getTrump(room.trumpIndex % 5),
        buriedCards: room.buriedCards || [],
      };
      if (!room.gameHistory) room.gameHistory = [];
      room.gameHistory.push(wdRoundEntry);
      io.to(roomCode).emit("roundOver", wdRoundEntry);

      room.roundIndex++;
      room.trumpIndex++;

      if (room.roundIndex >= room.roundSequence.length) {
        logGameEnd(room.dbGameId, room.scores, room.players).catch(() => {});
        deleteGameState(roomCode).catch(() => {});
        io.to(roomCode).emit("gameOver", { scores: room.scores, tricksWon: room.tricksWon, bids: room.bids });
      } else {
        // Delay next round so client sees scoresheet first (same as handleCardPlay)
        setTimeout(() => {
          if (!rooms[roomCode]) return;
          const r = rooms[roomCode];
          const nextRoundNumber = r.roundSequence[r.roundIndex];
          const nextTrump = getTrump(r.trumpIndex % 5);
          const { hands: newHands, buriedCards: newBuriedCards } = dealCards(r.players, nextRoundNumber);
          for (const pid in newHands) newHands[pid] = sortHand(newHands[pid]);
          r.hands = newHands;
          r.buriedCards = newBuriedCards;
          r.tricksWon = Object.fromEntries(r.players.map((p) => [p.id, 0]));
          r.currentTrick = []; r.leadSuit = null; r.bids = {}; r.trickNumber = 0;
          const playerCount = r.players.length;
          const dealerIndex = r.roundIndex % playerCount;
          r.biddingOrder = [];
          for (let i = 1; i <= playerCount; i++) r.biddingOrder.push(r.players[(dealerIndex + i) % playerCount].id);
          r.currentBidIndex = 0;

          (async () => {
            try { r.dbRoundId = await logRoundStart(r.dbGameId, r.roundIndex, nextRoundNumber, nextTrump, dealerIndex, newHands, newBuriedCards); }
            catch (e) { console.error("DB round start log error:", e.message); }
          })();

          for (const player of r.players) {
            const psocket = player.socketId;
            if (!psocket) continue;
            io.to(psocket).emit("roundStarted", {
              displayRound: `${r.roundIndex + 1}/${r.roundSequence.length}`,
              cardsThisRound: nextRoundNumber, trump: nextTrump,
              hands: { [player.id]: newHands[player.id] },
              currentBidder: r.biddingOrder[0],
            });
          }
          io.to(roomCode).emit("startBidding", {
            round: `${r.roundIndex + 1}/${r.roundSequence.length}`,
            trump: nextTrump, currentBidder: r.biddingOrder[0],
          });
          loadRoundLearningCache(roomCode, r);
          saveGameState(roomCode, r).catch(() => {});
          processAIBid(roomCode, r);
        }, 2000);
      }
      continue;
    }

    const currentPlayerId = room.playOrder[room.currentTurnIndex];
    const currentPlayer = currentPlayerId && room.players.find(p => p.id === currentPlayerId);
    const hand = currentPlayerId && room.hands[currentPlayerId];

    // STATE REPAIR: current player has no cards but others do — turnIndex is stale
    if (currentPlayerId && (!hand || hand.length === 0) && cardsLeft > 0) {
      console.log(`🔧 Watchdog: ${currentPlayer?.name || currentPlayerId} has 0 cards but ${cardsLeft} remain — fixing turnIndex`);

      // Check if current player already played in this trick
      const alreadyPlayed = room.currentTrick.some(p => p.playerId === currentPlayerId);
      if (alreadyPlayed) {
        // Advance to next player who hasn't played in this trick
        for (let i = 1; i <= room.players.length; i++) {
          const nextIdx = (room.currentTurnIndex + i) % room.players.length;
          const nextId = room.playOrder[nextIdx];
          const nextHand = room.hands[nextId];
          const nextPlayed = room.currentTrick.some(p => p.playerId === nextId);
          if (!nextPlayed && nextHand && nextHand.length > 0) {
            room.currentTurnIndex = nextIdx;
            console.log(`🔧 Watchdog: Advanced turn to ${room.players.find(p => p.id === nextId)?.name || nextId}`);
            io.to(roomCode).emit("turnUpdate", { currentPlayer: nextId });
            saveGameState(roomCode, room).catch(() => {});
            processAIPlay(roomCode, room);
            break;
          }
        }
      }
      continue;
    }

    // Normal stall detection: AI's turn and they have cards but haven't played
    if (currentPlayer?.isAI && hand && hand.length > 0) {
      console.log(`🔄 Watchdog: AI player ${currentPlayer.name} stalled in ${roomCode}, retrying...`);
      processAIPlay(roomCode, room);
    }
  }
}, 5000); // Check every 5 seconds

// ===== HELPERS FOR SOCKET EVENTS =====
function serializeRoom(room) {
  return { ...room, readyPlayers: Array.from(room.readyPlayers || []) };
}

function validateInput(socket, { roomCode, playerName, clientId }) {
  if (!roomCode || typeof roomCode !== "string" || roomCode.length > 8) {
    socket.emit("errorMessage", "Invalid room code!");
    return false;
  }
  if (playerName !== undefined && (typeof playerName !== "string" || playerName.length === 0 || playerName.length > 16)) {
    socket.emit("errorMessage", "Invalid player name!");
    return false;
  }
  if (clientId !== undefined && (typeof clientId !== "string" || clientId.length === 0)) {
    socket.emit("errorMessage", "Invalid client ID!");
    return false;
  }
  return true;
}

// ===== SOCKET CONNECTION =====
io.on("connection", (socket) => {
  console.log(`✅ Connected: ${socket.id}`);

  // ===== CREATE ROOM =====
  socket.on("createRoom", ({ roomCode, playerName, clientId } = {}) => {
    if (!validateInput(socket, { roomCode, playerName, clientId })) return;
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
      currentTrick: [],
      hands: {},
      leadSuit: null,
      readyPlayers: new Set(),
    };

    socket.join(roomCode);
    
    io.to(roomCode).emit("roomUpdate", serializeRoom(rooms[roomCode]));
  });

  // ===== JOIN / REJOIN ROOM =====
  socket.on("joinRoom", ({ roomCode, playerName, clientId } = {}) => {
    if (!validateInput(socket, { roomCode, playerName, clientId })) return;
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
    
    io.to(roomCode).emit("roomUpdate", serializeRoom(room));

    if (room.roundSequence.length > 0) {
      const gameState = getFullGameState(room);
      const playerHand = room.hands[clientId] || [];
      socket.emit("rejoinGame", { ...gameState, myHand: playerHand });

      // If it's an AI's turn, kick off their action (may have stalled after restore)
      setTimeout(() => {
        const currentRoom = rooms[roomCode];
        if (!currentRoom) return;
        const phase = gameState.phase;
        if (phase === "bidding") {
          processAIBid(roomCode, currentRoom);
        } else if (phase === "play") {
          processAIPlay(roomCode, currentRoom);
        }
      }, 500);
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
    room.trickNumber = 0;
    room.gameHistory = [];

    // ===== DATABASE: Log game + round start =====
    (async () => {
      try {
        if (!room.dbGameId) {
          room.dbGameId = await logGameStart(roomCode, room.players);
        }
        const dealerIndex = room.roundIndex % playerCount;
        room.dbRoundId = await logRoundStart(
          room.dbGameId, room.roundIndex, roundNumber, trump, dealerIndex, hands, buriedCards
        );
      } catch (e) { console.error("DB log error:", e.message); }
    })();

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
    
    // Load learning data into cache for this round (async, non-blocking)
    loadRoundLearningCache(roomCode, room);
    // Save game state and check if first bidder is AI
    saveGameState(roomCode, room).catch(() => {});
    processAIBid(roomCode, room);
  });

  // ===== BIDDING =====
  socket.on("makeBid", ({ roomCode, playerId, bid } = {}) => {
    const room = rooms[roomCode];
    if (!room) return;

    const roundCards = room.roundSequence[room.roundIndex];

    // Validate bid is a number within range
    if (typeof bid !== "number" || !Number.isInteger(bid) || bid < 0 || bid > roundCards) {
      socket.emit("invalidBid", `❌ Bid must be a whole number between 0 and ${roundCards}.`);
      return;
    }
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
    saveGameState(roomCode, room).catch(() => {});

    // ===== DATABASE: Log bid =====
    const bidPlayer = room.players.find(p => p.id === playerId);
    logBid(
      room.dbRoundId, room.dbGameId, playerId, bid, room.currentBidIndex + 1,
      room.hands[playerId] || [], roundCards,
      getTrump(room.trumpIndex % 5), bidPlayer?.isAI || false
    ).catch(e => console.error("DB bid log error:", e.message));

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

// ===== API ENDPOINTS =====
app.get("/api/stats", async (req, res) => {
  try {
    const stats = await getOverallStats();
    res.json({ success: true, data: stats });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get("/api/players", async (req, res) => {
  try {
    const players = await getPlayerStats();
    res.json({ success: true, data: players });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get("/api/cards", async (req, res) => {
  try {
    const cardsPerPlayer = req.query.round ? parseInt(req.query.round) : null;
    const cards = await getCardStats(cardsPerPlayer);
    res.json({ success: true, data: cards });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get("/api/games", async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 20, 100);
    const games = await getGameHistory(limit);
    res.json({ success: true, data: games });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get("/api/bids", async (req, res) => {
  try {
    const analysis = await getBidAnalysis();
    res.json({ success: true, data: analysis });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get("/api/active-games", async (req, res) => {
  try {
    const activeGames = await listActiveGames();
    res.json({ success: true, data: activeGames });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.delete("/api/game-state/:roomCode", async (req, res) => {
  try {
    const code = req.params.roomCode.toUpperCase();
    // Remove from memory
    if (rooms[code]) {
      delete rooms[code];
    }
    // Remove from database
    await deleteGameState(code);
    console.log(`🗑️ Game state deleted: ${code}`);
    res.json({ success: true, message: `Game ${code} deleted` });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.delete("/api/game-state", async (req, res) => {
  try {
    // Delete ALL saved game states
    const { query: dbQuery } = await import("./db.js");
    await dbQuery("DELETE FROM game_state");
    // Clear all rooms from memory
    for (const code of Object.keys(rooms)) {
      delete rooms[code];
    }
    console.log("🗑️ All game states cleared");
    res.json({ success: true, message: "All game states cleared" });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post("/api/cleanup-stats", async (req, res) => {
  try {
    const { query: dbQuery } = await import("./db.js");
    // Delete all data from incomplete games (no finished_at)
    const incomplete = await dbQuery(`SELECT id FROM games WHERE finished_at IS NULL`);
    const deadIds = incomplete?.rows?.map(r => r.id) || [];
    if (deadIds.length > 0) {
      for (const gid of deadIds) {
        await dbQuery(`DELETE FROM card_plays WHERE game_id = $1`, [gid]);
        await dbQuery(`DELETE FROM trick_results WHERE game_id = $1`, [gid]);
        await dbQuery(`DELETE FROM round_results WHERE game_id = $1`, [gid]);
        await dbQuery(`DELETE FROM rounds WHERE game_id = $1`, [gid]);
        await dbQuery(`DELETE FROM game_players WHERE game_id = $1`, [gid]);
        await dbQuery(`DELETE FROM games WHERE id = $1`, [gid]);
      }
    }
    // Recalculate player aggregate stats from actual completed data
    await dbQuery(`
      UPDATE players SET
        games_played = COALESCE((SELECT COUNT(DISTINCT gp.game_id) FROM game_players gp JOIN games g ON gp.game_id = g.id WHERE gp.player_id = players.id AND g.finished_at IS NOT NULL), 0),
        games_won = COALESCE((SELECT COUNT(*) FROM games g WHERE g.winner_id = players.id AND g.finished_at IS NOT NULL), 0),
        total_rounds_played = COALESCE((SELECT COUNT(*) FROM round_results rr JOIN games g ON rr.game_id = g.id WHERE rr.player_id = players.id AND g.finished_at IS NOT NULL AND rr.cumulative_score > 0), 0),
        total_bids_made = COALESCE((SELECT COUNT(*) FROM round_results rr JOIN games g ON rr.game_id = g.id WHERE rr.player_id = players.id AND g.finished_at IS NOT NULL AND rr.cumulative_score > 0), 0),
        total_bids_met = COALESCE((SELECT COUNT(*) FROM round_results rr JOIN games g ON rr.game_id = g.id WHERE rr.player_id = players.id AND g.finished_at IS NOT NULL AND rr.met_bid = true AND rr.cumulative_score > 0), 0),
        total_tricks_won = COALESCE((SELECT SUM(rr.tricks_won) FROM round_results rr JOIN games g ON rr.game_id = g.id WHERE rr.player_id = players.id AND g.finished_at IS NOT NULL AND rr.cumulative_score > 0), 0),
        total_score = COALESCE((SELECT MAX(gp.final_score) FROM game_players gp JOIN games g ON gp.game_id = g.id WHERE gp.player_id = players.id AND g.finished_at IS NOT NULL), 0)
    `);
    res.json({ success: true, message: `Cleaned ${deadIds.length} dead games, recalculated all player stats` });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post("/api/simulate", async (req, res) => {
  const numGames = Math.min(parseInt(req.query.games) || 10, 50);

  try {
    const { simulateGames } = await import("./simulate-games-bg.js");
    // Run in background
    simulateGames(numGames).then(results => {
      console.log(`✅ Simulation complete: ${results.gamesCompleted} games`);
    }).catch(e => {
      console.error("❌ Simulation error:", e.message, e.stack);
    });
    res.json({ success: true, message: `Starting ${numGames} AI-vs-AI simulations in background...` });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message, stack: e.stack });
  }
});

// Debug endpoint — runs 1 game synchronously and returns errors
app.get("/api/simulate-test", async (req, res) => {
  try {
    const { simulateOneGameDebug } = await import("./simulate-games-bg.js");
    const result = await simulateOneGameDebug();
    res.json({ success: true, data: result });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message, stack: e.stack });
  }
});

// ===== START SERVER =====
const PORT = process.env.PORT || 4000;

async function start() {
  const dbReady = await initDatabase();
  if (dbReady) {
    console.log("✅ Database ready — game data will be tracked");

    // Restore any in-progress games from before the restart
    try {
      const restoredRooms = await loadAllGameStates();
      const count = Object.keys(restoredRooms).length;
      if (count > 0) {
        Object.assign(rooms, restoredRooms);
        console.log(`🔄 Restored ${count} active game(s)`);
      }
    } catch (e) {
      console.error("❌ Failed to restore games:", e.message);
    }
  } else {
    console.warn("⚠️  Running without database — game data will NOT be tracked");
  }

  server.listen(PORT, () => console.log(`🚀 Bugger Bridge server running on port ${PORT}`));
}

// Graceful shutdown
process.on("SIGTERM", async () => {
  console.log("Shutting down...");
  await dbShutdown();
  process.exit(0);
});

start();
