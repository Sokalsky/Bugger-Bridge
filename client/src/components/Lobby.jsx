import React from "react";

export default function Lobby({ room, roomCode, myId, readyPlayers, isReady, isHost, toggleReady, addAI, startRound }) {
  return (
    <div className="app-root">
      <div className="screen-lobby">
        <div className="lobby-panel">
          <div className="lobby-top">
            <div className="room-code-badge">{roomCode}</div>
            <h2>Game Lobby</h2>
            <p className="lobby-count">{room?.players.length || 0} of 4 seats filled</p>
          </div>
          <div className="lobby-seats">
            {room?.players.map((player, idx) => {
              const rdy = readyPlayers.has(player.id);
              return (
                <div key={player.id} className={`seat ${rdy ? "seat-ready" : ""}`} style={{ animationDelay: `${idx * 0.08}s` }}>
                  <div className="seat-avatar">{player.isAI ? "🤖" : player.name.charAt(0).toUpperCase()}</div>
                  <div className="seat-info">
                    <span className="seat-name">
                      {player.name}
                      {player.id === myId && <span className="tag tag-you">you</span>}
                      {idx === 0 && <span className="tag tag-host">host</span>}
                    </span>
                  </div>
                  <div className={`seat-status ${rdy ? "is-ready" : ""}`}>{rdy ? "✓ Ready" : "Waiting"}</div>
                </div>
              );
            })}
            {Array.from({ length: 4 - (room?.players.length || 0) }).map((_, i) => (
              <div key={`empty-${i}`} className="seat seat-empty">
                <div className="seat-avatar empty-avatar">?</div>
                <div className="seat-info"><span className="seat-name empty-name">Open Seat</span></div>
                <div className="seat-status">—</div>
              </div>
            ))}
          </div>
          <div className="lobby-actions">
            {room?.players.length < 4 && <button className="btn-ghost" onClick={addAI}>+ Add AI</button>}
            <button className={`btn-ready ${isReady ? "active" : ""}`} onClick={toggleReady}>
              {isReady ? "✓ Ready" : "Ready Up"}
            </button>
            {isHost && (
              <button
                className="btn-main btn-go"
                onClick={startRound}
                disabled={room?.players.length < 3 || readyPlayers.size < room?.players.length}
              >
                Start Game
              </button>
            )}
          </div>
          {isHost && readyPlayers.size < (room?.players.length || 0) && (
            <p className="lobby-waiting-msg">Waiting for {(room?.players.length || 0) - readyPlayers.size} player(s)…</p>
          )}
        </div>
      </div>
    </div>
  );
}
