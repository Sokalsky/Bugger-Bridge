import React from "react";

const SUIT_SYMBOLS = { Hearts: "♥", Diamonds: "♦", Clubs: "♣", Spades: "♠" };
const SUIT_COLORS = { Hearts: "#dc3545", Diamonds: "#dc3545", Clubs: "#f0c040", Spades: "#f0c040" };

export default function SuitIcon({ suit }) {
  if (!suit || suit === "No Trump") return <span className="suit-icon nt">NT</span>;
  return <span className="suit-icon" style={{ color: SUIT_COLORS[suit] }}>{SUIT_SYMBOLS[suit]}</span>;
}

export { SUIT_SYMBOLS, SUIT_COLORS };
