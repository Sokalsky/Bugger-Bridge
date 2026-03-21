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

  // Start from the statistical baseline: each player wins roundCards/playerCount on average
  const baseline = roundCards / playerCount;
  const nonTrumpHighCards = highCardCount - trumpHighCount;

  // Calculate how much better/worse this hand is vs average
  // With 4 players, an off-suit Ace wins ~65%, King ~40%, Queen ~20%
  // Trump cards are more reliable
  let trickBonus = 0;
  for (const card of hand) {
    const v = RANK_VALUES[card.rank] || 0;
    const isTrump = card.suit === trump && trump !== "No Trump";
    if (v === 13) trickBonus += isTrump ? 0.85 : 0.6;      // Ace
    else if (v === 12) trickBonus += isTrump ? 0.7 : 0.35;  // King
    else if (v === 11) trickBonus += isTrump ? 0.5 : 0.15;  // Queen
    else if (v === 10) trickBonus += isTrump ? 0.35 : 0.05; // Jack
  }

  // Low trump cards can win by trumping voids
  if (trump !== "No Trump") {
    const lowTrump = trumpCount - trumpHighCount;
    trickBonus += Math.min(lowTrump, voidSuits.size) * 0.4;
  }

  // Combine: baseline adjusted by hand quality
  // Subtract expected bonus for an average hand to avoid inflating
  const expectedBonus = baseline * 0.35;
  let estimatedTricks = baseline + (trickBonus - expectedBonus);

  // Small adjustment for overall hand strength
  const avgValue = totalValue / hand.length;
  if (avgValue > 9) estimatedTricks += 0.3;
  else if (avgValue < 4.5) estimatedTricks -= 0.3;

  // Round and clamp
  estimatedTricks = Math.round(estimatedTricks);
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
 * Select a card for the AI to play — with full strategic awareness.
 *
 * @param {Array} hand - The AI's hand
 * @param {Array} currentTrick - Cards already played in this trick
 * @param {string} trump - The trump suit
 * @param {number} bid - The AI's bid for this round
 * @param {number} tricksWon - How many tricks the AI has won so far
 * @param {Object|null} learningData - Learning data (unused currently, reserved)
 * @param {Object|null} gameContext - { allBids, allTricksWon, playedThisRound, playerCount, cardsPerPlayer }
 * @returns {Object} The card to play
 */
export function selectAICard(hand, currentTrick, trump, bid = 0, tricksWon = 0, learningData = null, gameContext = null) {
  if (hand.length === 0) return null;

  const leadSuit = currentTrick.length > 0 ? currentTrick[0].card.suit : null;
  const tricksNeeded = bid - tricksWon;
  const cardsLeft = hand.length;

  // ===== CARD TRACKING: figure out what's still out =====
  const played = gameContext?.playedThisRound || [];
  const cardTracker = buildCardTracker(hand, played, currentTrick, trump);

  // ===== OPPONENT AWARENESS =====
  const opponents = analyzeOpponents(gameContext, tricksWon, bid);

  // ===== OVER-BID STRATEGY =====
  // If we're over our bid, decide whether to keep losing (screw others) or switch to winning (maximize points)
  let wantToWin = tricksNeeded > 0;
  let metBid = tricksNeeded === 0;

  if (tricksNeeded < 0) {
    // We're over-bid. Check: are we the ONLY one with extra tricks?
    const totalBids = Object.values(gameContext?.allBids || {}).reduce((s, b) => s + b, 0);
    const totalTricksWon = Object.values(gameContext?.allTricksWon || {}).reduce((s, t) => s + t, 0);
    const cardsPerPlayer = gameContext?.cardsPerPlayer || 0;
    const extrasStillAvailable = totalTricksWon < cardsPerPlayer; // more tricks to play
    const othersOverBid = opponents.opponents.some(o => o.needed < 0 && o.pid !== undefined);

    if (!othersOverBid && extrasStillAvailable) {
      // We're the ONLY one over-bid and there are tricks left — keep trying to LOSE
      // to push extra tricks onto opponents and screw up their bids
      metBid = true; // pretend we've met our bid (duck everything)
      wantToWin = false;
    } else {
      // Others are also over, or we've already absorbed all extras
      // Switch to WINNING — maximize our points (tricks won) since we've
      // already lost the 10-point bonus. Try to cause others to go over too.
      wantToWin = true;
      metBid = false;
    }
  }

  // ===== TRICK PACING: should we be aggressive or conservative? =====
  const urgency = cardsLeft > 0 ? Math.max(0, tricksNeeded) / cardsLeft : 0;
  const isUrgent = urgency > 0.6;
  const canBeSelective = urgency > 0 && urgency <= 0.4;

  // --- LEADING ---
  if (!leadSuit) {
    return selectLead(hand, trump, wantToWin, metBid, isUrgent, canBeSelective, cardTracker, opponents);
  }

  // --- FOLLOWING SUIT ---
  const followSuitCards = hand.filter(c => c.suit === leadSuit);
  if (followSuitCards.length > 0) {
    return selectFollowSuit(followSuitCards, currentTrick, trump, leadSuit, wantToWin, metBid, isUrgent, cardTracker, opponents);
  }

  // --- VOID IN LEAD SUIT ---
  return selectVoid(hand, currentTrick, trump, wantToWin, metBid, isUrgent, opponents, cardTracker);
}

