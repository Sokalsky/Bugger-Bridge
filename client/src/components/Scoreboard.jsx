import React from "react";
import SuitIcon from "./SuitIcon";

export default function Scoreboard({ room, myId, gameHistory, roundSummaryData, isHost, onNextRound, onNewGame }) {
  if (!roundSummaryData) return null;

  const allRounds = [...gameHistory, roundSummaryData].filter((r, idx, arr) => {
    if (r === roundSummaryData && arr.indexOf(r) !== idx) return false;
    return r && r.cardsThisRound !== undefined && r.cardsThisRound >= 0;
  });

  return (
    <div className="overlay">
      <div className="scoreboard">
        <div className="sb-head">
          <h2>{roundSummaryData.isFinal ? "🏆 Game Over!" : "Round Complete"}</h2>
          {!roundSummaryData.isFinal && (
            <p className="sb-sub">
              {roundSummaryData.cardsThisRound} cards · Trump: <SuitIcon suit={roundSummaryData.trump} /> {roundSummaryData.trump}
            </p>
          )}
        </div>
        <div className="sb-scroll">
          <table className="sb-tbl">
            <thead>
              <tr>
                <th className="th-sm">Cards</th>
                <th className="th-sm">Trump</th>
                {(() => {
                  const scores = roundSummaryData.scores || {};
                  const maxScore = Math.max(...Object.values(scores), 0);
                  const leaders = Object.keys(scores).filter(id => scores[id] === maxScore);
                  return room?.players.map((pl) => {
                    const isLeader = leaders.includes(pl.id) && maxScore > 0;
                    const score = scores[pl.id] || 0;
                    return (
                      <th key={pl.id} colSpan={3} className="th-player" style={{ color: isLeader ? "#f0c040" : "#ffffff" }}>
                        {pl.name}{pl.id === myId ? " (you)" : ""} ({score})
                      </th>
                    );
                  });
                })()}
              </tr>
              <tr className="sub-hdr">
                <th /><th />
                {room?.players.map((pl) => (
                  <React.Fragment key={pl.id + "-sh"}>
                    <th className="th-sub">Bid</th>
                    <th className="th-sub">Won</th>
                    <th className="th-sub">Pts</th>
                  </React.Fragment>
                ))}
              </tr>
            </thead>
            <tbody>
              {allRounds.map((round, idx) => (
                <tr key={idx}>
                  <td className="td-sm">{round.cardsThisRound}</td>
                  <td className="td-sm"><SuitIcon suit={round.trump} /></td>
                  {room?.players.map((pl) => {
                    const b = round.bids[pl.id] || 0;
                    const t = round.tricksWon[pl.id] || 0;
                    const met = b === t;
                    const pts = met ? 10 + t : t;
                    return (
                      <React.Fragment key={pl.id + "-d"}>
                        <td className="td-data">{b}</td>
                        <td className={`td-data ${met ? "td-hit" : "td-miss"}`}>{t}</td>
                        <td className={`td-data td-pts ${met ? "td-hit" : "td-miss"}`}>{pts}</td>
                      </React.Fragment>
                    );
                  })}
                </tr>
              ))}
              <tr className="row-totals">
                <td colSpan={2} className="totals-label">Total</td>
                {room?.players.map((pl) => {
                  const tb = allRounds.reduce((s, r) => s + (r.bids?.[pl.id] || 0), 0);
                  const tt = allRounds.reduce((s, r) => s + (r.tricksWon?.[pl.id] || 0), 0);
                  const ts = roundSummaryData.scores?.[pl.id] || 0;
                  return (
                    <React.Fragment key={pl.id + "-t"}>
                      <td className="td-total">{tb}</td>
                      <td className="td-total">{tt}</td>
                      <td className="td-total td-total-score">{ts}</td>
                    </React.Fragment>
                  );
                })}
              </tr>
            </tbody>
          </table>
        </div>
        {roundSummaryData.buriedCards?.length > 0 && (
          <div className="sb-buried">
            <span className="buried-label">Buried:</span>
            {roundSummaryData.buriedCards.map((c, i) => (
              <span key={i} className="buried-chip">{c.rank}<SuitIcon suit={c.suit} /></span>
            ))}
          </div>
        )}
        <div className="sb-footer">
          {roundSummaryData.isFinal ? (
            <button className="btn-main btn-lg" onClick={onNewGame}>New Game</button>
          ) : isHost ? (
            <button className="btn-main btn-lg" onClick={onNextRound}>Next Round →</button>
          ) : (
            <p className="sb-wait">Waiting for host…</p>
          )}
        </div>
      </div>
    </div>
  );
}
