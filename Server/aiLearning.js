// AI Learning Module for Bugger Bridge
// Queries the database for statistical and pattern-based insights
// Returns null/empty when insufficient data — AI falls back to heuristics

import { query } from "./db.js";

const RANK_VALUES = { A: 13, K: 12, Q: 11, J: 10, "10": 9, "9": 8, "8": 7, "7": 6, "6": 5, "5": 4, "4": 3, "3": 2, "2": 1 };

// Minimum samples before we trust the data
const MIN_CARD_SAMPLES = 5;
const MIN_BID_SAMPLES = 3;
const MIN_PATTERN_GAMES = 20; // pattern matching kicks in earlier than planned — learn fast

// ===== CARD WIN RATE LOOKUP =====

/**
 * Get the win rate for a specific card in a given context.
 * Weighted by success: plays from players who met their bid count 2x.
 *
 * @returns {{ winRate: number, sampleSize: number } | null}
 */
export async function getCardWinRate(cardSuit, cardRank, context) {
  try {
    const result = await query(`
      SELECT
        COUNT(*) as total,
        SUM(CASE WHEN cp.won_trick THEN 1 ELSE 0 END) as wins,
        SUM(CASE
          WHEN cp.won_trick AND rr.met_bid THEN 2
          WHEN cp.won_trick THEN 1
          ELSE 0
        END) as weighted_wins,
        SUM(CASE
          WHEN rr.met_bid THEN 2
          ELSE 1
        END) as weighted_total
      FROM card_plays cp
      LEFT JOIN round_results rr ON cp.round_id = rr.round_id AND cp.player_id = rr.player_id
      WHERE cp.card_suit = $1
        AND cp.card_rank = $2
        AND cp.cards_per_player = $3
        AND cp.trump_suit = $4
        AND cp.play_position = $5
    `, [cardSuit, cardRank, context.cardsPerPlayer, context.trump, context.playPosition]);

    const row = result?.rows?.[0];
    if (!row || parseInt(row.total) < MIN_CARD_SAMPLES) return null;

    const weightedWins = parseFloat(row.weighted_wins) || 0;
    const weightedTotal = parseFloat(row.weighted_total) || 1;

    return {
      winRate: weightedWins / weightedTotal,
      sampleSize: parseInt(row.total),
    };
  } catch (err) {
    console.error("❌ getCardWinRate error:", err.message);
    return null;
  }
}

/**
 * Get win rates for ALL cards in a hand at once (batch query — much faster).
 * Returns a map: "suit|rank" → { winRate, sampleSize }
 */
export async function getBatchCardWinRates(hand, context) {
  if (!hand || hand.length === 0) return {};

  try {
    // Build a single query for all cards in hand
    const cardConditions = hand.map((_, i) => `(cp.card_suit = $${i * 2 + 5} AND cp.card_rank = $${i * 2 + 6})`).join(" OR ");
    const cardParams = hand.flatMap(c => [c.suit, c.rank]);

    const result = await query(`
      SELECT
        cp.card_suit,
        cp.card_rank,
        COUNT(*) as total,
        SUM(CASE
          WHEN cp.won_trick AND rr.met_bid THEN 2.0
          WHEN cp.won_trick THEN 1.0
          ELSE 0
        END) as weighted_wins,
        SUM(CASE
          WHEN rr.met_bid THEN 2.0
          ELSE 1.0
        END) as weighted_total
      FROM card_plays cp
      LEFT JOIN round_results rr ON cp.round_id = rr.round_id AND cp.player_id = rr.player_id
      WHERE cp.cards_per_player = $1
        AND cp.trump_suit = $2
        AND cp.play_position = $3
        AND cp.tricks_needed ${context.tricksNeeded > 0 ? "> 0" : context.tricksNeeded === 0 ? "= 0" : "< 0"}
        AND (${cardConditions})
      GROUP BY cp.card_suit, cp.card_rank
    `, [context.cardsPerPlayer, context.trump, context.playPosition, ...cardParams]);

    const rates = {};
    for (const row of (result?.rows || [])) {
      if (parseInt(row.total) < MIN_CARD_SAMPLES) continue;
      const key = `${row.card_suit}|${row.card_rank}`;
      rates[key] = {
        winRate: parseFloat(row.weighted_wins) / parseFloat(row.weighted_total),
        sampleSize: parseInt(row.total),
      };
    }
    return rates;
  } catch (err) {
    console.error("❌ getBatchCardWinRates error:", err.message);
    return {};
  }
}