// ===== CARD TRACKING =====

/**
 * Build a tracker of which cards have been played and what's still out.
 */
function buildCardTracker(hand, playedThisRound, currentTrick, trump) {
  const allPlayed = [...playedThisRound, ...currentTrick.map(p => p.card)];
  const playedSet = new Set(allPlayed.map(c => `${c.suit}|${c.rank}`));
  const handSet = new Set(hand.map(c => `${c.suit}|${c.rank}`));

  // For each suit, figure out which high cards are still out (not in our hand, not played)
  const suits = ["Hearts", "Diamonds", "Clubs", "Spades"];
  const highRanks = ["A", "K", "Q", "J", "10"];
  const stillOut = {};

  for (const suit of suits) {
    stillOut[suit] = [];
    for (const rank of highRanks) {
      const key = `${suit}|${rank}`;
      if (!playedSet.has(key) && !handSet.has(key)) {
        stillOut[suit].push(rank);
      }
    }
  }

  return {
    playedSet,
    stillOut, // { Hearts: ["A", "K"], ... } — high cards still out per suit
    isHighestInSuit: (card) => {
      // Is this card the highest remaining in its suit?
      const higher = stillOut[card.suit] || [];
      return higher.every(r => RANK_VALUES[r] <= RANK_VALUES[card.rank]);
    },
    countOutInSuit: (suit) => {
      // How many cards of this suit are still out (not in hand, not played)?
      let count = 0;
      const allRanks = ["2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K", "A"];
      for (const rank of allRanks) {
        const key = `${suit}|${rank}`;
        if (!playedSet.has(key) && !handSet.has(key)) count++;
      }
      return count;
    },
    dangerScore: (card, trump) => {
      // How likely is this card to win a FUTURE trick? Higher = more dangerous.
      // When we've met our bid, we want to dump the most dangerous cards first.
      // We also WANT to keep very low cards (2-4) — they're safe guaranteed losers.
      const v = RANK_VALUES[card.rank] || 0;
      const isTrump = card.suit === trump && trump !== "No Trump";

      // Base danger: mid-range cards (6-9) are the MOST dangerous to keep
      // because they might accidentally win. Low cards (2-4) are safe keepers.
      // High cards (10+) are obvious dangers.
      let danger;
      if (v <= 3) danger = 1;          // 2, 3, 4 — safe to keep (guaranteed losers)
      else if (v <= 5) danger = 4;     // 5, 6 — somewhat safe
      else if (v <= 8) danger = 9;     // 7, 8, 9 — DANGEROUS mid-range, might accidentally win
      else if (v <= 10) danger = 12;   // 10, J — high, likely winners
      else danger = v + 2;             // Q=13, K=14, A=15 — obvious dangers

      // Trump cards are much more dangerous — they can win any non-trump trick
      if (isTrump) danger += 15;

      // If this card is the highest remaining in its suit, it's VERY dangerous
      const higher = stillOut[card.suit] || [];
      const isHighest = higher.every(r => RANK_VALUES[r] <= RANK_VALUES[card.rank]);
      if (isHighest) danger += 10;

      // If few cards of this suit are left out there, mid+ cards are more
      // likely to win (less competition)
      let outCount = 0;
      const allRanks = ["2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K", "A"];
      for (const rank of allRanks) {
        const key = `${card.suit}|${rank}`;
        if (!playedSet.has(key) && !handSet.has(key)) outCount++;
      }
      if (outCount <= 2 && v >= 6) danger += 5; // few cards left, even mids are dangerous
      if (outCount === 0 && v >= 3) danger += 8; // NO cards left in suit — ANY card wins!

      return danger;
    },
  };
}

// ===== OPPONENT ANALYSIS =====

function analyzeOpponents(gameContext, myTricksWon, myBid) {
  if (!gameContext?.allBids) return { anyoneDesperateForTricks: false, anyoneMetBid: false, opponents: [] };

  const opponents = [];
  let anyoneDesperateForTricks = false;
  let anyoneMetBid = false;

  for (const [pid, oppBid] of Object.entries(gameContext.allBids)) {
    const oppTricks = gameContext.allTricksWon?.[pid] || 0;
    const oppNeeded = oppBid - oppTricks;
    const metBid = oppNeeded === 0;
    const overBid = oppNeeded < 0;

    if (metBid || overBid) anyoneMetBid = true;
    if (oppNeeded > 2) anyoneDesperateForTricks = true;

    opponents.push({ pid, bid: oppBid, tricksWon: oppTricks, needed: oppNeeded, metBid, overBid });
  }

  return { anyoneDesperateForTricks, anyoneMetBid, opponents };
}

