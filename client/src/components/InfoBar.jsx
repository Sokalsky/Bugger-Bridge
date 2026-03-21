import React from "react";
import SuitIcon from "./SuitIcon";

export default function InfoBar({ roundData, bidding, phase, totalBids }) {
  const cardsThisRound = roundData?.cardsThisRound || 0;
  const bidRatio = totalBids === cardsThisRound ? "even" : totalBids > cardsThisRound ? "over" : "under";

  return (
    <div className="info-bar">
      <div className="ib-chip">
        <span className="ib-label">Round</span>
        <span className="ib-val">{roundData?.displayRound || "—"}</span>
      </div>
      <div className="ib-chip ib-trump">
        <span className="ib-label">Trump</span>
        <span className="ib-val"><SuitIcon suit={roundData?.trump} /> {roundData?.trump || "—"}</span>
      </div>
      <div className="ib-chip">
        <span className="ib-label">Cards</span>
        <span className="ib-val">{cardsThisRound || "—"}</span>
      </div>
      {(bidding || phase === "play") && (
        <div className={`ib-chip ib-bids ${bidRatio}`}>
          <span className="ib-label">Bids</span>
          <span className="ib-val">{totalBids} / {cardsThisRound}</span>
        </div>
      )}
    </div>
  );
}
