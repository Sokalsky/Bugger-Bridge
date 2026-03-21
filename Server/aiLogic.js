// AI Logic for Bugger Bridge
// Handles AI bidding and card play decisions

const RANK_VALUES = { A: 13, K: 12, Q: 11, J: 10, "10": 9, "9": 8, "8": 7, "7": 6, "6": 5, "5": 4, "4": 3, "3": 2, "2": 1 };

/**
 * Calculate a reasonable bid for an AI player
 * @param {Array} hand - The AI's hand
 * @param {number} roundCards - Number of cards in this round
 * @param {string} trump - The trump suit for this round
 * @param {Object} existingBids - Bids already made by other players
 * @param {number} playerCount - Total number of players
 * @param {boolean} isLastBidder - Whether this AI is the last to bid (dealer)
 * @returns {number} The bid amount
 */
export function calculateAIBid(hand, roundCards, trump, existingBids, playerCount, isLastBidder = false, learningData = null) {
  let highCardCount = 0;
  let trumpCount = 0;
  let totalValue = 0;
  let trumpHighCount = 0;
  let voidSuits = new Set(["Hearts", "Diamonds", "Clubs", "Spades"]);

  for (const card of hand) {
    const value = RANK_VALUES[card.rank] || 0;
    totalValue += value;
    voidSuits.delete(card.suit);

    if (value >= 10) { // A, K, Q, J, 10
      highCardCount++;
    }

    if (card.suit === trump) {
      trumpCount++;
      if (value >= 10) {
        trumpHighCount++;
      }
    }
  }

  // Estimate tricks — high cards in trump are more reliable winners
  // Non-trump high cards are worth ~0.5 tricks, trump high cards ~0.8
  const nonTrumpHighCards = highCardCount - trumpHighCount;
  let estimatedTricks = 0;

  if (trump === "No Trump") {
    // In No Trump, high cards are more valuable, long suits matter
    estimatedTricks = Math.floor(highCardCount * 0.55);
  } else {
    estimatedTricks = Math.floor(nonTrumpHighCards * 0.45) + Math.floor(trumpHighCount * 0.8);
    // Low trump cards can still win by trumping in on void suits
    const lowTrump = trumpCount - trumpHighCount;
    estimatedTricks += Math.floor(Math.min(lowTrump, voidSuits.size) * 0.5);
  }

  // Adjust based on hand strength
  const avgValue = totalValue / hand.length;
  if (avgValue > 9) {
    estimatedTricks += 1;
  } else if (avgValue < 4.5) {
    estimatedTricks = Math.max(0, estimatedTricks - 1);
  }

  // Clamp to valid range
  estimatedTricks = Math.max(0, Math.min(roundCards, estimatedTricks));

  // ===== BLEND WITH LEARNING DATA =====
  if (learningData && learningData.sampleSize >= 3) {
    const learnedBid = learningData.suggestedBid;
    const confidence = learningData.confidence;
    const samples = learningData.sampleSize;

    // More data = more trust in the learned bid
    // 3-10 samples: 25% learned, 75% heuristic
    // 10-30 samples: 50/50
    // 30+ samples: 70% learned, 30% heuristic
    let learnWeight;
    if (samples >= 30) {
      learnWeight = 0.7;
    } else if (samples >= 10) {
      learnWeight = 0.5;
    } else {
      learnWeight = 0.25;
    }

    // Scale weight by confidence (how often similar hands actually met their bid)
    learnWeight *= Math.max(0.3, confidence);

    estimatedTricks = Math.round(estimatedTricks * (1 - learnWeight) + learnedBid * learnWeight);
    estimatedTricks = Math.max(0, Math.min(roundCards, estimatedTricks));
  }

  // Add some randomness for variety (±1)
  const randomAdjust = Math.floor(Math.random() * 3) - 1; // -1, 0, or 1
  let finalBid = Math.max(0, Math.min(roundCards, estimatedTricks + randomAdjust));

  // ONLY the last bidder is restricted from making total = roundCards
  if (isLastBidder) {
    const bidsSoFar = Object.values(existingBids).reduce((sum, bid) => sum + bid, 0);
    if (bidsSoFar + finalBid === roundCards) {
      // Try nearby bids first (prefer closest to our estimate)
      const candidates = [];
      for (let b = 0; b <= roundCards; b++) {
        if (bidsSoFar + b !== roundCards) {
          candidates.push(b);
        }
      }
      // Pick the candidate closest to our original estimate
      candidates.sort((a, b) => Math.abs(a - estimatedTricks) - Math.abs(b - estimatedTricks));
      finalBid = candidates[0] ?? 0;
    }
  }

  return Math.max(0, Math.min(roundCards, finalBid));
}

