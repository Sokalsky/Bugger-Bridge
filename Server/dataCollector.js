// Data Collector for Bugger Bridge
// Logs every game event to Postgres — fire-and-forget, never blocks gameplay

import { query } from "./db.js";

const RANK_VALUES = { A: 13, K: 12, Q: 11, J: 10, "10": 9, "9": 8, "8": 7, "7": 6, "6": 5, "5": 4, "4": 3, "3": 2, "2": 1 };

// ===== HAND ANALYSIS HELPERS =====

function analyzeHand(hand, trump) {
  let highCardCount = 0;
  let trumpCount = 0;
  let totalRankValue = 0;
  const suitCounts = { Hearts: 0, Diamonds: 0, Clubs: 0, Spades: 0 };

  for (const card of hand) {
    const value = RANK_VALUES[card.rank] || 0;
    totalRankValue += value;
    if (value >= 10) highCardCount++;
    if (card.suit === trump) trumpCount++;
    if (suitCounts[card.suit] !== undefined) suitCounts[card.suit]++;
  }

  const voidSuitCount = Object.values(suitCounts).filter(c => c === 0).length;
  const avgRankValue = hand.length > 0 ? totalRankValue / hand.length : 0;

  return { highCardCount, trumpCount, voidSuitCount, avgRankValue: Math.round(avgRankValue * 100) / 100 };
}

// ===== PLAYER MANAGEMENT =====

export async function ensurePlayer(playerId, playerName, isAI) {
  if (!playerId) return;
  try {
    await query(
      `INSERT INTO players (id, name, is_ai, last_seen_at)
       VALUES ($1, $2, $3, NOW())
       ON CONFLICT (id) DO UPDATE SET
         name = EXCLUDED.name,
         last_seen_at = NOW()`,
      [playerId, playerName || "Unknown", isAI || false]
    );
  } catch (err) {
    console.error("❌ ensurePlayer error:", err.message);
  }
}

// ===== GAME LIFECYCLE =====

export async function logGameStart(roomCode, players) {
  try {
    // Ensure all players exist
    for (const p of players) {
      await ensurePlayer(p.id, p.name, p.isAI || false);
    }

    const result = await query(
      `INSERT INTO games (room_code, player_count, total_rounds, started_at)
       VALUES ($1, $2, $3, NOW())
       RETURNING id`,
      [roomCode, players.length, 0]
    );

    if (!result?.rows?.[0]) return null;
    const gameId = result.rows[0].id;

    // Log game_players
    for (let i = 0; i < players.length; i++) {
      await query(
        `INSERT INTO game_players (game_id, player_id, player_name, is_ai, seat_position)
         VALUES ($1, $2, $3, $4, $5)`,
        [gameId, players[i].id, players[i].name, players[i].isAI || false, i]
      );
    }

    console.log(`📊 Game ${gameId} logged (${players.length} players, room: ${roomCode})`);
    return gameId;
  } catch (err) {
    console.error("❌ logGameStart error:", err.message);
    return null;
  }
}

export async function logGameEnd(gameId, scores, players) {
  if (!gameId) return;
  try {
    // Determine winner and positions
    const sorted = Object.entries(scores)
      .sort(([, a], [, b]) => b - a);
    const winnerId = sorted[0]?.[0] || null;

    // Update game record
    await query(
      `UPDATE games SET finished_at = NOW(), winner_id = $1
       WHERE id = $2`,
      [winnerId, gameId]
    );

    // Update total_rounds from actual round count
    await query(
      `UPDATE games SET total_rounds = (SELECT COUNT(*) FROM rounds WHERE game_id = $1)
       WHERE id = $1`,
      [gameId]
    );

    // Update game_players with final scores and positions
    for (let i = 0; i < sorted.length; i++) {
      const [playerId, score] = sorted[i];
      await query(
        `UPDATE game_players SET final_score = $1, finish_position = $2
         WHERE game_id = $3 AND player_id = $4`,
        [score, i + 1, gameId, playerId]
      );
    }

    // Update player aggregate stats
    for (const [playerId, score] of sorted) {
      const isWinner = playerId === winnerId;
      await query(
        `UPDATE players SET
           games_played = games_played + 1,
           games_won = games_won + $1,
           total_score = total_score + $2,
           last_seen_at = NOW()
         WHERE id = $3`,
        [isWinner ? 1 : 0, score, playerId]
      );
    }

    console.log(`📊 Game ${gameId} ended — winner: ${winnerId} (${scores[winnerId]} pts)`);
  } catch (err) {
    console.error("❌ logGameEnd error:", err.message);
  }
}

