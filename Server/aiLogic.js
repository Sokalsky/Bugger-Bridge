// AI Logic for Bugger Bridge
// Handles AI bidding and card play decisions

/**
 * Calculate a reasonable bid for an AI player
 * @param {Array} hand - The AI's hand
 * @param {number} roundCards - Number of cards in this round
 * @param {string} trump - The trump suit for this round
 * @param {Object} existingBids - Bids already made by other players
 * @param {number} playerCount - Total number of players
 * @returns {number} The bid amount
 */
export function calculateAIBid(hand, roundCards, trump, existingBids, playerCount) {
  // Count high cards and trump cards
  const rankValues = { A: 13, K: 12, Q: 11, J: 10, "10": 9, "9": 8, "8": 7, "7": 6, "6": 5, "5": 4, "4": 3, "3": 2, "2": 1 };
  
  let highCardCount = 0;
  let trumpCount = 0;
  let totalValue = 0;
  
  for (const card of hand) {
    const value = rankValues[card.rank] || 0;
    totalValue += value;
    
    if (value >= 10) { // A, K, Q, J, 10
      highCardCount++;
    }
    
    if (card.suit === trump) {
      trumpCount++;
      if (value >= 10) {
        highCardCount++; // Trump high cards count double
      }
    }
  }
  
  // Estimate tricks based on high cards and trump
  // Each high card is roughly worth 0.5-0.7 tricks
  // Trump cards add value
  let estimatedTricks = Math.floor(highCardCount * 0.6) + Math.floor(trumpCount * 0.3);
  
  // Adjust based on hand strength
  const avgValue = totalValue / hand.length;
  if (avgValue > 8) {
    estimatedTricks += 1;
  } else if (avgValue < 5) {
    estimatedTricks = Math.max(0, estimatedTricks - 1);
  }
  
  // Ensure bid is within valid range
  estimatedTricks = Math.max(0, Math.min(roundCards, estimatedTricks));
  
  // Check if this bid would make total equal roundCards (invalid for ANY bidder)
  const bidsSoFar = Object.values(existingBids).reduce((sum, bid) => sum + bid, 0);
  const remainingBids = playerCount - Object.keys(existingBids).length - 1;
  
  // Add some randomness for variety (±1) but check validity
  let randomAdjust = Math.floor(Math.random() * 3) - 1; // -1, 0, or 1
  let finalBid = Math.max(0, Math.min(roundCards, estimatedTricks + randomAdjust));
  
  // Check if this bid would make total equal roundCards - this is ALWAYS invalid
  let totalIfBid = bidsSoFar + finalBid;
  while (totalIfBid === roundCards && finalBid >= 0) {
    // Adjust bid to avoid invalid total
    if (finalBid > 0) {
      finalBid--;
    } else {
      // If we're at 0 and it still equals, try 1 (if that doesn't equal)
      if (bidsSoFar + 1 !== roundCards && bidsSoFar + 1 < roundCards) {
        finalBid = 1;
      } else {
        // Find a valid bid
        for (let testBid = 2; testBid <= roundCards; testBid++) {
          if (bidsSoFar + testBid !== roundCards && bidsSoFar + testBid <= roundCards) {
            finalBid = testBid;
            break;
          }
        }
        if (bidsSoFar + finalBid === roundCards) {
          // Still invalid, try going down
          for (let testBid = roundCards - 1; testBid >= 0; testBid--) {
            if (bidsSoFar + testBid !== roundCards) {
              finalBid = testBid;
              break;
            }
          }
        }
      }
    }
    totalIfBid = bidsSoFar + finalBid;
    // Safety break to prevent infinite loop
    if (totalIfBid !== roundCards) break;
  }
  
  // Final validation
  if (bidsSoFar + finalBid === roundCards) {
    // Last resort: find any valid bid
    for (let testBid = 0; testBid <= roundCards; testBid++) {
      if (bidsSoFar + testBid !== roundCards) {
        finalBid = testBid;
        break;
      }
    }
  }
  
  return Math.max(0, Math.min(roundCards, finalBid));
}

/**
 * Select a card for the AI to play
 * @param {Array} hand - The AI's hand
 * @param {Array} currentTrick - Cards already played in this trick
 * @param {string} trump - The trump suit
 * @returns {Object} The card to play
 */
export function selectAICard(hand, currentTrick, trump) {
  if (hand.length === 0) return null;
  
  const leadSuit = currentTrick.length > 0 ? currentTrick[0].card.suit : null;
  const rankValues = { A: 13, K: 12, Q: 11, J: 10, "10": 9, "9": 8, "8": 7, "7": 6, "6": 5, "5": 4, "4": 3, "3": 2, "2": 1 };
  
  // If leading, play a strong card
  if (!leadSuit) {
    // Only lead trump 20% of the time, otherwise lead highest non-trump
    const trumpCards = hand.filter(c => c.suit === trump);
    const nonTrumpCards = hand.filter(c => c.suit !== trump);
    
    if (trumpCards.length > 0 && Math.random() < 0.2 && nonTrumpCards.length > 0) {
      // 20% chance to lead trump if we have non-trump options
      return trumpCards.sort((a, b) => rankValues[b.rank] - rankValues[a.rank])[0];
    }
    // Otherwise play highest non-trump (or trump if that's all we have)
    if (nonTrumpCards.length > 0) {
      return nonTrumpCards.sort((a, b) => rankValues[b.rank] - rankValues[a.rank])[0];
    }
    // Only trump left
    return trumpCards.sort((a, b) => rankValues[b.rank] - rankValues[a.rank])[0];
  }
  
  // Must follow suit if possible
  const followSuitCards = hand.filter(c => c.suit === leadSuit);
  
  if (followSuitCards.length > 0) {
    // Check if we can win the trick
    const highestPlayed = currentTrick.reduce((highest, play) => {
      if (play.card.suit === trump) return play;
      if (play.card.suit === leadSuit && (!highest || rankValues[play.card.rank] > rankValues[highest.card.rank])) {
        return play;
      }
      return highest;
    }, null);
    
    const hasTrump = currentTrick.some(p => p.card.suit === trump);
    
    if (!hasTrump && highestPlayed && highestPlayed.card.suit === leadSuit) {
      // Try to win if no trump has been played
      const winningCard = followSuitCards.find(c => rankValues[c.rank] > rankValues[highestPlayed.card.rank]);
      if (winningCard) {
        return winningCard;
      }
    }
    
    // Otherwise play lowest card of suit (duck)
    return followSuitCards.sort((a, b) => rankValues[a.rank] - rankValues[b.rank])[0];
  }
  
  // Can't follow suit - play lowest card (prefer non-trump)
  const nonTrumpCards = hand.filter(c => c.suit !== trump);
  if (nonTrumpCards.length > 0) {
    return nonTrumpCards.sort((a, b) => rankValues[a.rank] - rankValues[b.rank])[0];
  }
  
  // Only trump left - play lowest trump
  const trumpCards = hand.filter(c => c.suit === trump);
  return trumpCards.sort((a, b) => rankValues[a.rank] - rankValues[b.rank])[0];
}

