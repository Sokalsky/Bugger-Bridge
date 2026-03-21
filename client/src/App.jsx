import React, { useState, useEffect, useRef } from "react";
import io from "socket.io-client";
import "./App.css";

import JoinScreen from "./components/JoinScreen";
import Lobby from "./components/Lobby";
import InfoBar from "./components/InfoBar";
import HUD from "./components/HUD";
import Scoreboard from "./components/Scoreboard";
import SuitIcon from "./components/SuitIcon";

const SERVER_URL = import.meta.env.VITE_SERVER_URL || "http://localhost:4000";
const socket = io(SERVER_URL);

let savedId = sessionStorage.getItem("buggerBridgePlayerId");
if (!savedId) {
  savedId = crypto.randomUUID();
  sessionStorage.setItem("buggerBridgePlayerId", savedId);
}

// ===============================
// HELPERS
// ===============================
function getCardImage(card) {
  if (!card?.rank || !card?.suit) return `${import.meta.env.BASE_URL}cards/Back.svg`;
  const suit = card.suit.toLowerCase();
  const rankMap = { A: "ace", K: "king", Q: "queen", J: "jack" };
  const rank = rankMap[card.rank] || card.rank.toLowerCase();
  return `${import.meta.env.BASE_URL}cards/${rank}_of_${suit}.svg`;
}

function getPlayerPosition(players, myId, playerId) {
  if (!players || !myId) return "bottom";
  const myIndex = players.findIndex((p) => p.id === myId);
  const idx = players.findIndex((p) => p.id === playerId);
  if (idx === -1) return "bottom";
  const relative = (idx - myIndex + players.length) % players.length;
  if (players.length === 3) return ["bottom", "left", "right"][relative] || "bottom";
  if (players.length === 4) return ["bottom", "left", "top", "right"][relative] || "bottom";
  return "bottom";
}