// ===== ROUND LIFECYCLE =====

export async function logRoundStart(gameId, roundIndex, cardsPerPlayer, trump, dealerIndex, hands, buriedCards) {
  if (!gameId) return null;
  try {
    const result = await query(
      `INSERT INTO rounds (game_id, round_index, cards_per_player, trump_suit, dealer_index, buried_cards)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id`,
      [gameId, roundIndex, cardsPerPlayer, trump, dealerIndex, JSON.stringify(buriedCards || [])]
    );

    if (!result?.rows?.[0]) return null;
    return result.rows[0].id;
  } catch (err) {
    console.error("❌ logRoundStart error:", err.message);
    return null;
  }
}

export async function logBid(roundId, gameId, playerId, bid, bidPosition, hand, cardsPerPlayer, trump, isAI) {
  if (!roundId) return;
  try {
    const { highCardCount, trumpCount, voidSuitCount, avgRankValue } = analyzeHand(hand, trump);

    await query(
      `INSERT INTO round_results
         (round_id, game_id, player_id, bid, bid_position, hand_dealt,
          high_card_count, trump_count, void_suit_count, avg_rank_value,
          cards_per_player, trump_suit, is_ai)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
      [roundId, gameId, playerId, bid, bidPosition,
       JSON.stringify(hand), highCardCount, trumpCount, voidSuitCount, avgRankValue,
       cardsPerPlayer, trump, isAI || false]
    );
  } catch (err) {
    console.error("❌ logBid error:", err.message);
  }
}

export async function logCardPlay(roundId, gameId, trickNumber, playPosition, playerId, card, context) {
  if (!roundId) return;
  try {
    await query(
      `INSERT INTO card_plays
         (round_id, game_id, trick_number, play_position, player_id,
          card_suit, card_rank, trump_suit, lead_suit,
          cards_per_player, cards_remaining, player_bid,
          player_tricks_so_far, tricks_needed, is_ai,
          hand_at_play, trick_state)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)`,
      [
        roundId, gameId, trickNumber, playPosition, playerId,
        card.suit, card.rank, context.trump, context.leadSuit || null,
        context.cardsPerPlayer, context.cardsRemaining, context.playerBid,
        context.playerTricksSoFar, context.tricksNeeded, context.isAI || false,
        JSON.stringify(context.handAtPlay || null),
        JSON.stringify(context.trickState || null)
      ]
    );
  } catch (err) {
    console.error("❌ logCardPlay error:", err.message);
  }
}

export async function logTrickComplete(roundId, gameId, trickNumber, trick, winnerId, trump, cardsPerPlayer) {
  if (!roundId) return;
  try {
    const leadSuit = trick[0]?.card?.suit || "Unknown";
    const winningPlay = trick.find(p => p.playerId === winnerId);
    const winningCard = winningPlay?.card || { suit: "Unknown", rank: "?" };
    const wasTrumped = trick.some(p => p.card.suit === trump && p.card.suit !== leadSuit);

    await query(
      `INSERT INTO trick_results
         (round_id, game_id, trick_number, lead_suit, trump_suit,
          winner_id, winning_card_suit, winning_card_rank, was_trumped, cards_per_player)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [roundId, gameId, trickNumber, leadSuit, trump,
       winnerId, winningCard.suit, winningCard.rank, wasTrumped, cardsPerPlayer]
    );

    // Update won_trick on the winning card_play
    await query(
      `UPDATE card_plays SET won_trick = true
       WHERE round_id = $1 AND trick_number = $2 AND player_id = $3`,
      [roundId, trickNumber, winnerId]
    );
  } catch (err) {
    console.error("❌ logTrickComplete error:", err.message);
  }
}

