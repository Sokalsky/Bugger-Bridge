// Background AI-vs-AI game simulator
// Called by the /api/simulate endpoint

import { dealCards, getTrump } from "./gameLogic.js";
import { calculateAIBid, selectAICard } from "./aiLogic.js";
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

async function simulateOneGame(gameNum, players) {
  const roomCode = `SIM${gameNum}_${Date.now()}`;
  const roundSequence = buildRoundSequence(players.length);
  const gameId = await logGameStart(roomCode, players);
  if (!gameId) return null;

  const scores = Object.fromEntries(players.map(p => [p.id, 0]));
  let totalBidsMet = 0, totalBids = 0;

  for (let ri = 0; ri < roundSequence.length; ri++) {
    const cardsPerPlayer = roundSequence[ri];
    const trump = getTrump(ri % 5);
    const { hands, buriedCards } = dealCards(players, cardsPerPlayer);
    for (const pid in hands) hands[pid] = sortHand(hands[pid]);

    const dealerIndex = ri % players.length;
    const roundId = await logRoundStart(gameId, ri, cardsPerPlayer, trump, dealerIndex, hands, buriedCards);

    // Bidding
    const biddingOrder = getBiddingOrder(players, ri);
    const bids = {};
    for (let bi = 0; bi < players.length; bi++) {
      const bidderId = biddingOrder[bi];
      const isLast = bi === players.length - 1;
      const bid = calculateAIBid(hands[bidderId], cardsPerPlayer, trump, bids, players.length, isLast, null);
      bids[bidderId] = bid;
      await logBid(roundId, gameId, bidderId, bid, bi + 1, hands[bidderId], cardsPerPlayer, trump, true);
    }

    // Play tricks
    const tricksWon = Object.fromEntries(players.map(p => [p.id, 0]));
    const playOrder = [...biddingOrder];
    let turnIdx = 0;

    for (let t = 0; t < cardsPerPlayer; t++) {
      const trick = [];
      for (let p = 0; p < players.length; p++) {
        const pid = playOrder[turnIdx];
        const hand = hands[pid];
        const card = selectAICard(hand, trick, trump, bids[pid], tricksWon[pid], null);
        if (!card) break;

        await logCardPlay(roundId, gameId, t + 1, p + 1, pid, card, {
          trump, leadSuit: trick[0]?.card.suit || null,
          cardsPerPlayer, cardsRemaining: hand.length - 1,
          playerBid: bids[pid], playerTricksSoFar: tricksWon[pid],
          tricksNeeded: bids[pid] - tricksWon[pid], isAI: true,
        });

        hands[pid] = hand.filter(c => !(c.rank === card.rank && c.suit === card.suit));
        trick.push({ playerId: pid, card });
        turnIdx = (turnIdx + 1) % players.length;
      }

      const winner = determineTrickWinner(trick, trump);
      tricksWon[winner]++;
      await logTrickComplete(roundId, gameId, t + 1, trick, winner, trump, cardsPerPlayer);
      turnIdx = playOrder.indexOf(winner);
    }

    // Score
    for (const p of players) {
      const met = tricksWon[p.id] === bids[p.id];
      scores[p.id] += met ? 10 + tricksWon[p.id] : tricksWon[p.id];
      if (met) totalBidsMet++;
      totalBids++;
    }
    await logRoundEnd(roundId, gameId, bids, tricksWon, scores, players);
  }

  await logGameEnd(gameId, scores, players);

  const sorted = Object.entries(scores).sort(([, a], [, b]) => b - a);
  return {
    gameId,
    winner: players.find(p => p.id === sorted[0][0])?.name,
    winnerScore: sorted[0][1],
    bidAccuracy: Math.round(100 * totalBidsMet / totalBids),
  };
}

// Debug version — tests DB directly and returns detailed errors
export async function simulateOneGameDebug() {
  const { getPool } = await import("./db.js");
  const pool = getPool();
  if (!pool) return { error: "No database pool" };

  const players = [
    { id: "sim_alice", name: "Sim Alice", isAI: true },
    { id: "sim_bob", name: "Sim Bob", isAI: true },
    { id: "sim_charlie", name: "Sim Charlie", isAI: true },
    { id: "sim_diana", name: "Sim Diana", isAI: true },
  ];

  const errors = [];

  // Step 1: Test ensurePlayer
  for (const p of players) {
    try {
      await pool.query(
        `INSERT INTO players (id, name, is_ai, last_seen_at)
         VALUES ($1, $2, $3, NOW())
         ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, last_seen_at = NOW()`,
        [p.id, p.name, true]
      );
    } catch (e) {
      errors.push({ step: "ensurePlayer", player: p.id, error: e.message });
    }
  }
  if (errors.length > 0) return { errors };

  // Step 2: Test game insert
  let gameId;
  try {
    const r = await pool.query(
      `INSERT INTO games (room_code, player_count, total_rounds, started_at)
       VALUES ($1, $2, $3, NOW()) RETURNING id`,
      ["DBGTEST", 4, 0]
    );
    gameId = r.rows[0].id;
  } catch (e) {
    return { errors: [{ step: "insertGame", error: e.message }] };
  }

  // Step 3: Test game_players insert
  for (let i = 0; i < players.length; i++) {
    try {
      await pool.query(
        `INSERT INTO game_players (game_id, player_id, player_name, is_ai, seat_position)
         VALUES ($1, $2, $3, $4, $5)`,
        [gameId, players[i].id, players[i].name, true, i]
      );
    } catch (e) {
      errors.push({ step: "insertGamePlayer", player: players[i].id, error: e.message });
    }
  }
  if (errors.length > 0) return { gameId, errors };

  // Step 4: Run actual simulation
  try {
    const result = await simulateOneGame(1, players);
    return { gameId: gameId, simResult: result, dbTest: "all steps passed" };
  } catch (e) {
    return { gameId, errors: [{ step: "simulateOneGame", error: e.message, stack: e.stack }] };
  }
}

export async function simulateGames(numGames) {
  const players = [
    { id: "sim_alice", name: "Sim Alice", isAI: true },
    { id: "sim_bob", name: "Sim Bob", isAI: true },
    { id: "sim_charlie", name: "Sim Charlie", isAI: true },
    { id: "sim_diana", name: "Sim Diana", isAI: true },
  ];

  const results = [];
  const wins = {};

  for (let g = 1; g <= numGames; g++) {
    try {
      const result = await simulateOneGame(g, players);
      if (result) {
        results.push(result);
        wins[result.winner] = (wins[result.winner] || 0) + 1;
        console.log(`🎮 Sim ${g}/${numGames}: ${result.winner} wins (${result.winnerScore} pts) | Bid acc: ${result.bidAccuracy}%`);
      }
    } catch (e) {
      console.error(`❌ Sim ${g} error:`, e.message);
    }
  }

  console.log(`\n✅ ${results.length}/${numGames} games simulated | Wins:`, wins);
  return { results, wins, gamesCompleted: results.length };
}
