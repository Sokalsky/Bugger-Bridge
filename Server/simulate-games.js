// Simulate AI-vs-AI games to build up training data
// Uses the real data collection pipeline so everything gets logged to Postgres

import { dealCards, getTrump } from "./gameLogic.js";
import { calculateAIBid, selectAICard } from "./aiLogic.js";
import { initDatabase } from "./db.js";
import {
  logGameStart, logGameEnd, logRoundStart, logRoundEnd,
  logBid, logCardPlay, logTrickComplete,
} from "./dataCollector.js";

const RANK_ORDER = ["2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K", "A"];
function rankToValue(r) { return RANK_ORDER.indexOf(r); }
function sortHand(cards) {
  const so = ["Spades", "Hearts", "Diamonds", "Clubs"];
  return cards.sort((a, b) => {
    const s = so.indexOf(a.suit) - so.indexOf(b.suit);
    return s !== 0 ? s : rankToValue(a.rank) - rankToValue(b.rank);
  });
}
function determineTrickWinner(trick, trump) {
  const ls = trick[0].card.suit;
  let w = trick[0];
  for (const p of trick) {
    const c = p.card;
    if (c.suit === w.card.suit && rankToValue(c.rank) > rankToValue(w.card.rank)) w = p;
    else if (c.suit === trump && w.card.suit !== trump) w = p;
  }
  return w.playerId;
}
function buildRoundSequence(pc) {
  const max = Math.floor(52 / pc);
  const seq = [];
  for (let i = max; i >= 1; i--) seq.push(i);
  for (let i = 1; i < pc; i++) seq.push(1);
  for (let i = 2; i <= max; i++) seq.push(i);
  return seq;
}
function getBiddingOrder(players, ri) {
  const di = ri % players.length;
  const o = [];
  for (let i = 1; i <= players.length; i++) o.push(players[(di + i) % players.length].id);
  return o;
}

async function simulateGame(gameNum, players) {
  const roomCode = `SIM${gameNum}`;
  const roundSequence = buildRoundSequence(players.length);

  // Log game start
  const gameId = await logGameStart(roomCode, players);
  if (!gameId) { console.log(`  ❌ Failed to log game start`); return null; }

  const scores = Object.fromEntries(players.map(p => [p.id, 0]));
  let totalBidsMet = 0;
  let totalBids = 0;

  for (let ri = 0; ri < roundSequence.length; ri++) {
    const cardsPerPlayer = roundSequence[ri];
    const trump = getTrump(ri % 5);

    // Deal
    const { hands, buriedCards } = dealCards(players, cardsPerPlayer);
    for (const pid in hands) hands[pid] = sortHand(hands[pid]);

    const dealerIndex = ri % players.length;
    const roundId = await logRoundStart(gameId, ri, cardsPerPlayer, trump, dealerIndex, hands, buriedCards);

    // Bidding
    const biddingOrder = getBiddingOrder(players, ri);
    const bids = {};
    for (let bi = 0; bi < players.length; bi++) {
      const bidderId = biddingOrder[bi];
      const hand = hands[bidderId];
      const isLast = bi === players.length - 1;
      const bid = calculateAIBid(hand, cardsPerPlayer, trump, bids, players.length, isLast, null);
      bids[bidderId] = bid;
      const bidder = players.find(p => p.id === bidderId);
      await logBid(roundId, gameId, bidderId, bid, bi + 1, hand, cardsPerPlayer, trump, true);
    }

    // Play
    const tricksWon = Object.fromEntries(players.map(p => [p.id, 0]));
    const playOrder = [...biddingOrder];
    let currentTurnIndex = 0;
    let trickNumber = 0;

    for (let t = 0; t < cardsPerPlayer; t++) {
      const currentTrick = [];
      for (let p = 0; p < players.length; p++) {
        const playerId = playOrder[currentTurnIndex];
        const hand = hands[playerId];
        const card = selectAICard(hand, currentTrick, trump, bids[playerId], tricksWon[playerId], null);

        if (!card) {
          console.log(`  ❌ null card for ${playerId} in round ${ri + 1} trick ${t + 1}`);
          break;
        }

        // Log card play
        const playerBid = bids[playerId] || 0;
        const playerTricks = tricksWon[playerId] || 0;
        await logCardPlay(roundId, gameId, t + 1, p + 1, playerId, card, {
          trump, leadSuit: currentTrick[0]?.card.suit || null,
          cardsPerPlayer, cardsRemaining: hand.length - 1,
          playerBid, playerTricksSoFar: playerTricks,
          tricksNeeded: playerBid - playerTricks, isAI: true,
        });

        // Remove card from hand
        hands[playerId] = hand.filter(c => !(c.rank === card.rank && c.suit === card.suit));
        currentTrick.push({ playerId, card });
        currentTurnIndex = (currentTurnIndex + 1) % players.length;
      }

      // Resolve trick
      trickNumber++;
      const winner = determineTrickWinner(currentTrick, trump);
      tricksWon[winner]++;
      await logTrickComplete(roundId, gameId, trickNumber, currentTrick, winner, trump, cardsPerPlayer);

      // Winner leads next
      const wi = playOrder.indexOf(winner);
      currentTurnIndex = wi !== -1 ? wi : 0;
    }

    // Score round
    for (const p of players) {
      const tricks = tricksWon[p.id] || 0;
      const bid = bids[p.id] || 0;
      const met = tricks === bid;
      scores[p.id] += met ? 10 + tricks : tricks;
      if (met) totalBidsMet++;
      totalBids++;
    }

    await logRoundEnd(roundId, gameId, bids, tricksWon, scores, players);
  }

  // Game end
  await logGameEnd(gameId, scores, players);

  const winner = Object.entries(scores).sort(([, a], [, b]) => b - a)[0];
  const winnerName = players.find(p => p.id === winner[0])?.name;
  return {
    gameId, winner: winnerName, winnerScore: winner[1], scores,
    bidAccuracy: Math.round(100 * totalBidsMet / totalBids) + "%",
  };
}

// ===== MAIN =====
const NUM_GAMES = parseInt(process.argv[2]) || 10;

console.log(`\n🎮 Simulating ${NUM_GAMES} AI-vs-AI games...\n`);

const dbReady = await initDatabase();
if (!dbReady) {
  console.error("❌ Database not available — can't log games");
  process.exit(1);
}

const players = [
  { id: "sim_alice", name: "Sim Alice", isAI: true },
  { id: "sim_bob", name: "Sim Bob", isAI: true },
  { id: "sim_charlie", name: "Sim Charlie", isAI: true },
  { id: "sim_diana", name: "Sim Diana", isAI: true },
];

const results = [];
for (let g = 1; g <= NUM_GAMES; g++) {
  const start = Date.now();
  const result = await simulateGame(g, players);
  const elapsed = ((Date.now() - start) / 1000).toFixed(1);

  if (result) {
    results.push(result);
    console.log(`  Game ${g}/${NUM_GAMES}: ${result.winner} wins (${result.winnerScore} pts) | Bid accuracy: ${result.bidAccuracy} | ${elapsed}s`);
  } else {
    console.log(`  Game ${g}/${NUM_GAMES}: FAILED | ${elapsed}s`);
  }
}

console.log(`\n✅ Completed ${results.length}/${NUM_GAMES} games`);

const totalCardPlays = results.length * 28 * 13; // approximate
console.log(`📊 ~${totalCardPlays} card plays logged to database`);

const wins = {};
for (const r of results) {
  wins[r.winner] = (wins[r.winner] || 0) + 1;
}
console.log(`🏆 Wins:`, wins);

process.exit(0);
