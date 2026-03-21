import React from "react";

export default function JoinScreen({ playerName, setPlayerName, roomCode, setRoomCode, createRoom, joinRoom }) {
  const canSubmit = roomCode && playerName;

  return (
    <div className="app-root">
      <div className="screen-join">
        <div className="join-ambient">
          <div className="ambient-suit s1">♠</div>
          <div className="ambient-suit s2">♥</div>
          <div className="ambient-suit s3">♦</div>
          <div className="ambient-suit s4">♣</div>
        </div>
        <div className="join-panel">
          <div className="join-brand">
            <div className="brand-icon">♠</div>
            <h1>Bugger Bridge</h1>
            <p>Trick-taking card game</p>
          </div>
          <div className="join-form">
            <div className="field">
              <label>Player Name</label>
              <input
                value={playerName}
                onChange={(e) => setPlayerName(e.target.value)}
                placeholder="Your name"
                maxLength={16}
                onKeyDown={(e) => e.key === "Enter" && canSubmit && createRoom()}
              />
            </div>
            <div className="field">
              <label>Room Code</label>
              <input
                value={roomCode}
                onChange={(e) => setRoomCode(e.target.value.toUpperCase())}
                placeholder="e.g. GAME1"
                maxLength={8}
                onKeyDown={(e) => e.key === "Enter" && canSubmit && createRoom()}
              />
            </div>
            <div className="join-btns">
              <button className="btn-main" onClick={createRoom} disabled={!canSubmit}>Create Room</button>
              <button className="btn-alt" onClick={joinRoom} disabled={!canSubmit}>Join Room</button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