// ===== INTERNAL HELPERS =====

function sortHighToLow(cards) {
  return [...cards].sort((a, b) => RANK_VALUES[b.rank] - RANK_VALUES[a.rank]);
}

function sortLowToHigh(cards) {
  return [...cards].sort((a, b) => RANK_VALUES[a.rank] - RANK_VALUES[b.rank]);
}

/**
 * When we've met our bid: pick the card that's most dangerous to hold
 * (most likely to win a future trick) but that won't win THIS trick.
 * If following suit, we can only play cards in that suit — pick the
 * most dangerous one that stays below the current winner.
 */
function safestDiscard(cards, currentTrick, trump, cardTracker) {
  if (cards.length === 1) return cards[0];

  // Sort by danger score (highest danger first — we want to dump those)
  const sorted = [...cards].sort((a, b) =>
    cardTracker.dangerScore(b, trump) - cardTracker.dangerScore(a, trump)
  );

  // If we're following suit in a trick, try to play the most dangerous card
  // that still LOSES (stays below the current winner)
  if (currentTrick && currentTrick.length > 0) {
    const leadSuit = currentTrick[0].card.suit;
    const winner = getTrickWinner(currentTrick, trump, leadSuit);
    const hasTrumpInTrick = currentTrick.some(p => p.card.suit === trump && trump !== leadSuit);

    for (const card of sorted) {
      // Can this card lose the trick?
      if (card.suit === leadSuit && winner.card.suit === leadSuit) {
        // Same suit as lead — we lose if we're below the winner
        if (RANK_VALUES[card.rank] < RANK_VALUES[winner.card.rank]) return card;
      } else if (card.suit !== trump && hasTrumpInTrick) {
        // Someone trumped and we're not playing trump — we'll lose
        return card;
      } else if (card.suit !== trump && card.suit !== leadSuit) {
        // Off-suit non-trump discard — can't win
        return card;
      }
    }
  }

  // Fallback: just return the most dangerous card
  return sorted[0];
}

/**
 * Choose a card when leading a trick — with pacing, tracking, and opponent awareness.
 */
function selectLead(hand, trump, wantToWin, metBid, isUrgent, canBeSelective, cardTracker, opponents) {
  const trumpCards = hand.filter(c => c.suit === trump && trump !== "No Trump");
  const nonTrumpCards = hand.filter(c => c.suit !== trump || trump === "No Trump");

  if (metBid) {
    // === DEFENSIVE: dump the most dangerous card we're holding ===
    // Lead the card most likely to win future tricks — get rid of it now
    // when we're leading (so it might lose to someone else's higher card)
    return safestDiscard(hand, null, trump, cardTracker);
  }

  if (!wantToWin) {
    // Over-bid — dump lowest
    if (nonTrumpCards.length > 0) return sortLowToHigh(nonTrumpCards)[0];
    return sortLowToHigh(hand)[0];
  }

  // === WE NEED TRICKS ===

  if (isUrgent) {
    // Urgent: need to win most remaining tricks — lead our best cards
    // Lead guaranteed winners first (highest remaining in a suit)
    for (const card of sortHighToLow(hand)) {
      if (cardTracker.isHighestInSuit(card)) return card;
    }
    // No guaranteed winners — lead highest trump
    if (trumpCards.length > 0) return sortHighToLow(trumpCards)[0];
    return sortHighToLow(hand)[0];
  }

  if (canBeSelective) {
    // Selective: we have time — lead guaranteed winners, save questionable ones
    // Find cards that are now the highest in their suit (safe wins)
    const guaranteedWinners = hand.filter(c => cardTracker.isHighestInSuit(c));
    if (guaranteedWinners.length > 0) {
      // Lead the guaranteed winner from the suit with fewest cards still out
      // (fewer cards out = less risk of someone being void and trumping)
      guaranteedWinners.sort((a, b) => cardTracker.countOutInSuit(a.suit) - cardTracker.countOutInSuit(b.suit));
      return guaranteedWinners[0];
    }

    // No guaranteed winners — lead from our longest non-trump suit to establish it
    const suitCounts = {};
    for (const c of nonTrumpCards) {
      suitCounts[c.suit] = (suitCounts[c.suit] || 0) + 1;
    }
    const longestSuit = Object.entries(suitCounts).sort(([, a], [, b]) => b - a)[0];
    if (longestSuit && longestSuit[1] >= 3) {
      // Lead high from our long suit to start exhausting opponents
      const suitCards = nonTrumpCards.filter(c => c.suit === longestSuit[0]);
      return sortHighToLow(suitCards)[0];
    }

    // Fallback: lead highest non-trump
    if (nonTrumpCards.length > 0) return sortHighToLow(nonTrumpCards)[0];
    return sortHighToLow(trumpCards.length > 0 ? trumpCards : hand)[0];
  }

  // Normal need: lead strong but not desperate
  // Prefer guaranteed winners, then highest non-trump, then trump
  const guaranteed = hand.filter(c => cardTracker.isHighestInSuit(c));
  if (guaranteed.length > 0) return guaranteed[0];
  if (nonTrumpCards.length > 0) return sortHighToLow(nonTrumpCards)[0];
  return sortHighToLow(trumpCards.length > 0 ? trumpCards : hand)[0];
}