/**
 * Select a card for the AI to play
 * @param {Array} hand - The AI's hand
 * @param {Array} currentTrick - Cards already played in this trick
 * @param {string} trump - The trump suit
 * @param {number} bid - The AI's bid for this round
 * @param {number} tricksWon - How many tricks the AI has won so far
 * @returns {Object} The card to play
 */
export function selectAICard(hand, currentTrick, trump, bid = 0, tricksWon = 0, learningData = null) {
  if (hand.length === 0) return null;

  const leadSuit = currentTrick.length > 0 ? currentTrick[0].card.suit : null;
  const tricksNeeded = bid - tricksWon;
  const tricksRemaining = hand.length;
  const wantToWin = tricksNeeded > 0;
  const metBid = tricksNeeded === 0;
  const overBid = tricksNeeded < 0;

  // ===== TRY LEARNING-BASED DECISION FIRST =====
  const learnedCard = selectFromLearning(hand, learningData, leadSuit, trump);
  if (learnedCard) return learnedCard;

  // ===== FALL BACK TO HEURISTICS =====

  // --- LEADING ---
  if (!leadSuit) {
    return selectLead(hand, trump, wantToWin, metBid);
  }

  // --- FOLLOWING SUIT ---
  const followSuitCards = hand.filter(c => c.suit === leadSuit);

  if (followSuitCards.length > 0) {
    return selectFollowSuit(followSuitCards, currentTrick, trump, leadSuit, wantToWin, metBid);
  }

  // --- VOID IN LEAD SUIT ---
  return selectVoid(hand, currentTrick, trump, wantToWin, metBid);
}

/**
 * Try to pick a card based on learning data.
 * Returns null if no sufficient data — falls back to heuristics.
 */
function selectFromLearning(hand, learningData, leadSuit, trump) {
  if (!learningData) return null;

  const { winRates, patterns } = learningData;

  // Determine valid cards (must follow suit if possible)
  let validCards = hand;
  if (leadSuit) {
    const followSuitCards = hand.filter(c => c.suit === leadSuit);
    if (followSuitCards.length > 0) validCards = followSuitCards;
  }

  // Try pattern matching first (higher signal when available)
  if (patterns && patterns.recommendedCards && patterns.recommendedCards.length > 0) {
    const patternPicks = patterns.recommendedCards.filter(rec =>
      validCards.some(c => c.suit === rec.suit && c.rank === rec.rank)
    );

    if (patternPicks.length > 0 && patternPicks[0].sampleSize >= 3) {
      const best = patternPicks[0];
      return validCards.find(c => c.suit === best.suit && c.rank === best.rank) || null;
    }
  }

  // Try win rate data
  if (winRates && Object.keys(winRates).length > 0) {
    // Score each valid card: if we want to win, prefer high win rate; if ducking, prefer low
    const tricksNeeded = learningData.context?.tricksNeeded ?? 1;
    const wantToWin = tricksNeeded > 0;

    const scored = validCards.map(card => {
      const key = `${card.suit}|${card.rank}`;
      const data = winRates[key];
      if (!data) return { card, score: -1 }; // no data, skip

      // If we want to win, score by win rate. If ducking, score by inverse.
      const score = wantToWin ? data.winRate : (1 - data.winRate);
      return { card, score, sampleSize: data.sampleSize };
    }).filter(s => s.score >= 0 && s.sampleSize >= 5);

    // Only use if we have data for at least 2 cards (need comparison)
    if (scored.length >= 2) {
      scored.sort((a, b) => b.score - a.score);
      return scored[0].card;
    }
  }

  return null; // not enough data, fall back to heuristics
}

// ===== INTERNAL HELPERS =====

function sortHighToLow(cards) {
  return [...cards].sort((a, b) => RANK_VALUES[b.rank] - RANK_VALUES[a.rank]);
}

function sortLowToHigh(cards) {
  return [...cards].sort((a, b) => RANK_VALUES[a.rank] - RANK_VALUES[b.rank]);
}