// ===== BID ESTIMATION =====

/**
 * Estimate the best bid based on similar past hands.
 * Looks for round_results with similar hand profiles.
 *
 * @returns {{ suggestedBid: number, confidence: number, sampleSize: number } | null}
 */
export async function getBidEstimate(handProfile, cardsPerPlayer, trump) {
  try {
    // Find similar hands: ±1 on high cards, ±1 on trump count, same void range
    const result = await query(`
      SELECT
        rr.bid,
        rr.tricks_won,
        rr.met_bid,
        rr.round_score,
        ABS(rr.high_card_count - $1) + ABS(rr.trump_count - $2) + ABS(rr.void_suit_count - $3) as distance
      FROM round_results rr
      WHERE rr.cards_per_player = $4
        AND rr.trump_suit = $5
        AND rr.high_card_count BETWEEN $1 - 2 AND $1 + 2
        AND rr.trump_count BETWEEN $2 - 2 AND $2 + 2
      ORDER BY distance ASC
      LIMIT 50
    `, [handProfile.highCardCount, handProfile.trumpCount, handProfile.voidSuitCount, cardsPerPlayer, trump]);

    const rows = result?.rows || [];
    if (rows.length < MIN_BID_SAMPLES) return null;

    // Weight by success and distance — closer hands that met bid count more
    let weightedBidSum = 0;
    let weightTotal = 0;

    for (const row of rows) {
      const distance = parseFloat(row.distance) || 0;
      const distanceWeight = 1 / (1 + distance); // closer = higher weight
      const successWeight = row.met_bid ? 2.0 : 0.5; // met bid = much higher weight
      const weight = distanceWeight * successWeight;

      weightedBidSum += row.bid * weight;
      weightTotal += weight;
    }

    const suggestedBid = Math.round(weightedBidSum / weightTotal);
    const metBidCount = rows.filter(r => r.met_bid).length;
    const confidence = metBidCount / rows.length; // what % of similar hands met their bid

    return {
      suggestedBid: Math.max(0, Math.min(cardsPerPlayer, suggestedBid)),
      confidence,
      sampleSize: rows.length,
    };
  } catch (err) {
    console.error("❌ getBidEstimate error:", err.message);
    return null;
  }
}

// ===== PATTERN MATCHING — SITUATION VECTORS =====

/**
 * Find similar past card-play situations and see what worked.
 * Returns the best card to play based on pattern matching.
 *
 * @returns {{ recommendedCards: Array<{suit, rank, score}>, sampleSize: number } | null}
 */
