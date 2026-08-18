/**
 * StatsCollector — accumulates game metrics throughout the game.
 * Uses Lichess win-percentage formula for move and game accuracy.
 */

import type { GameStats } from '../types/index.js';
import { createEmptyStats } from '../types/index.js';

/**
 * Convert Stockfish centipawns (from side-to-move perspective) to Win Probability (0% to 100%)
 * Formula: P(win) = 100 / (1 + exp(-0.00368208 * cp))
 */
export function cpToWinPercent(cp: number): number {
  return 100 / (1 + Math.exp(-0.00368208 * cp));
}

/**
 * Calculate Lichess single-move accuracy percentage (0% to 100%) from win% drop:
 * deltaWin = max(0, winBefore - winAfter)
 * accuracy = 103.1668 * exp(-0.043544 * deltaWin) - 3.1669 (clamped to 0..100)
 */
export function calculateMoveAccuracy(winBefore: number, winAfter: number): number {
  const deltaWin = Math.max(0, winBefore - winAfter);
  if (deltaWin === 0) return 100;
  const rawAcc = 103.1668 * Math.exp(-0.043544 * deltaWin) - 3.1669;
  return Math.max(0, Math.min(100, Math.round(rawAcc * 10) / 10));
}

export class StatsCollector {
  private stats: GameStats = createEmptyStats();
  private searchPhaseStart: number | null = null;

  reset(): void {
    this.stats = createEmptyStats();
    this.searchPhaseStart = null;
  }

  restoreStats(saved?: GameStats): void {
    if (!saved) {
      this.reset();
      return;
    }
    this.stats = {
      myChecks:    { ...saved.myChecks },
      myCaptures:  { ...saved.myCaptures },
      oppChecks:   { ...saved.oppChecks },
      oppCaptures: { ...saved.oppCaptures },
      bestMoveMatches: saved.bestMoveMatches ?? 0,
      totalMoves: saved.totalMoves ?? 0,
      accuracySum: saved.accuracySum ?? 0,
      accuracies: Array.isArray(saved.accuracies) ? [...saved.accuracies] : [],
      totalSearchTimeMs: saved.totalSearchTimeMs ?? 0,
      searchPhaseCount: saved.searchPhaseCount ?? 0,
    };
    this.searchPhaseStart = null;
  }

  getStats(): GameStats {
    return {
      myChecks:    { ...this.stats.myChecks },
      myCaptures:  { ...this.stats.myCaptures },
      oppChecks:   { ...this.stats.oppChecks },
      oppCaptures: { ...this.stats.oppCaptures },
      bestMoveMatches: this.stats.bestMoveMatches,
      totalMoves: this.stats.totalMoves,
      accuracySum: this.stats.accuracySum,
      accuracies: [...this.stats.accuracies],
      totalSearchTimeMs: this.stats.totalSearchTimeMs,
      searchPhaseCount: this.stats.searchPhaseCount,
    };
  }

  // ── Search Phase Timing ──────────────────────────────────────

  startSearchPhase(): void {
    this.searchPhaseStart = Date.now();
    this.stats.searchPhaseCount++;
  }

  endSearchPhase(): void {
    if (this.searchPhaseStart !== null) {
      this.stats.totalSearchTimeMs += Date.now() - this.searchPhaseStart;
      this.searchPhaseStart = null;
    }
  }

  // ── Threat Totals ────────────────────────────────────────────

  setThreatTotals(myChecks: number, myCaptures: number, oppChecks: number, oppCaptures: number): void {
    this.stats.myChecks.total    += myChecks;
    this.stats.myCaptures.total  += myCaptures;
    this.stats.oppChecks.total   += oppChecks;
    this.stats.oppCaptures.total += oppCaptures;
  }

  // ── Threat Found ─────────────────────────────────────────────

  recordMyCheckFound(): void   { this.stats.myChecks.found++;    }
  recordMyCaptureFound(): void { this.stats.myCaptures.found++;  }
  recordOppCheckFound(): void  { this.stats.oppChecks.found++;   }
  recordOppCaptureFound(): void{ this.stats.oppCaptures.found++; }

  // ── Move Quality (Lichess Accuracy) ──────────────────────────

  recordPlayerMove(moveAccuracy: number, isBestMove: boolean): void {
    this.stats.totalMoves++;
    this.stats.accuracies.push(moveAccuracy);
    this.stats.accuracySum += moveAccuracy;
    if (isBestMove || moveAccuracy >= 99.5) {
      this.stats.bestMoveMatches++;
    }
  }
}