// ===============================
// APP
// ===============================
export default function App() {
  // Connection & lobby state
  const [roomCode, setRoomCode] = useState("");
  const [playerName, setPlayerName] = useState("");
  const [joined, setJoined] = useState(false);
  const [room, setRoom] = useState(null);
  const [myId, setMyId] = useState(savedId);
  const [readyPlayers, setReadyPlayers] = useState(new Set());
  const [isReady, setIsReady] = useState(false);
  const [isHost, setIsHost] = useState(false);

  // Game state
  const [roundData, setRoundData] = useState(null);
  const [bidding, setBidding] = useState(false);
  const [bids, setBids] = useState({});
  const [myBid, setMyBid] = useState("0");
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
  const [opponentHandSizes, setOpponentHandSizes] = useState({});
  const [trickWinnerName, setTrickWinnerName] = useState(null);

  // Scoreboard state
  const [showRoundSummary, setShowRoundSummary] = useState(false);
  const [roundSummaryData, setRoundSummaryData] = useState(null);
  const [gameHistory, setGameHistory] = useState([]);
  const autoHideTimerRef = useRef(null);
  const trickClearTimerRef = useRef(null);

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
      // Cancel any pending trick clear from previous trickComplete
      if (trickClearTimerRef.current) {
        clearTimeout(trickClearTimerRef.current);
        trickClearTimerRef.current = null;
      }
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
      // Store the timeout ref so cardPlayed can cancel it if a new trick starts before it fires
      trickClearTimerRef.current = setTimeout(() => {
        setPlayedCards([]); setLastWinner(null); setTrickWinnerName(null);
        trickClearTimerRef.current = null;
      }, 1800);
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
      // Show scoresheet quickly — server waits 2s before starting next round
      setTimeout(() => setShowRoundSummary(true), 500);
    });

    socket.on("invalidBid", (msg) => alert(msg));
    socket.on("invalidPlay", () => { setCanPlay(true); });

    socket.on("gameOver", (data) => {
      setScores(data.scores);
      setPhase("gameOver");
      // Restore full game history for the final scoresheet
      if (data.gameHistory && data.gameHistory.length > 0) {
        setGameHistory(data.gameHistory);
      }
      const finalRoundInfo = {
        tricksWon: data.tricksWon || {}, bids: data.bids || {}, scores: data.scores,
        roundNumber: "Final", cardsThisRound: roundData?.cardsThisRound || 0,
        trump: roundData?.trump || "Game Over", buriedCards: [], isFinal: true,
      };
      setRoundSummaryData(finalRoundInfo);
      // Show final scoresheet after a short delay (roundOver already showed the last round)
      setTimeout(() => setShowRoundSummary(true), 3000);
    });

    socket.on("rejoinGame", (data) => {
      setGameStarted(true);

      // Reconstruct roundData in the format components expect
      setRoundData({
        displayRound: data.displayRound,
        cardsThisRound: data.cardsThisRound,
        trump: data.trump,
        scores: data.scores,
      });

      setMyHand(data.myHand || []);
      setBids(data.bids || {});
      setTricksWon(data.tricksWon || {});
      setScores(data.scores || {});
      setPlayedCards(data.currentTrick || []);

      // Set phase and turn info
      const phase = data.phase || "play";
      setPhase(phase);
      setCurrentBidder(data.currentBidder || null);
      setCurrentPlayer(data.currentPlayer || null);

      // Set bidding state
      if (phase === "bidding") {
        setBidding(true);
        setCanPlay(false);
      } else {
        setBidding(false);
        // Enable play if it's our turn
        const isMyTurn = data.currentPlayer === savedId || data.currentPlayer === myId;
        setCanPlay(isMyTurn);
      }

      // Reconstruct opponent hand sizes
      if (data.handSizes) {
        const sizes = {};
        Object.keys(data.handSizes).forEach((pid) => {
          if (pid !== savedId && pid !== myId) sizes[pid] = data.handSizes[pid];
        });
        setOpponentHandSizes(sizes);
      }

      // Restore round history for scoresheet
      if (data.gameHistory && data.gameHistory.length > 0) {
        setGameHistory(data.gameHistory);
      }

      // Update room data if players were sent
      if (data.players) {
        setRoom((prev) => prev ? { ...prev, players: data.players } : { players: data.players });
      }
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
  // DERIVED VALUES
  // ===============================
  const isMyTurn = myId === currentBidder || myId === currentPlayer;
  const me = room?.players?.find((p) => p.id === myId);
  const opponents = room?.players?.filter((p) => p.id !== myId) || [];
  const totalBidsVal = Object.values(bids).reduce((s, b) => s + (b || 0), 0);
  const myBidVal = bids[myId];
  const myTricksVal = tricksWon[myId] || 0;

  // ===== JOIN SCREEN =====
  if (!joined) {
    return (
      <JoinScreen
        playerName={playerName} setPlayerName={setPlayerName}
        roomCode={roomCode} setRoomCode={setRoomCode}
        createRoom={createRoom} joinRoom={joinRoom}
      />
    );
  }

  // ===== LOBBY =====
  if (!gameStarted) {
    return (
      <Lobby
        room={room} roomCode={roomCode} myId={myId}
        readyPlayers={readyPlayers} isReady={isReady} isHost={isHost}
        toggleReady={toggleReady} addAI={addAI} startRound={startRound}
      />
    );
  }

  // ===== GAME TABLE =====
  return (
    <div className="app-root">
      <div className="game-table">
        <InfoBar roundData={roundData} bidding={bidding} phase={phase} totalBids={totalBidsVal} />

        {/* Felt */}
        <div className="felt">
          {/* Opponents */}
          {opponents.map((opp) => {
            const pos = getPlayerPosition(room?.players, myId, opp.id);
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
                    <div key={i} className={`mini-back mb-${pos}`} style={{ "--i": i, "--n": handSize }} />
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
                  const pos = getPlayerPosition(room?.players, myId, p.playerId);
                  const isW = lastWinner === p.playerId;
                  const playerName = room?.players?.find(pl => pl.id === p.playerId)?.name || "";
                  return (
                    <div key={`${p.playerId}-${p.card.rank}-${p.card.suit}`}
                      className={`trick-slot trick-from-${pos} ${isW ? "trick-winner" : ""}`}
                      style={{ animationDelay: `${i * 0.07}s` }}>
                      <img src={getCardImage(p.card)} alt={`${p.card.rank} ${p.card.suit}`} draggable={false} />
                      <div className="trick-label">{p.playerId === myId ? "You" : playerName}</div>
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

        <HUD
          me={me} myId={myId} scores={scores}
          myBidVal={myBidVal} myTricksVal={myTricksVal}
          isMyTurn={isMyTurn} bidding={bidding}
          myBid={myBid} setMyBid={setMyBid}
          submitBid={submitBid} roundData={roundData}
        />

        {showRoundSummary && (
          <Scoreboard
            room={room} myId={myId}
            gameHistory={gameHistory}
            roundSummaryData={roundSummaryData}
            isHost={isHost}
            onNextRound={() => {
              if (roundSummaryData) setGameHistory((prev) => [...prev, roundSummaryData]);
              setShowRoundSummary(false); setRoundSummaryData(null);
            }}
            onNewGame={() => {
              setShowRoundSummary(false); setRoundSummaryData(null);
              setGameHistory([]); setGameStarted(false); setPhase("lobby");
            }}
          />
        )}
      </div>
    </div>
  );
}