/**
 * Choose a card when following suit — with tracking and pacing.
 */
function selectFollowSuit(followSuitCards, currentTrick, trump, leadSuit, wantToWin, metBid, isUrgent, cardTracker, opponents) {
  const currentWinner = getTrickWinner(currentTrick, trump, leadSuit);
  const hasTrumpInTrick = currentTrick.some(p => p.card.suit === trump && trump !== leadSuit);

  if (metBid) {
    // Don't want to win — dump the most dangerous card that still LOSES this trick
    return safestDiscard(followSuitCards, currentTrick, trump, cardTracker);
  }

  if (wantToWin && !hasTrumpInTrick) {
    // Try to win with cheapest card that beats the current winner
    const winningCards = followSuitCards
      .filter(c => {
        if (currentWinner.card.suit === leadSuit) {
          return RANK_VALUES[c.rank] > RANK_VALUES[currentWinner.card.rank];
        }
        return true; // current winner is off-suit/trump, any follow-suit might not win
      })
      .sort((a, b) => RANK_VALUES[a.rank] - RANK_VALUES[b.rank]);

    if (winningCards.length > 0) {
      if (isUrgent) {
        return winningCards[0]; // take it with cheapest winner
      }
      // If being selective: only play a winner if it's guaranteed (highest remaining)
      const guaranteedWin = winningCards.find(c => cardTracker.isHighestInSuit(c));
      if (guaranteedWin) return guaranteedWin;
      // Not guaranteed but still a potential winner — play cheapest
      return winningCards[0];
    }
  }

  // Can't win or don't want to — play lowest (save higher cards for later)
  return sortLowToHigh(followSuitCards)[0];
}

/**
 * Choose a card when void in the lead suit — with opponent awareness.
 */
function selectVoid(hand, currentTrick, trump, wantToWin, metBid, isUrgent, opponents, cardTracker) {
  const trumpCards = hand.filter(c => c.suit === trump && trump !== "No Trump");
  const nonTrumpCards = hand.filter(c => c.suit !== trump || trump === "No Trump");
  const hasTrumpInTrick = currentTrick.some(p => p.card.suit === trump && trump !== "No Trump");

  if (metBid) {
    // Don't want to win — dump the most dangerous card (can discard anything when void)
    // This is the best opportunity to ditch dangerous trump or high cards
    return safestDiscard(hand, currentTrick, trump, cardTracker);
  }

  if (wantToWin && trumpCards.length > 0) {
    if (hasTrumpInTrick) {
      // Over-trump if possible
      const highestTrumpPlayed = currentTrick
        .filter(p => p.card.suit === trump)
        .sort((a, b) => RANK_VALUES[b.card.rank] - RANK_VALUES[a.card.rank])[0];

      const overTrumps = trumpCards
        .filter(c => RANK_VALUES[c.rank] > RANK_VALUES[highestTrumpPlayed.card.rank])
        .sort((a, b) => RANK_VALUES[a.rank] - RANK_VALUES[b.rank]);

      if (overTrumps.length > 0) {
        if (isUrgent) return overTrumps[0]; // must over-trump
        // If not urgent, only over-trump if we have trump to spare
        if (trumpCards.length > 1) return overTrumps[0];
      }
      // Can't over-trump or saving trump — discard
      if (nonTrumpCards.length > 0) return sortLowToHigh(nonTrumpCards)[0];
      return sortLowToHigh(trumpCards)[0];
    }

    // No trump in trick — trump in
    if (isUrgent) return sortLowToHigh(trumpCards)[0];
    // If not urgent, only trump if we have plenty of trump
    if (trumpCards.length >= 2) return sortLowToHigh(trumpCards)[0];
    // Save our last trump — discard instead
    if (nonTrumpCards.length > 0) return sortLowToHigh(nonTrumpCards)[0];
    return sortLowToHigh(trumpCards)[0];
  }

  // Don't want to win or no trump — discard lowest non-trump
  if (nonTrumpCards.length > 0) return sortLowToHigh(nonTrumpCards)[0];
  return sortLowToHigh(hand)[0];
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
