import pg from "pg";

const { Pool } = pg;

let pool = null;

export function getPool() {
  if (!pool) {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) {
      console.warn("⚠️  DATABASE_URL not set — database features disabled");
      return null;
    }
    pool = new Pool({
      connectionString,
      ssl: { rejectUnauthorized: false },
      max: 10,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 5000,
    });
    pool.on("error", (err) => {
      console.error("❌ Unexpected database pool error:", err.message);
    });
    console.log("✅ Database pool created");
  }
  return pool;
}

export async function query(text, params) {
  const p = getPool();
  if (!p) return null;
  try {
    return await p.query(text, params);
  } catch (err) {
    console.error("❌ DB query error:", err.message);
    return null;
  }
}

export async function initDatabase() {
  const p = getPool();
  if (!p) {
    console.warn("⚠️  Skipping database initialization — no DATABASE_URL");
    return false;
  }

  try {
    // Test connection
    await p.query("SELECT NOW()");
    console.log("✅ Database connection verified");

    // Run migrations
    await runMigrations(p);
    return true;
  } catch (err) {
    console.error("❌ Database initialization failed:", err.message);
    return false;
  }
}

async function runMigrations(p) {
  // Players table — persistent across games
  await p.query(`
    CREATE TABLE IF NOT EXISTS players (
      id VARCHAR(64) PRIMARY KEY,
      name VARCHAR(16) NOT NULL,
      is_ai BOOLEAN DEFAULT false,
      games_played INT DEFAULT 0,
      games_won INT DEFAULT 0,
      total_rounds_played INT DEFAULT 0,
      total_bids_made INT DEFAULT 0,
      total_bids_met INT DEFAULT 0,
      total_tricks_won INT DEFAULT 0,
      total_score INT DEFAULT 0,
      created_at TIMESTAMP DEFAULT NOW(),
      last_seen_at TIMESTAMP DEFAULT NOW()
    )
  `);

  // Games table
  await p.query(`
    CREATE TABLE IF NOT EXISTS games (
      id SERIAL PRIMARY KEY,
      room_code VARCHAR(8) NOT NULL,
      player_count INT NOT NULL,
      total_rounds INT NOT NULL,
      started_at TIMESTAMP DEFAULT NOW(),
      finished_at TIMESTAMP,
      winner_id VARCHAR(64)
    )
  `);

  // Game players — links players to games with final results
  await p.query(`
    CREATE TABLE IF NOT EXISTS game_players (
      id SERIAL PRIMARY KEY,
      game_id INT NOT NULL REFERENCES games(id),
      player_id VARCHAR(64) NOT NULL REFERENCES players(id),
      player_name VARCHAR(16) NOT NULL,
      is_ai BOOLEAN DEFAULT false,
      seat_position INT NOT NULL,
      final_score INT DEFAULT 0,
      finish_position INT,
      rounds_bid_met INT DEFAULT 0,
      total_rounds INT DEFAULT 0
    )
  `);

  // Rounds table
  await p.query(`
    CREATE TABLE IF NOT EXISTS rounds (
      id SERIAL PRIMARY KEY,
      game_id INT NOT NULL REFERENCES games(id),
      round_index INT NOT NULL,
      cards_per_player INT NOT NULL,
      trump_suit VARCHAR(10) NOT NULL,
      dealer_index INT NOT NULL,
      buried_cards JSONB,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);

  // Round results — per-player results for each round
  await p.query(`
    CREATE TABLE IF NOT EXISTS round_results (
      id SERIAL PRIMARY KEY,
      round_id INT NOT NULL REFERENCES rounds(id),
      game_id INT NOT NULL REFERENCES games(id),
      player_id VARCHAR(64) NOT NULL,
      bid INT NOT NULL,
      bid_position INT NOT NULL,
      tricks_won INT DEFAULT 0,
      met_bid BOOLEAN DEFAULT false,
      round_score INT DEFAULT 0,
      cumulative_score INT DEFAULT 0,
      hand_dealt JSONB,
      high_card_count INT DEFAULT 0,
      trump_count INT DEFAULT 0,
      void_suit_count INT DEFAULT 0,
      avg_rank_value REAL DEFAULT 0,
      cards_per_player INT NOT NULL,
      trump_suit VARCHAR(10) NOT NULL,
      is_ai BOOLEAN DEFAULT false
    )
  `);

  // Card plays — every single card with full context
  await p.query(`
    CREATE TABLE IF NOT EXISTS card_plays (
      id SERIAL PRIMARY KEY,
      round_id INT NOT NULL REFERENCES rounds(id),
      game_id INT NOT NULL REFERENCES games(id),
      trick_number INT NOT NULL,
      play_position INT NOT NULL,
      player_id VARCHAR(64) NOT NULL,
      card_suit VARCHAR(8) NOT NULL,
      card_rank VARCHAR(2) NOT NULL,
      trump_suit VARCHAR(10) NOT NULL,
      lead_suit VARCHAR(8),
      cards_per_player INT NOT NULL,
      cards_remaining INT NOT NULL,
      player_bid INT NOT NULL,
      player_tricks_so_far INT NOT NULL,
      tricks_needed INT NOT NULL,
      won_trick BOOLEAN DEFAULT false,
      is_ai BOOLEAN DEFAULT false
    )
  `);

  // Trick results — summary of each trick
  await p.query(`
    CREATE TABLE IF NOT EXISTS trick_results (
      id SERIAL PRIMARY KEY,
      round_id INT NOT NULL REFERENCES rounds(id),
      game_id INT NOT NULL REFERENCES games(id),
      trick_number INT NOT NULL,
      lead_suit VARCHAR(8) NOT NULL,
      trump_suit VARCHAR(10) NOT NULL,
      winner_id VARCHAR(64) NOT NULL,
      winning_card_suit VARCHAR(8) NOT NULL,
      winning_card_rank VARCHAR(2) NOT NULL,
      was_trumped BOOLEAN DEFAULT false,
      cards_per_player INT NOT NULL
    )
  `);

  // ===== INDEXES FOR AI LEARNING =====

  // Main card play lookup — "how does this card perform in this context?"
  await p.query(`
    CREATE INDEX IF NOT EXISTS idx_card_plays_lookup
    ON card_plays(card_suit, card_rank, cards_per_player, trump_suit, play_position)
  `);

  // Win rate by context
  await p.query(`
    CREATE INDEX IF NOT EXISTS idx_card_plays_winrate
    ON card_plays(cards_per_player, play_position, won_trick)
  `);

  // Bidding analysis
  await p.query(`
    CREATE INDEX IF NOT EXISTS idx_round_results_bidding
    ON round_results(cards_per_player, trump_suit, met_bid)
  `);

  // Hand profile lookup for pattern matching
  await p.query(`
    CREATE INDEX IF NOT EXISTS idx_round_results_profile
    ON round_results(cards_per_player, trump_suit, high_card_count, trump_count, void_suit_count)
  `);

  // Trick analysis
  await p.query(`
    CREATE INDEX IF NOT EXISTS idx_trick_results_lookup
    ON trick_results(cards_per_player, lead_suit, trump_suit)
  `);

  // Player stats lookup
  await p.query(`
    CREATE INDEX IF NOT EXISTS idx_game_players_stats
    ON game_players(player_id, game_id)
  `);

  // Games by completion
  await p.query(`
    CREATE INDEX IF NOT EXISTS idx_games_finished
    ON games(finished_at) WHERE finished_at IS NOT NULL
  `);

  // Live game state — survives server restarts
  await p.query(`
    CREATE TABLE IF NOT EXISTS game_state (
      room_code VARCHAR(8) PRIMARY KEY,
      state JSONB NOT NULL,
      updated_at TIMESTAMP DEFAULT NOW()
    )
  `);

  await p.query(`
    CREATE INDEX IF NOT EXISTS idx_game_state_updated
    ON game_state(updated_at)
  `);

  console.log("✅ Database migrations complete");
}

export async function shutdown() {
  if (pool) {
    await pool.end();
    console.log("✅ Database pool closed");
  }
}