export async function logRoundEnd(roundId, gameId, bids, tricksWon, scores, players) {
  if (!roundId) return;
  try {
    // Check if this round was already finalized (prevent double-counting)
    const check = await query(
      `SELECT cumulative_score FROM round_results WHERE round_id = $1 AND cumulative_score > 0 LIMIT 1`,
      [roundId]
    );
    if (check?.rows?.length > 0) {
      return; // Already finalized — skip
    }

    for (const player of players) {
      const pid = player.id;
      const bid = bids[pid] || 0;
      const tricks = tricksWon[pid] || 0;
      const metBid = tricks === bid;
      const roundScore = metBid ? 10 + tricks : tricks;
      const cumulativeScore = scores[pid] || 0;

      // Update round_results with final outcome
      await query(
        `UPDATE round_results
         SET tricks_won = $1, met_bid = $2, round_score = $3, cumulative_score = $4
         WHERE round_id = $5 AND player_id = $6`,
        [tricks, metBid, roundScore, cumulativeScore, roundId, pid]
      );

      // Update game_players round tracking (only once per round)
      await query(
        `UPDATE game_players
         SET total_rounds = total_rounds + 1,
             rounds_bid_met = rounds_bid_met + $1
         WHERE game_id = $2 AND player_id = $3`,
        [metBid ? 1 : 0, gameId, pid]
      );

      // Update player aggregate stats (only once per round)
      await query(
        `UPDATE players
         SET total_rounds_played = total_rounds_played + 1,
             total_bids_made = total_bids_made + 1,
             total_bids_met = total_bids_met + $1,
             total_tricks_won = total_tricks_won + $2
         WHERE id = $3`,
        [metBid ? 1 : 0, tricks, pid]
      );
    }
  } catch (err) {
    console.error("❌ logRoundEnd error:", err.message);
  }
}

// ===== STATS QUERIES =====

export async function getOverallStats() {
  try {
    const games = await query(`
      SELECT
        COUNT(*) as total_games,
        COUNT(CASE WHEN finished_at IS NOT NULL THEN 1 END) as completed_games,
        MIN(started_at) as first_game,
        MAX(finished_at) as last_game
      FROM games
    `);

    const plays = await query(`SELECT COUNT(*) as total_plays FROM card_plays`);
    const tricks = await query(`SELECT COUNT(*) as total_tricks FROM trick_results`);
    const rounds = await query(`SELECT COUNT(*) as total_rounds FROM rounds`);

    const bidStats = await query(`
      SELECT
        COUNT(*) as total_bids,
        COUNT(CASE WHEN met_bid THEN 1 END) as bids_met,
        ROUND(100.0 * COUNT(CASE WHEN met_bid THEN 1 END) / NULLIF(COUNT(*), 0), 1) as met_bid_pct
      FROM round_results
    `);

    const aiBidStats = await query(`
      SELECT
        COUNT(*) as total_bids,
        COUNT(CASE WHEN met_bid THEN 1 END) as bids_met,
        ROUND(100.0 * COUNT(CASE WHEN met_bid THEN 1 END) / NULLIF(COUNT(*), 0), 1) as met_bid_pct
      FROM round_results WHERE is_ai = true
    `);

    const humanBidStats = await query(`
      SELECT
        COUNT(*) as total_bids,
        COUNT(CASE WHEN met_bid THEN 1 END) as bids_met,
        ROUND(100.0 * COUNT(CASE WHEN met_bid THEN 1 END) / NULLIF(COUNT(*), 0), 1) as met_bid_pct
      FROM round_results WHERE is_ai = false
    `);

    return {
      games: games?.rows?.[0] || {},
      totalPlays: plays?.rows?.[0]?.total_plays || 0,
      totalTricks: tricks?.rows?.[0]?.total_tricks || 0,
      totalRounds: rounds?.rows?.[0]?.total_rounds || 0,
      bidAccuracy: {
        overall: bidStats?.rows?.[0] || {},
        ai: aiBidStats?.rows?.[0] || {},
        human: humanBidStats?.rows?.[0] || {},
      },
    };
  } catch (err) {
    console.error("❌ getOverallStats error:", err.message);
    return null;
  }
}

