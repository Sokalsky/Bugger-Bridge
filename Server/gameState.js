// Game State Persistence for Bugger Bridge
// Saves and restores live game state to Postgres so games survive server restarts

import { query } from "./db.js";

/**
 * Serialize a room object for storage.
 * Strips non-serializable fields (Sets, socket references) and
 * rebuilds them on load.
 */
function serializeRoom(room) {
  return {
    players: room.players.map(p => ({
      id: p.id,
      name: p.name,
      isAI: p.isAI || false,
      // socketId is NOT saved — reconnection handles this
    })),
    roundIndex: room.roundIndex,
    trumpIndex: room.trumpIndex,
    roundSequence: room.roundSequence,
    bids: room.bids,
    tricksWon: room.tricksWon,
    scores: room.scores,
    biddingOrder: room.biddingOrder,
    currentBidIndex: room.currentBidIndex,
    playOrder: room.playOrder,
    currentTurnIndex: room.currentTurnIndex,
    currentTrick: room.currentTrick,
    hands: room.hands,
    leadSuit: room.leadSuit,
    buriedCards: room.buriedCards || [],
    trickNumber: room.trickNumber || 0,
    dbGameId: room.dbGameId || null,
    dbRoundId: room.dbRoundId || null,
    gameHistory: room.gameHistory || [],
  };
}

/**
 * Deserialize stored state back into a live room object.
 * Re-creates Sets and adds null socketIds.
 */
function deserializeRoom(stored) {
  return {
    players: stored.players.map(p => ({
      ...p,
      socketId: null, // no one is connected yet after restart
    })),
    roundIndex: stored.roundIndex,
    trumpIndex: stored.trumpIndex,
    roundSequence: stored.roundSequence,
    bids: stored.bids || {},
    tricksWon: stored.tricksWon || {},
    scores: stored.scores || {},
    biddingOrder: stored.biddingOrder || [],
    currentBidIndex: stored.currentBidIndex || 0,
    playOrder: stored.playOrder || [],
    currentTurnIndex: stored.currentTurnIndex || 0,
    currentTrick: stored.currentTrick || [],
    hands: stored.hands || {},
    leadSuit: stored.leadSuit || null,
    buriedCards: stored.buriedCards || [],
    trickNumber: stored.trickNumber || 0,
    dbGameId: stored.dbGameId || null,
    dbRoundId: stored.dbRoundId || null,
    gameHistory: stored.gameHistory || [],
    readyPlayers: new Set(),
  };
}

/**
 * Save a game's current state to the database.
 * Called after every meaningful state change.
 */
export async function saveGameState(roomCode, room) {
  if (!roomCode || !room) return;

  // Only save if the game has actually started (has a round sequence)
  if (!room.roundSequence || room.roundSequence.length === 0) return;

  try {
    const state = serializeRoom(room);
    await query(
      `INSERT INTO game_state (room_code, state, updated_at)
       VALUES ($1, $2, NOW())
       ON CONFLICT (room_code) DO UPDATE SET
         state = $2,
         updated_at = NOW()`,
      [roomCode, JSON.stringify(state)]
    );
  } catch (err) {
    console.error("❌ saveGameState error:", err.message);
  }
}

/**
 * Load all active (saved) games from the database.
 * Called on server startup to restore in-progress games.
 */
export async function loadAllGameStates() {
  try {
    // Only load games updated in the last 24 hours (stale games are abandoned)
    const result = await query(
      `SELECT room_code, state FROM game_state
       WHERE updated_at > NOW() - INTERVAL '24 hours'`
    );

    if (!result?.rows) return {};

    const rooms = {};
    for (const row of result.rows) {
      try {
        const stored = typeof row.state === "string" ? JSON.parse(row.state) : row.state;
        rooms[row.room_code] = deserializeRoom(stored);
        console.log(`🔄 Restored game: ${row.room_code} (round ${stored.roundIndex + 1}/${stored.roundSequence.length})`);
      } catch (e) {
        console.error(`❌ Failed to restore game ${row.room_code}:`, e.message);
      }
    }

    return rooms;
  } catch (err) {
    console.error("❌ loadAllGameStates error:", err.message);
    return {};
  }
}

/**
 * Remove a game's saved state (called when game finishes or room is cleaned up).
 */
export async function deleteGameState(roomCode) {
  if (!roomCode) return;
  try {
    await query(`DELETE FROM game_state WHERE room_code = $1`, [roomCode]);
  } catch (err) {
    console.error("❌ deleteGameState error:", err.message);
  }
}

/**
 * List all active games (for the /api/active-games endpoint).
 */
export async function listActiveGames() {
  try {
    const result = await query(
      `SELECT room_code, state, updated_at FROM game_state
       WHERE updated_at > NOW() - INTERVAL '24 hours'
       ORDER BY updated_at DESC`
    );

    if (!result?.rows) return [];

    return result.rows.map(row => {
      const s = typeof row.state === "string" ? JSON.parse(row.state) : row.state;
      return {
        roomCode: row.room_code,
        players: s.players.map(p => ({ name: p.name, isAI: p.isAI })),
        playerCount: s.players.length,
        round: `${s.roundIndex + 1}/${s.roundSequence.length}`,
        scores: s.scores,
        updatedAt: row.updated_at,
      };
    });
  } catch (err) {
    console.error("❌ listActiveGames error:", err.message);
    return [];
  }
}
