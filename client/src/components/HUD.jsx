import React from "react";

export default function HUD({ me, myId, scores, myBidVal, myTricksVal, isMyTurn, bidding, myBid, setMyBid, submitBid, roundData }) {
  return (
    <div className={`hud ${isMyTurn ? "hud-myturn" : ""}`}>
      <div className="hud-who">
        <div className="hud-av">{me?.name?.charAt(0).toUpperCase() || "?"}</div>
        <span className="hud-name">{me?.name || "You"}</span>
      </div>
      <div className="hud-nums">
        <div className="hud-n">
          <span className="hn-label">Score</span>
          <span className="hn-val">{scores[myId] || 0}</span>
        </div>
        <div className="hud-sep" />
        <div className="hud-n">
          <span className="hn-label">Bid</span>
          <span className="hn-val">{myBidVal !== undefined ? myBidVal : "—"}</span>
        </div>
        <div className="hud-sep" />
        <div className="hud-n">
          <span className="hn-label">Tricks</span>
          <span className={`hn-val ${myBidVal !== undefined && myTricksVal === myBidVal ? "val-hit" : ""}`}>{myTricksVal}</span>
        </div>
      </div>
      {bidding && isMyTurn && (
        <div className="bid-ctrl">
          <button className="bid-btn" onClick={() => setMyBid(String(Math.max(0, (parseInt(myBid) || 0) - 1)))}>−</button>
          <span className="bid-num">{myBid || "0"}</span>
          <button className="bid-btn" onClick={() => setMyBid(String(Math.min(roundData?.cardsThisRound || 13, (parseInt(myBid) || 0) + 1)))}>+</button>
          <button className="btn-main bid-submit" onClick={submitBid}>Bid</button>
        </div>
      )}
    </div>
  );
}
