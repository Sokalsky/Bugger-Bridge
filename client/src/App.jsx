import React, { useState, useEffect, useRef } from "react";
import io from "socket.io-client";
import "./App.css";

const SERVER_URL = import.meta.env.VITE_SERVER_URL || "http://localhost:4000";
const socket = io(SERVER_URL);

let savedId = sessionStorage.getItem("buggerBridgePlayerId");
if (!savedId) {
  savedId = crypto.randomUUID();
  sessionStorage.setItem("buggerBridgePlayerId", savedId);
}

const SUIT_SYMBOLS = { Hearts: "♥", Diamonds: "♦", Clubs: "♣", Spades: "♠" };
const SUIT_COLORS = { Hearts: "#dc3545", Diamonds: "#dc3545", Clubs: "#1a1a2e", Spades: "#1a1a2e" };

export default function App() {
  const [roomCode, setRoomCode] = useState("");
  const [playerName, setPlayerName] = useState("");
  const [joined, setJoined] = useState(false);
  const [room, setRoom] = useState(null);
  const [roundData, setRoundData] = useState(null);
  const [bidding, setBidding] = useState(false);
  const [bids, setBids] = useState({});
  const [myBid, setMyBid] = useState("0");
  const [myId, setMyId] = useState(savedId);
  const [currentBidder, setCurrentBidder] = useState(null);
  const [phase, setPhase] = useState("bidding");
  const [currentPlayer, setCurrentPlayer] = useState(null);
  const [playedCards, setPlayedCards] = useState([]);
  const [lastWinner, setLastWinner] = useState(null);
  const [tricksWon, setTricksWon] = useState({});
  const [scores, setScores] = useState({});
  const [myHand, setMyHand] = useState([]);
  const [canPlay, setCanPlay] = useState(false);
  const [lastPlayedCard, setLastPlayedCard] = useState(null);
  const [gameStarted, setGameStarted] = useState(false);
  const [showRoundSummary, setShowRoundSummary] = useState(false);
  const [roundSummaryData, setRoundSummaryData] = useState(null);
  const [readyPlayers, setReadyPlayers] = useState(new Set());
  const [isReady, setIsReady] = useState(false);
  const [isHost, setIsHost] = useState(false);
  const [opponentHandSizes, setOpponentHandSizes] = useState({});
  const [gameHistory, setGameHistory] = useState([]);
  const [trickWinnerName, setTrickWinnerName] = useState(null);
  const autoHideTimerRef = useRef(null);

  // ===============================
  // SOCKET EVENTS
  // ===============================
  useEffect(() => {
    socket.on("connect", () => {
      setMyId(savedId);
      setIsReady(false);
    });
    socket.on("roomUpdate", (data) => {
      setRoom(data);
      if (data?.players?.length > 0) {
        setIsHost(data.players[0].id === savedId);
      }
      if (data?.readyPlayers) {
        const readySet = new Set(data.readyPlayers);
        setReadyPlayers(readySet);
        setIsReady(readySet.has(savedId));
      }
    });

    socket.on("playerReady", ({ playerId, ready }) => {
      setReadyPlayers((prev) => {
        const newSet = new Set(prev);
        if (ready) newSet.add(playerId); else newSet.delete(playerId);
        if (playerId === savedId) setIsReady(ready);
        return newSet;
      });
    });

    socket.on("allPlayersReady", () => {
      if (isHost && room?.players.length >= 3) startRound();
    });

    socket.on("roundStarted", (data) => {
      setRoundData(data);
      setMyHand(data.hands[savedId] || []);
      setCurrentBidder(data.currentBidder);
      setPhase("bidding");
      setTricksWon({});
      setBids({});
      setGameStarted(true);
      setPlayedCards([]);
      setLastWinner(null);
      setTrickWinnerName(null);
      if (showRoundSummary) {
        setTimeout(() => { setShowRoundSummary(false); setRoundSummaryData(null); }, 500);
      }
      setIsReady(false);
      setReadyPlayers(new Set());
      if (data.displayRound === "1/") setGameHistory([]);
      const initialSizes = {};
      Object.keys(data.hands || {}).forEach((pid) => {
        if (pid !== savedId) initialSizes[pid] = data.hands[pid]?.length || 0;
      });
      setOpponentHandSizes(initialSizes);
    });

    socket.on("startBidding", (data) => {
      setBidding(true);
      setCurrentBidder(data.currentBidder);
      setPhase("bidding");
      setPlayedCards([]);
      setLastWinner(null);
      setTrickWinnerName(null);
    });

    socket.on("biddingUpdate", (data) => setBids(data));
    socket.on("biddingTurn", ({ currentBidder }) => setCurrentBidder(currentBidder));

    socket.on("biddingComplete", (data) => {
      setBidding(false);
      setBids(data.bids);
      setPhase("transition");
    });

    socket.on("startPlay", ({ currentPlayer }) => {
      setPhase("play");
      setCurrentPlayer(currentPlayer);
      setCanPlay(currentPlayer === savedId || currentPlayer === myId);
    });

    socket.on("turnUpdate", ({ currentPlayer }) => {
      setCurrentPlayer(currentPlayer);
      setCanPlay(currentPlayer === savedId || currentPlayer === myId);
    });

    socket.on("cardPlayed", ({ trick }) => {
      setPlayedCards(trick);
      if (room?.players) {
        setOpponentHandSizes((prev) => {
          const updated = { ...prev };
          trick.forEach((played) => {
            if (played.playerId !== savedId && played.playerId !== myId) {
              updated[played.playerId] = Math.max(0, (updated[played.playerId] || 0) - 1);
            }
          });
          return updated;
        });
      }
      if (lastPlayedCard && trick.some((p) =>
        p.card.rank === lastPlayedCard.rank && p.card.suit === lastPlayedCard.suit &&
        (p.playerId === savedId || p.playerId === myId)
      )) {
        setLastPlayedCard(null);
      }
    });

    socket.on("trickComplete", ({ winner, tricksWon, nextPlayer }) => {
      setTricksWon(tricksWon);
      setLastWinner(winner);
      setPhase("play");
      const wp = room?.players?.find((p) => p.id === winner);
      if (wp) setTrickWinnerName(wp.name);
      if (nextPlayer !== undefined) {
        setCurrentPlayer(nextPlayer);
        setCanPlay(nextPlayer === savedId || nextPlayer === myId);
      }
      setTimeout(() => { setPlayedCards([]); setLastWinner(null); setTrickWinnerName(null); }, 1200);
    });

    socket.on("handUpdate", (data) => {
      if (data[savedId]) {
        let updatedHand = data[savedId];
        if (lastPlayedCard) {
          const cardInHand = updatedHand.some((c) => c.rank === lastPlayedCard.rank && c.suit === lastPlayedCard.suit);
          const cardInTrick = playedCards.some((p) =>
            p.card.rank === lastPlayedCard.rank && p.card.suit === lastPlayedCard.suit &&
            (p.playerId === savedId || p.playerId === myId)
          );
          if (!cardInHand && !cardInTrick) updatedHand = [...updatedHand, lastPlayedCard];
          else if (cardInTrick) setLastPlayedCard(null);
        }
        playedCards.forEach((played) => {
          if (played.playerId === savedId || played.playerId === myId) {
            if (!updatedHand.some((c) => c.rank === played.card.rank && c.suit === played.card.suit)) {
              updatedHand = [...updatedHand, played.card];
            }
          }
        });
        setMyHand(updatedHand);
      }
      const sizes = {};
      Object.keys(data).forEach((pid) => {
        if (pid !== savedId && pid !== myId) sizes[pid] = data[pid]?.length || 0;
      });
      setOpponentHandSizes((prev) => ({ ...prev, ...sizes }));
    });

    socket.on("roundOver", (data) => {
      setTricksWon(data.tricksWon);
      setScores(data.scores);
      setRoundData((prev) => ({ ...prev, scores: data.scores }));
      const roundInfo = {
        tricksWon: data.tricksWon, bids: data.bids, scores: data.scores,
        roundNumber: data.roundNumber || roundData?.displayRound || "?",
        cardsThisRound: data.cardsThisRound || roundData?.cardsThisRound || 0,
        trump: data.trump || roundData?.trump || "Unknown",
        buriedCards: data.buriedCards || [],
      };
      setRoundSummaryData(roundInfo);
      if (autoHideTimerRef.current) { clearTimeout(autoHideTimerRef.current); autoHideTimerRef.current = null; }
      setTimeout(() => setShowRoundSummary(true), 1500);
    });

    socket.on("invalidBid", (msg) => alert(msg));
    socket.on("invalidPlay", (msg) => { alert(msg); setCanPlay(true); });

    socket.on("gameOver", (data) => {
      setScores(data.scores);
      setPhase("gameOver");
      const finalRoundInfo = {
        tricksWon: data.tricksWon || {}, bids: data.bids || {}, scores: data.scores,
        roundNumber: "Final", cardsThisRound: roundData?.cardsThisRound || 0,
        trump: roundData?.trump || "Game Over", buriedCards: [], isFinal: true,
      };
      setRoundSummaryData(finalRoundInfo);
      setTimeout(() => setShowRoundSummary(true), 2000);
    });

    socket.on("rejoinGame", (data) => {
      setGameStarted(true); setRoundData(data); setMyHand(data.myHand || []);
      setBids(data.bids || {}); setTricksWon(data.tricksWon || {}); setScores(data.scores || {});
      setPhase(data.phase || "bidding"); setCurrentBidder(data.currentBidder || null);
      setCurrentPlayer(data.currentPlayer || null); setPlayedCards(data.currentTrick || []);
    });

    return () => socket.removeAllListeners();
  }, [room]);

  // ===============================
  // ACTIONS
  // ===============================
  const createRoom = () => { if (!roomCode || !playerName) return; socket.emit("createRoom", { roomCode, playerName, clientId: savedId }); setJoined(true); };
  const joinRoom = () => { if (!roomCode || !playerName) return; socket.emit("joinRoom", { roomCode, playerName, clientId: savedId }); setJoined(true); };
  const startRound = () => {
    if (readyPlayers.size < room?.players.length) { alert("All players must be ready!"); return; }
    socket.emit("startRound", { roomCode });
  };
  const addAI = () => socket.emit("addAI", { roomCode });
  const toggleReady = () => { const r = !isReady; setIsReady(r); socket.emit("toggleReady", { roomCode, playerId: myId, ready: r }); };
  const submitBid = () => {
    if (myBid === "" && myBid !== "0") return;
    socket.emit("makeBid", { roomCode, playerId: myId, bid: Number(myBid) });
    setMyBid("0");
  };
  const playCard = (card) => { if (!canPlay) return; setLastPlayedCard(card); socket.emit("playCard", { roomCode, playerId: myId, card }); setCanPlay(false); };

  // ===============================
  // HELPERS
  // ===============================
  const getCardImage = (card) => {
    if (!card?.rank || !card?.suit) return `${import.meta.env.BASE_URL}cards/Back.svg`;
    const suit = card.suit.toLowerCase();
    const rankMap = { A: "ace", K: "king", Q: "queen", J: "jack" };
    const rank = rankMap[card.rank] || card.rank.toLowerCase();
    return `${import.meta.env.BASE_URL}cards/${rank}_of_${suit}.svg`;
  };

  const getPlayerPosition = (playerId) => {
    if (!room?.players || !myId) return "bottom";
    const players = room.players;
    const myIndex = players.findIndex((p) => p.id === myId);
    const idx = players.findIndex((p) => p.id === playerId);
    if (idx === -1) return "bottom";
    const relative = (idx - myIndex + players.length) % players.length;
    if (players.length === 3) return ["bottom", "left", "right"][relative] || "bottom";
    if (players.length === 4) return ["bottom", "left", "top", "right"][relative] || "bottom";
    return "bottom";
  };

  const SuitIcon = ({ suit }) => {
    if (!suit || suit === "No Trump") return <span className="suit-icon nt">NT</span>;
    return <span className="suit-icon" style={{ color: SUIT_COLORS[suit] }}>{SUIT_SYMBOLS[suit]}</span>;
  };

  const isMyTurn = myId === currentBidder || myId === currentPlayer;
  const me = room?.players.find((p) => p.id === myId);
  const opponents = room?.players?.filter((p) => p.id !== myId) || [];

  // ===== JOIN SCREEN =====
  if (!joined) {
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
                <input value={playerName} onChange={(e) => setPlayerName(e.target.value)}
                  placeholder="Your name" maxLength={16}
                  onKeyDown={(e) => e.key === "Enter" && roomCode && playerName && createRoom()} />
              </div>
              <div className="field">
                <label>Room Code</label>
                <input value={roomCode} onChange={(e) => setRoomCode(e.target.value.toUpperCase())}
                  placeholder="e.g. GAME1" maxLength={8}
                  onKeyDown={(e) => e.key === "Enter" && roomCode && playerName && createRoom()} />
              </div>
              <div className="join-btns">
                <button className="btn-main" onClick={createRoom} disabled={!roomCode || !playerName}>Create Room</button>
                <button className="btn-alt" onClick={joinRoom} disabled={!roomCode || !playerName}>Join Room</button>
              </div>
            </div>
          </div>
        </div>
      </div>
    );
  }

  // ===== LOBBY =====
  if (!gameStarted) {
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
                        {player.id === savedId && <span className="tag tag-you">you</span>}
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
                <button className="btn-main btn-go" onClick={startRound}
                  disabled={room?.players.length < 3 || readyPlayers.size < room?.players.length}>
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

  // ===== GAME TABLE =====
  const totalBidsVal = Object.values(bids).reduce((s, b) => s + (b || 0), 0);
  const myBidVal = bids[myId];
  const myTricksVal = tricksWon[myId] || 0;

  return (
    <div className="app-root">
      <div className="game-table">
        {/* Info Bar */}
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
            <span className="ib-val">{roundData?.cardsThisRound || "—"}</span>
          </div>
          {(bidding || phase === "play") && (
            <div className={`ib-chip ib-bids ${totalBidsVal === (roundData?.cardsThisRound || 0) ? "even" : totalBidsVal > (roundData?.cardsThisRound || 0) ? "over" : "under"}`}>
              <span className="ib-label">Bids</span>
              <span className="ib-val">{totalBidsVal} / {roundData?.cardsThisRound || 0}</span>
            </div>
          )}
        </div>

        {/* Felt */}
        <div className="felt">
          {/* Opponents */}
          {opponents.map((opp) => {
            const pos = getPlayerPosition(opp.id);
            const handSize = opponentHandSizes[opp.id] ?? roundData?.cardsThisRound ?? 0;
            const bid = bids[opp.id];
            const won = tricksWon[opp.id] || 0;
            const isActive = currentPlayer === opp.id || (phase === "bidding" && currentBidder === opp.id);

            return (
              <div key={opp.id} className={`opp-zone opp-${pos}`}>
                <div className={`opp-plate ${isActive ? "opp-active" : ""}`}>
                  <div className="opp-av">{opp.isAI ? "🤖" : opp.name.charAt(0).toUpperCase()}</div>
                  <div className="opp-details">
                    <div className="opp-name">{opp.name}</div>
                    <div className="opp-stats-row">
                      {bid !== undefined ? (
                        <span className={`opp-bid-stat ${won === bid ? "hit" : ""}`}>{won}/{bid}</span>
                      ) : (
                        <span className="opp-bid-stat dim">—</span>
                      )}
                      <span className="opp-score-stat">{scores[opp.id] || 0} pts</span>
                    </div>
                  </div>
                  {isActive && <span className="opp-turn-dot" />}
                </div>
                <div className={`opp-cards opp-cards-${pos}`}>
                  {Array.from({ length: handSize }).map((_, i) => (
                    <div key={i} className={`mini-back mb-${pos}`}
                      style={{ "--i": i, "--n": handSize }} />
                  ))}
                </div>
              </div>
            );
          })}

          {/* Center */}
          <div className="center">
            {playedCards.length > 0 ? (
              <div className="trick-pile">
                {trickWinnerName && <div className="trick-winner-toast">{trickWinnerName} wins!</div>}
                {playedCards.map((p, i) => {
                  const pos = getPlayerPosition(p.playerId);
                  const isW = lastWinner === p.playerId;
                  return (
                    <div key={`${p.playerId}-${p.card.rank}-${p.card.suit}`}
                      className={`trick-slot trick-from-${pos} ${isW ? "trick-winner" : ""}`}
                      style={{ animationDelay: `${i * 0.07}s` }}>
                      <img src={getCardImage(p.card)} alt={`${p.card.rank} ${p.card.suit}`} draggable={false} />
                    </div>
                  );
                })}
              </div>
            ) : (
              <div className="center-status">
                {phase === "bidding" ? (
                  isMyTurn ? <span className="turn-you">Place your bid</span>
                    : <span className="turn-other">{room?.players.find((p) => p.id === currentBidder)?.name} is bidding…</span>
                ) : phase === "play" ? (
                  isMyTurn ? <span className="turn-you">Play a card</span>
                    : <span className="turn-other">{room?.players.find((p) => p.id === currentPlayer)?.name}'s turn</span>
                ) : null}
              </div>
            )}
          </div>

          {/* My Hand */}
          <div className="my-hand-wrap">
            <div className="my-hand" style={{ "--n": myHand.length }}>
              {myHand.map((card, i) => {
                const inTrick = playedCards.some((p) =>
                  p.card.rank === card.rank && p.card.suit === card.suit && p.playerId === myId
                );
                if (inTrick) return null;
                const playable = phase === "play" && canPlay;
                return (
                  <div key={`${card.rank}-${card.suit}-${i}`}
                    className={`hcard ${playable ? "hcard-live" : "hcard-dim"}`}
                    style={{ "--i": i }}
                    onClick={() => playable && playCard(card)}>
                    <img src={getCardImage(card)} alt={`${card.rank} of ${card.suit}`} draggable={false} />
                  </div>
                );
              })}
            </div>
          </div>
        </div>

        {/* Bottom HUD */}
        <div className={`hud ${isMyTurn ? "hud-myturn" : ""}`}>
          <div className="hud-who">
            <div className="hud-av">{me?.name?.charAt(0).toUpperCase() || "?"}</div>
            <span className="hud-name">{me?.name || "You"}</span>
          </div>
          <div className="hud-nums">
            <div className="hud-n"><span className="hn-label">Score</span><span className="hn-val">{scores[myId] || 0}</span></div>
            <div className="hud-sep" />
            <div className="hud-n"><span className="hn-label">Bid</span><span className="hn-val">{myBidVal !== undefined ? myBidVal : "—"}</span></div>
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

        {/* Scoreboard Overlay */}
        {showRoundSummary && roundSummaryData && (
          <div className="overlay">
            <div className="scoreboard">
              <div className="sb-head">
                <h2>{roundSummaryData.isFinal ? "🏆 Game Over!" : "Round Complete"}</h2>
                {!roundSummaryData.isFinal && (
                  <p className="sb-sub">{roundSummaryData.cardsThisRound} cards · Trump: <SuitIcon suit={roundSummaryData.trump} /> {roundSummaryData.trump}</p>
                )}
              </div>
              <div className="sb-scroll">
                <table className="sb-tbl">
                  <thead>
                    <tr>
                      <th className="th-sm">Cards</th>
                      <th className="th-sm">Trump</th>
                      {room?.players.map((pl) => (
                        <th key={pl.id} colSpan={3} className="th-player">
                          {pl.name}{pl.id === myId ? " (you)" : ""}
                        </th>
                      ))}
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
                    {[...gameHistory, roundSummaryData]
                      .filter((r) => {
                        if (r === roundSummaryData && gameHistory.includes(r)) return false;
                        return r && r.cardsThisRound !== undefined && r.cardsThisRound >= 0;
                      })
                      .map((round, idx) => (
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
                        const all = [...gameHistory, roundSummaryData].filter((r) => {
                          if (r === roundSummaryData && gameHistory.includes(r)) return false;
                          return r && r.cardsThisRound !== undefined;
                        });
                        const tb = all.reduce((s, r) => s + (r.bids?.[pl.id] || 0), 0);
                        const tt = all.reduce((s, r) => s + (r.tricksWon?.[pl.id] || 0), 0);
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
                  <button className="btn-main btn-lg" onClick={() => {
                    setShowRoundSummary(false); setRoundSummaryData(null);
                    setGameHistory([]); setGameStarted(false); setPhase("lobby");
                  }}>New Game</button>
                ) : isHost ? (
                  <button className="btn-main btn-lg" onClick={() => {
                    if (roundSummaryData) setGameHistory((prev) => [...prev, roundSummaryData]);
                    setShowRoundSummary(false); setRoundSummaryData(null);
                  }}>Next Round →</button>
                ) : (
                  <p className="sb-wait">Waiting for host…</p>
                )}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