export async function getPlayerStats() {
  try {
    const result = await query(`
      SELECT
        p.id,
        p.name,
        p.is_ai,
        p.games_played,
        p.games_won,
        ROUND(100.0 * p.games_won / NULLIF(p.games_played, 0), 1) as win_pct,
        p.total_rounds_played,
        p.total_bids_met,
        ROUND(100.0 * p.total_bids_met / NULLIF(p.total_bids_made, 0), 1) as bid_accuracy_pct,
        p.total_tricks_won,
        p.total_score,
        ROUND(p.total_score::numeric / NULLIF(p.games_played, 0), 1) as avg_score_per_game,
        p.last_seen_at
      FROM players p
      WHERE p.games_played > 0
      ORDER BY p.total_score DESC
    `);
    return result?.rows || [];
  } catch (err) {
    console.error("❌ getPlayerStats error:", err.message);
    return [];
  }
}

export async function getCardStats(cardsPerPlayer = null) {
  try {
    let whereClause = "";
    const params = [];
    if (cardsPerPlayer) {
      whereClause = "WHERE cards_per_player = $1";
      params.push(cardsPerPlayer);
    }

    const result = await query(`
      SELECT
        card_suit,
        card_rank,
        cards_per_player,
        COUNT(*) as times_played,
        COUNT(CASE WHEN won_trick THEN 1 END) as times_won,
        ROUND(100.0 * COUNT(CASE WHEN won_trick THEN 1 END) / NULLIF(COUNT(*), 0), 1) as win_rate,
        ROUND(AVG(CASE WHEN play_position = 1 THEN (CASE WHEN won_trick THEN 100.0 ELSE 0 END) END), 1) as lead_win_rate,
        ROUND(AVG(CASE WHEN play_position > 1 THEN (CASE WHEN won_trick THEN 100.0 ELSE 0 END) END), 1) as follow_win_rate
      FROM card_plays
      ${whereClause}
      GROUP BY card_suit, card_rank, cards_per_player
      HAVING COUNT(*) >= 5
      ORDER BY win_rate DESC
    `, params);
    return result?.rows || [];
  } catch (err) {
    console.error("❌ getCardStats error:", err.message);
    return [];
  }
}

export async function getGameHistory(limit = 20) {
  try {
    const result = await query(`
      SELECT
        g.id,
        g.room_code,
        g.player_count,
        g.total_rounds,
        g.started_at,
        g.finished_at,
        g.winner_id,
        json_agg(json_build_object(
          'player_id', gp.player_id,
          'player_name', gp.player_name,
          'is_ai', gp.is_ai,
          'final_score', gp.final_score,
          'finish_position', gp.finish_position,
          'rounds_bid_met', gp.rounds_bid_met,
          'total_rounds', gp.total_rounds
        ) ORDER BY gp.finish_position) as players
      FROM games g
      JOIN game_players gp ON g.id = gp.game_id
      WHERE g.finished_at IS NOT NULL
      GROUP BY g.id
      ORDER BY g.finished_at DESC
      LIMIT $1
    `, [limit]);
    return result?.rows || [];
  } catch (err) {
    console.error("❌ getGameHistory error:", err.message);
    return [];
  }
}

export async function getBidAnalysis() {
  try {
    const result = await query(`
      SELECT
        cards_per_player,
        trump_suit,
        ROUND(AVG(bid), 2) as avg_bid,
        ROUND(AVG(tricks_won), 2) as avg_tricks,
        ROUND(100.0 * COUNT(CASE WHEN met_bid THEN 1 END) / NULLIF(COUNT(*), 0), 1) as met_bid_pct,
        COUNT(*) as sample_size
      FROM round_results
      GROUP BY cards_per_player, trump_suit
      HAVING COUNT(*) >= 3
      ORDER BY cards_per_player DESC, trump_suit
    `);
    return result?.rows || [];
  } catch (err) {
    console.error("❌ getBidAnalysis error:", err.message);
    return [];
  }
}
