// ============================================================
// Shared Types for Chess Game Vision Trainer
// ============================================================

export type PlayerColor = 'w' | 'b';
export type Phase = 'search' | 'move';
export type GameResult = 'checkmate' | 'stalemate' | 'timeout' | 'draw';

// ── Move ─────────────────────────────────────────────────────
export interface MoveData {
  from: string;
  to: string;
  san: string;
  flags: string;
  piece: string;
  color: PlayerColor;
  captured?: string;
}

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

// ── Settings ─────────────────────────────────────────────────
export interface GameSettings {
  studentName: string;
  stockfishElo: number;           // 1000–2500
  searchTimerSeconds: number;     // seconds for Phase A
  showTargetCounts: boolean;      // show hint counters
  gameTimeMinutes: number;        // total game time (each side)
  incrementSeconds: number;       // increment per move
  formspreeEndpoint: string;      // Formspree URL
}

export const DEFAULT_SETTINGS: GameSettings = {
  studentName: '',
  stockfishElo: 1500,
  searchTimerSeconds: 30,
  showTargetCounts: true,
  gameTimeMinutes: 10,
  incrementSeconds: 5,
  formspreeEndpoint: '',
};

// ── Game State (for persistence) ─────────────────────────────
export interface GameState {
  fen: string;
  pgn: string;
  phase: Phase;
  searchTimerRemaining: number;   // ms
  whiteTimeRemaining: number;     // ms
  blackTimeRemaining: number;     // ms
  stats: GameStats;
  moveNumber: number;
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
  piece?: { role: string; color: string };
}

export type CGColor = 'white' | 'black' | 'both';