export async function getPatternMatch(hand, context) {
  try {
    // Check if we have enough games for pattern matching
    const countResult = await query(`SELECT COUNT(DISTINCT game_id) as game_count FROM rounds`);
    const gameCount = parseInt(countResult?.rows?.[0]?.game_count || 0);
    if (gameCount < MIN_PATTERN_GAMES) return null;

    // Find similar situations: same round size, similar trick need, similar position
    const result = await query(`
      SELECT
        cp.card_suit,
        cp.card_rank,
        cp.won_trick,
        rr.met_bid,
        rr.round_score,
        ABS(cp.tricks_needed - $1) as need_distance,
        ABS(cp.cards_remaining - $2) as hand_distance
      FROM card_plays cp
      JOIN round_results rr ON cp.round_id = rr.round_id AND cp.player_id = rr.player_id
      WHERE cp.cards_per_player = $3
        AND cp.trump_suit = $4
        AND cp.play_position = $5
        AND cp.tricks_needed BETWEEN $1 - 1 AND $1 + 1
        AND cp.cards_remaining BETWEEN $2 - 2 AND $2 + 2
      ORDER BY need_distance ASC, hand_distance ASC
      LIMIT 100
    `, [context.tricksNeeded, context.cardsRemaining, context.cardsPerPlayer, context.trump, context.playPosition]);

    const rows = result?.rows || [];
    if (rows.length < 10) return null;

    // Score each card type by how well it worked in similar situations
    const cardScores = {};

    for (const row of rows) {
      const key = `${row.card_suit}|${row.card_rank}`;
      if (!cardScores[key]) {
        cardScores[key] = { suit: row.card_suit, rank: row.card_rank, totalScore: 0, count: 0 };
      }

      // Score: met_bid is the ultimate success metric
      // A play that helped the player meet their bid is great
      // A play that won a trick when needed is good
      const needDistance = parseFloat(row.need_distance) || 0;
      const weight = 1 / (1 + needDistance);

      let playScore = 0;
      if (row.met_bid) {
        playScore = 10; // best outcome
      } else if (row.won_trick && context.tricksNeeded > 0) {
        playScore = 5; // won when needed but didn't ultimately meet bid
      } else if (!row.won_trick && context.tricksNeeded <= 0) {
        playScore = 7; // correctly ducked
      } else {
        playScore = 1; // poor outcome
      }

      cardScores[key].totalScore += playScore * weight;
      cardScores[key].count += weight;
    }

    // Filter to only cards in hand, then sort by average score
    const recommendations = [];
    for (const card of hand) {
      const key = `${card.suit}|${card.rank}`;
      const entry = cardScores[key];
      if (entry && entry.count > 0) {
        recommendations.push({
          suit: card.suit,
          rank: card.rank,
          score: entry.totalScore / entry.count,
          sampleSize: Math.round(entry.count),
        });
      }
    }

    recommendations.sort((a, b) => b.score - a.score);

    return {
      recommendedCards: recommendations,
      sampleSize: rows.length,
    };
  } catch (err) {
    console.error("❌ getPatternMatch error:", err.message);
    return null;
  }
}

// ===== COMBINED LEARNING INTERFACE =====

/**
 * Get all available learning data for a card play decision.
 * This is the main entry point called by the server before AI plays.
 */
export async function getPlayLearningData(hand, currentTrick, trump, bid, tricksWon, cardsPerPlayer) {
  try {
    const playPosition = currentTrick.length + 1; // 1 = leading
    const tricksNeeded = bid - tricksWon;
    const cardsRemaining = hand.length;

    const context = { cardsPerPlayer, trump, playPosition, tricksNeeded, cardsRemaining };

    // Fire both queries in parallel
    const [winRates, patterns] = await Promise.all([
      getBatchCardWinRates(hand, context),
      getPatternMatch(hand, context),
    ]);

    return {
      winRates,       // { "suit|rank": { winRate, sampleSize } }
      patterns,       // { recommendedCards: [...], sampleSize } or null
      context,
    };
  } catch (err) {
    console.error("❌ getPlayLearningData error:", err.message);
    return null;
  }
}

/**
 * Get learning data for a bidding decision.
 */
export async function getBidLearningData(hand, cardsPerPlayer, trump) {
  try {
    let highCardCount = 0;
    let trumpCount = 0;
    const suitCounts = { Hearts: 0, Diamonds: 0, Clubs: 0, Spades: 0 };

    for (const card of hand) {
      const value = RANK_VALUES[card.rank] || 0;
      if (value >= 10) highCardCount++;
      if (card.suit === trump) trumpCount++;
      if (suitCounts[card.suit] !== undefined) suitCounts[card.suit]++;
    }

    const voidSuitCount = Object.values(suitCounts).filter(c => c === 0).length;
    const handProfile = { highCardCount, trumpCount, voidSuitCount };

    const bidEstimate = await getBidEstimate(handProfile, cardsPerPlayer, trump);
    return bidEstimate; // { suggestedBid, confidence, sampleSize } or null
  } catch (err) {
    console.error("❌ getBidLearningData error:", err.message);
    return null;
  }
}
