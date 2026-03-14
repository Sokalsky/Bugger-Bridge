export function dealCards(players, cardsPerPlayer) {
  const suits = ["Hearts", "Diamonds", "Clubs", "Spades"];
  const ranks = ["2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K", "A"];
  const deck = [];

  for (const suit of suits) {
    for (const rank of ranks) {
      deck.push({ suit, rank });
    }
  }

  // Shuffle deck
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }

  const hands = {};
  for (const player of players) {
    hands[player.id] = deck.splice(0, cardsPerPlayer);
  }

  // Return both hands and remaining cards (buried cards)
  return { hands, buriedCards: deck };
}

// ✅ Updated to include "No Trump" in the cycle
export function getTrump(index) {
  const suits = ["Spades", "Hearts", "Diamonds", "Clubs", "No Trump"];
  return suits[index % suits.length];
}