/**
 * Choose a card when leading a trick
 */
function selectLead(hand, trump, wantToWin, metBid) {
  const trumpCards = hand.filter(c => c.suit === trump);
  const nonTrumpCards = hand.filter(c => c.suit !== trump);

  if (metBid) {
    // We've hit our bid — lead low to avoid winning more tricks
    if (nonTrumpCards.length > 0) {
      return sortLowToHigh(nonTrumpCards)[0];
    }
    return sortLowToHigh(trumpCards)[0];
  }

  if (wantToWin) {
    // We need tricks — lead strong
    // Lead high trump if we have many, otherwise lead high non-trump
    if (trumpCards.length >= 3 && Math.random() < 0.5) {
      return sortHighToLow(trumpCards)[0];
    }
    if (nonTrumpCards.length > 0) {
      return sortHighToLow(nonTrumpCards)[0];
    }
    return sortHighToLow(trumpCards)[0];
  }

  // Over-bid (shouldn't win more) — lead lowest
  if (nonTrumpCards.length > 0) {
    return sortLowToHigh(nonTrumpCards)[0];
  }
  return sortLowToHigh(trumpCards)[0];
}

/**
 * Choose a card when following suit
 */
function selectFollowSuit(followSuitCards, currentTrick, trump, leadSuit, wantToWin, metBid) {
  const currentWinner = getTrickWinner(currentTrick, trump, leadSuit);
  const hasTrumpInTrick = currentTrick.some(p => p.card.suit === trump && trump !== leadSuit);

  if (metBid) {
    // Don't want to win — play lowest card in suit
    return sortLowToHigh(followSuitCards)[0];
  }

  if (wantToWin && !hasTrumpInTrick) {
    // Try to win: find the cheapest card that beats the current winner
    const winningCards = followSuitCards
      .filter(c => RANK_VALUES[c.rank] > RANK_VALUES[currentWinner.card.rank] || currentWinner.card.suit !== leadSuit)
      .sort((a, b) => RANK_VALUES[a.rank] - RANK_VALUES[b.rank]);

    if (winningCards.length > 0) {
      return winningCards[0]; // cheapest winner
    }
  }

  // Can't win or don't want to — play lowest
  return sortLowToHigh(followSuitCards)[0];
}

/**
 * Choose a card when void in the lead suit
 */
function selectVoid(hand, currentTrick, trump, wantToWin, metBid) {
  const trumpCards = hand.filter(c => c.suit === trump);
  const nonTrumpCards = hand.filter(c => c.suit !== trump);
  const hasTrumpInTrick = currentTrick.some(p => p.card.suit === trump);

  if (wantToWin && trumpCards.length > 0) {
    if (hasTrumpInTrick) {
      // Someone already trumped — need to over-trump
      const highestTrumpPlayed = currentTrick
        .filter(p => p.card.suit === trump)
        .sort((a, b) => RANK_VALUES[b.card.rank] - RANK_VALUES[a.card.rank])[0];

      const overTrumps = trumpCards
        .filter(c => RANK_VALUES[c.rank] > RANK_VALUES[highestTrumpPlayed.card.rank])
        .sort((a, b) => RANK_VALUES[a.rank] - RANK_VALUES[b.rank]);

      if (overTrumps.length > 0) {
        return overTrumps[0]; // cheapest over-trump
      }
      // Can't over-trump — discard lowest non-trump
      if (nonTrumpCards.length > 0) return sortLowToHigh(nonTrumpCards)[0];
      return sortLowToHigh(trumpCards)[0];
    }

    // No trump played yet — trump in with lowest trump
    return sortLowToHigh(trumpCards)[0];
  }

  // Don't want to win or no trump — discard lowest non-trump
  if (nonTrumpCards.length > 0) {
    return sortLowToHigh(nonTrumpCards)[0];
  }
  // Only trump left — play lowest
  return sortLowToHigh(trumpCards)[0];
}

/**
 * Determine the current winning play in a trick
 */
function getTrickWinner(trick, trump, leadSuit) {
  let winning = trick[0];
  for (const play of trick) {
    const c = play.card;
    if (c.suit === winning.card.suit && RANK_VALUES[c.rank] > RANK_VALUES[winning.card.rank]) {
      winning = play;
    } else if (c.suit === trump && winning.card.suit !== trump) {
      winning = play;
    }
  }
  return winning;
}
