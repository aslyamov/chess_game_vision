// ============================================================
// Shared Types for Chess Game Vision Trainer
// ============================================================

export type PlayerColor = 'w' | 'b';
export type Phase = 'search' | 'move';

export const DEFAULT_FORMSPREE_ENDPOINT = 'https://formspree.io/f/meajrlwo';

// ── Threat Analysis ──────────────────────────────────────────
export interface ThreatMove {
  from: string;
  to: string;
  san: string;
  piece: string;
}

export interface ThreatResult {
  myChecks: ThreatMove[];       // checks student can give
  myCaptures: ThreatMove[];     // captures student can make
  oppChecks: ThreatMove[];      // checks opponent threatens
  oppCaptures: ThreatMove[];    // opponent pieces that can capture student's pieces
  // O(1) lookup maps — key: "from-to"
  myChecksMap: Map<string, ThreatMove>;
  myCapturesMap: Map<string, ThreatMove>;
  oppChecksMap: Map<string, ThreatMove>;
  oppCapturesMap: Map<string, ThreatMove>;
}

// ── Bot Levels (Lichess-style) ──────────────────────────────
export interface BotLevelConfig {
  level: number;
  name: string;
  approxElo: number;
  skillLevel: number;
  depth: number;
  movetimeMs: number;
}

export const BOT_LEVELS: Record<number, BotLevelConfig> = {
  1: { level: 1, name: 'Уровень 1', approxElo: 800,  skillLevel: 0,  depth: 1,  movetimeMs: 50 },
  2: { level: 2, name: 'Уровень 2', approxElo: 1100, skillLevel: 3,  depth: 2,  movetimeMs: 100 },
  3: { level: 3, name: 'Уровень 3', approxElo: 1400, skillLevel: 6,  depth: 3,  movetimeMs: 150 },
  4: { level: 4, name: 'Уровень 4', approxElo: 1700, skillLevel: 8,  depth: 4,  movetimeMs: 200 },
  5: { level: 5, name: 'Уровень 5', approxElo: 2000, skillLevel: 11, depth: 6,  movetimeMs: 300 },
  6: { level: 6, name: 'Уровень 6', approxElo: 2300, skillLevel: 14, depth: 8,  movetimeMs: 400 },
  7: { level: 7, name: 'Уровень 7', approxElo: 2500, skillLevel: 17, depth: 10, movetimeMs: 500 },
  8: { level: 8, name: 'Уровень 8', approxElo: 2800, skillLevel: 20, depth: 15, movetimeMs: 1000 },
};

export function getBotLevelConfig(level: number): BotLevelConfig {
  const rounded = Math.max(1, Math.min(8, Math.round(level) || 3));
  return BOT_LEVELS[rounded] || BOT_LEVELS[3];
}

// ── Settings ─────────────────────────────────────────────────
export interface GameSettings {
  studentName: string;
  stockfishLevel: number;         // 1–8
  searchTimerSeconds: number;     // seconds for Phase A
  showTargetCounts: boolean;      // show hint counters
  gameTimeMinutes: number;        // total game time (each side)
  incrementSeconds: number;       // increment per move
  formspreeEndpoint: string;      // Formspree URL
}

export const DEFAULT_SETTINGS: GameSettings = {
  studentName: '',
  stockfishLevel: 3,
  searchTimerSeconds: 30,
  showTargetCounts: true,
  gameTimeMinutes: 10,
  incrementSeconds: 5,
  formspreeEndpoint: DEFAULT_FORMSPREE_ENDPOINT,
};

// ── Game State (for persistence) ─────────────────────────────
export interface GameState {
  fen: string;
  pgn: string;
  phase: Phase;
  studentColor: PlayerColor;
  searchTimerRemaining: number;   // ms
  whiteTimeRemaining: number;     // ms
  blackTimeRemaining: number;     // ms
  stats: GameStats;
  moveNumber: number;
  missedThreats?: [number, MissedThreat[]][];
}

// ── Stats ─────────────────────────────────────────────────────
export interface CategoryStats {
  found: number;
  total: number;
}

export interface GameStats {
  myChecks: CategoryStats;
  myCaptures: CategoryStats;
  oppChecks: CategoryStats;
  oppCaptures: CategoryStats;
  bestMoveMatches: number;
  totalMoves: number;
  accuracySum: number;
  accuracies: number[];
  totalSearchTimeMs: number;
  searchPhaseCount: number;
}

export function createEmptyStats(): GameStats {
  return {
    myChecks:    { found: 0, total: 0 },
    myCaptures:  { found: 0, total: 0 },
    oppChecks:   { found: 0, total: 0 },
    oppCaptures: { found: 0, total: 0 },
    bestMoveMatches: 0,
    totalMoves: 0,
    accuracySum: 0,
    accuracies: [],
    totalSearchTimeMs: 0,
    searchPhaseCount: 0,
  };
}

// ── Missed Threats (for PGN subvariations) ────────────────────
export interface MissedThreat {
  san: string;         // SAN notation of the missed move
  side: 'my' | 'opp';  // 'my' = student's own threat, 'opp' = opponent's threat
  category: 'check' | 'capture';
}

/** Missed threats keyed by half-move index (0-based ply). */
export type MissedThreatsMap = Map<number, MissedThreat[]>;

// ── Stockfish ─────────────────────────────────────────────────
export interface StockfishResult {
  bestMove: string;   // e.g. "e2e4"
  score: number;      // centipawns relative to side to move
}

// ── Chessground types (minimal) ───────────────────────────────
export interface DrawShape {
  orig: string;
  dest?: string;
  brush: string;
}

export type CGColor = 'white' | 'black' | 'both';
