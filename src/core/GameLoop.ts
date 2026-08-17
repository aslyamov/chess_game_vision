/**
 * GameLoop — core state machine for the dual-phase chess trainer.
 *
 * Phase A (search):  "Поиск шахов и взятий"
 *   User drags pieces to find checks and captures.
 *   Move is tested against threat maps and visually reverted.
 *
 * Phase B (move):    "Ваш ход"
 *   User plays the actual chess move as White.
 *   Stockfish responds. Loop transitions back to Phase A.
 */

import { Chess } from 'chess.js';
import type { GameSettings, GameState, Phase, ThreatResult } from '../types/index.js';
import { createEmptyStats } from '../types/index.js';
import { analyzeThreatsFull, getMoveKey, getAllDests, formatTime } from './ThreatAnalyzer.js';
import { StatsCollector, cpToWinPercent, calculateMoveAccuracy } from './StatsCollector.js';
import { StockfishEngine } from './StockfishWorker.js';
import { persistence } from './PersistenceManager.js';

export interface GameLoopCallbacks {
  onPhaseChange:     (phase: Phase, fen: string, dests: Map<string, string[]>) => void;
  onSearchTimerTick: (remainingMs: number) => void;
  onGameTimerTick:   (whiteMs: number, blackMs: number) => void;
  onThreatFeedback:  (orig: string, dest: string, correct: boolean) => void;
  onCountersUpdate:  (found: FoundSet, totals: ThreatTotals) => void;
  onStockfishMove:   (move: { from: string; to: string; fen: string; dests: Map<string, string[]> }) => void;
  onGameOver:        (result: GameOverResult) => void;
  onStatusMessage:   (msg: string, type: 'info' | 'success' | 'error' | 'warn') => void;
}

export type ThreatCategory = 'myChecks' | 'myCaptures' | 'oppChecks' | 'oppCaptures';

export interface FoundSet {
  myChecks: Set<string>;
  myCaptures: Set<string>;
  oppChecks: Set<string>;
  oppCaptures: Set<string>;
}

export interface ThreatTotals {
  myChecks: number;
  myCaptures: number;
  oppChecks: number;
  oppCaptures: number;
}

export interface GameOverResult {
  reason: 'checkmate' | 'stalemate' | 'timeout' | 'draw';
  winner?: 'white' | 'black' | 'draw';
  stats: ReturnType<StatsCollector['getStats']>;
  pgn: string;
}

class Ticker {
  private id: ReturnType<typeof setInterval> | null = null;
  start(fn: () => void, ms: number) { this.stop(); this.id = setInterval(fn, ms); }
  stop() { if (this.id !== null) { clearInterval(this.id); this.id = null; } }
}

export class GameLoop {
  private settings: GameSettings;
  private cb: GameLoopCallbacks;
  private engine: StockfishEngine;
  private statsCollector = new StatsCollector();

  private game = new Chess();
  private phase: Phase = 'search';
  private threats: ThreatResult | null = null;
  private found: FoundSet = this._emptyFound();
  private totals: ThreatTotals = { myChecks: 0, myCaptures: 0, oppChecks: 0, oppCaptures: 0 };
  private cachedDests: Map<string, string[]> = new Map();

  private searchRemaining = 0;
  private whiteMs = 0;
  private blackMs = 0;
  private searchTicker = new Ticker();
  private gameTicker   = new Ticker();
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private transitionTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(settings: GameSettings, callbacks: GameLoopCallbacks) {
    this.settings = settings;
    this.cb = callbacks;
    this.engine = new StockfishEngine();
    this.engine.applySettings(settings);
  }

  // ── Public API ───────────────────────────────────────────────

  startFresh(): void {
    this.statsCollector.reset();
    this.game = new Chess();
    this.whiteMs = this.settings.gameTimeMinutes * 60 * 1000;
    this.blackMs = this.settings.gameTimeMinutes * 60 * 1000;
    persistence.clearGameState();
    this._enterPhaseA();
  }

  restoreFromState(state: GameState): void {
    this.game = new Chess();
    try {
      this.game.loadPgn(state.pgn);
    } catch {
      this.game.load(state.fen);
    }
    this.whiteMs = state.whiteTimeRemaining;
    this.blackMs = state.blackTimeRemaining;
    this.statsCollector.reset();
    if (state.phase === 'search') {
      this._enterPhaseA(state.searchTimerRemaining);
    } else {
      this._enterPhaseB();
    }
  }

  /**
   * Handle user drag on the board.
   * Phase A: verifies threat, updates counters, visual is always undone.
   * Phase B: executes legal move, triggers Stockfish response.
   */
  handleBoardMove(orig: string, dest: string): void {
    if (this.phase === 'search') {
      this._handleThreatClick(orig, dest);
    } else {
      void this._handlePlayerMove(orig, dest);
    }
  }

  /**
   * Skip threat search and go directly to player move phase
   */
  skipToMovePhase(): void {
    if (this.phase === 'search') {
      this.searchTicker.stop();
      if (this.transitionTimer) clearTimeout(this.transitionTimer);
      this.statsCollector.endSearchPhase();
      this._enterPhaseB();
    }
  }

  getCurrentFen():   string                { return this.game.fen(); }
  getCurrentDests(): Map<string, string[]> { return this.cachedDests; }
  getPhase():        Phase                 { return this.phase; }
  getSearchTotal():  number                { return this.settings.searchTimerSeconds * 1000; }

  destroy(): void {
    this.searchTicker.stop();
    this.gameTicker.stop();
    if (this.transitionTimer) clearTimeout(this.transitionTimer);
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.engine.destroy();
  }

  // ── Phase A: "Поиск шахов и взятий" ───────────────────────────

  private _enterPhaseA(existingMs?: number): void {
    this.phase = 'search';
    this.found = this._emptyFound();
    this.gameTicker.stop();
    if (this.transitionTimer) clearTimeout(this.transitionTimer);

    const fen = this.game.fen();
    this.threats = analyzeThreatsFull(fen, 'w');
    this.cachedDests = getAllDests(fen);

    this.totals = {
      myChecks:    this.threats.myChecks.length,
      myCaptures:  this.threats.myCaptures.length,
      oppChecks:   this.threats.oppChecks.length,
      oppCaptures: this.threats.oppCaptures.length,
    };

    this.statsCollector.setThreatTotals(
      this.totals.myChecks, this.totals.myCaptures,
      this.totals.oppChecks, this.totals.oppCaptures,
    );
    this.statsCollector.startSearchPhase();

    this.cb.onPhaseChange('search', fen, this.cachedDests);
    this.cb.onCountersUpdate({ ...this.found }, { ...this.totals });

    const totalThreats = this.totals.myChecks + this.totals.myCaptures + this.totals.oppChecks + this.totals.oppCaptures;

    if (totalThreats === 0) {
      this.statsCollector.endSearchPhase();
      this._enterPhaseB();
      this.cb.onStatusMessage('Шахов и взятий нет (0). Ваш ход', 'info');
      this._save();
      return;
    }

    this.cb.onStatusMessage(`Найдите шахи и взятия (${totalThreats})`, 'info');
    this.searchRemaining = existingMs ?? (this.settings.searchTimerSeconds * 1000);

    this.searchTicker.start(() => {
      this.searchRemaining -= 100;
      this.cb.onSearchTimerTick(this.searchRemaining);
      if (this.searchRemaining <= 0) {
        this.searchTicker.stop();
        this.statsCollector.endSearchPhase();
        this._enterPhaseB();
      }
    }, 100);

    this._save();
  }

  private _handleThreatClick(orig: string, dest: string): void {
    if (!this.threats) return;
    const key = getMoveKey(orig, dest);
    let found = false;

    if (this.threats.myChecksMap.has(key) && !this.found.myChecks.has(key)) {
      this.found.myChecks.add(key);
      this.statsCollector.recordMyCheckFound();
      found = true;
    }
    if (this.threats.myCapturesMap.has(key) && !this.found.myCaptures.has(key)) {
      this.found.myCaptures.add(key);
      this.statsCollector.recordMyCaptureFound();
      found = true;
    }
    if (this.threats.oppChecksMap.has(key) && !this.found.oppChecks.has(key)) {
      this.found.oppChecks.add(key);
      this.statsCollector.recordOppCheckFound();
      found = true;
    }
    if (this.threats.oppCapturesMap.has(key) && !this.found.oppCaptures.has(key)) {
      this.found.oppCaptures.add(key);
      this.statsCollector.recordOppCaptureFound();
      found = true;
    }

    this.cb.onThreatFeedback(orig, dest, found);
    this.cb.onCountersUpdate({ ...this.found }, { ...this.totals });

    if (found) {
      this._save();
      if (this._allFound()) {
        this.searchTicker.stop();
        this.statsCollector.endSearchPhase();
        this.cb.onStatusMessage('Отлично! Все угрозы найдены!', 'success');
        this.transitionTimer = setTimeout(() => this._enterPhaseB(), 600);
      }
    }
  }

  // ── Phase B: "Ваш ход" ────────────────────────────────────────

  private _enterPhaseB(): void {
    this.searchTicker.stop();
    if (this.transitionTimer) clearTimeout(this.transitionTimer);
    this.phase = 'move';

    const fen = this.game.fen();
    this.cachedDests = getAllDests(fen);

    this.cb.onPhaseChange('move', fen, this.cachedDests);
    this.cb.onStatusMessage('Ваш ход', 'info');

    this.gameTicker.start(() => {
      this.whiteMs -= 100;
      this.cb.onGameTimerTick(this.whiteMs, this.blackMs);
      if (this.whiteMs <= 0) {
        this.gameTicker.stop();
        this._endGame('timeout', 'black');
      }
    }, 100);

    this._save();
  }

  private async _handlePlayerMove(orig: string, dest: string): Promise<void> {
    const fenBeforePlayer = this.game.fen();
    let moveResult;
    try {
      moveResult = this.game.move({ from: orig, to: dest, promotion: 'q' });
    } catch {
      return;
    }
    if (!moveResult) return;

    this.gameTicker.stop();
    this.whiteMs += this.settings.incrementSeconds * 1000;

    // 1. Evaluate player move against Stockfish in fenBeforePlayer (when it was White's turn)
    let winBefore = 50;
    let isBestMove = false;
    try {
      const evalRes = await this.engine.getBestMove(fenBeforePlayer, 250);
      winBefore = cpToWinPercent(evalRes.score);
      const sfBestMove = evalRes.bestMove.replace(/(..)(..).*/, '$1$2').toLowerCase();
      const playerUci = `${orig}${dest}`.toLowerCase();
      isBestMove = sfBestMove === playerUci;
    } catch (e) {
      console.warn('Pre-move evaluation error:', e);
    }

    if (this._checkGameOver()) {
      const moveAcc = isBestMove ? 100 : 95;
      this.statsCollector.recordPlayerMove(moveAcc, isBestMove);
      return;
    }

    this.cb.onStatusMessage('Stockfish думает…', 'info');

    // 2. Get Stockfish's response move for the new position (Black's turn)
    try {
      const thinkMs = Math.min(1500, Math.max(200, this.settings.stockfishElo / 3));
      const result = await this.engine.getBestMove(this.game.fen(), thinkMs);

      // Score from Black's perspective → negate for White's perspective
      const whiteScoreAfter = -result.score;
      const winAfter = cpToWinPercent(whiteScoreAfter);
      const moveAccuracy = isBestMove ? 100 : calculateMoveAccuracy(winBefore, winAfter);
      this.statsCollector.recordPlayerMove(moveAccuracy, isBestMove);

      if (!result.bestMove || result.bestMove === '(none)') {
        this._endGame('stalemate');
        return;
      }

      const sfFrom = result.bestMove.substring(0, 2);
      const sfTo   = result.bestMove.substring(2, 4);
      const sfProm = result.bestMove.substring(4) || undefined;

      try {
        this.game.move({ from: sfFrom, to: sfTo, promotion: sfProm });
      } catch {
        this._endGame('stalemate');
        return;
      }

      this.blackMs += this.settings.incrementSeconds * 1000;

      const newFen = this.game.fen();
      const newDests = getAllDests(newFen);
      this.cachedDests = newDests;

      this.cb.onStockfishMove({ from: sfFrom, to: sfTo, fen: newFen, dests: newDests });

      if (this._checkGameOver()) return;

      this._save();
      this.transitionTimer = setTimeout(() => this._enterPhaseA(), 500);
    } catch (e) {
      console.error('Stockfish error:', e);
      this.cb.onStatusMessage('Ошибка движка', 'error');
    }
  }

  // ── Helpers ───────────────────────────────────────────────────

  private _allFound(): boolean {
    return (
      this.found.myChecks.size    === this.totals.myChecks    &&
      this.found.myCaptures.size  === this.totals.myCaptures  &&
      this.found.oppChecks.size   === this.totals.oppChecks   &&
      this.found.oppCaptures.size === this.totals.oppCaptures
    );
  }

  private _checkGameOver(): boolean {
    if (this.game.isCheckmate()) {
      this._endGame('checkmate', this.game.turn() === 'w' ? 'black' : 'white');
      return true;
    }
    if (this.game.isStalemate() || this.game.isDraw()) {
      this._endGame('draw', 'draw');
      return true;
    }
    return false;
  }

  private _endGame(reason: GameOverResult['reason'], winner?: 'white' | 'black' | 'draw'): void {
    this.searchTicker.stop();
    this.gameTicker.stop();
    if (this.transitionTimer) clearTimeout(this.transitionTimer);
    this.statsCollector.endSearchPhase();
    persistence.clearGameState();

    const d = new Date();
    const dateStr = `${d.getFullYear()}.${String(d.getMonth() + 1).padStart(2, '0')}.${String(d.getDate()).padStart(2, '0')}`;
    let resultStr = '*';
    if (winner === 'white') resultStr = '1-0';
    else if (winner === 'black') resultStr = '0-1';
    else if (winner === 'draw') resultStr = '1/2-1/2';

    try {
      this.game.header(
        'Event', 'Chess Game Vision Training',
        'Site', 'Chess Game Vision',
        'Date', dateStr,
        'Round', '1',
        'White', this.settings.studentName || 'Ученик',
        'Black', `Stockfish (${this.settings.stockfishElo} Elo)`,
        'Result', resultStr
      );
    } catch {
      // ignore header formatting errors
    }

    this.cb.onGameOver({
      reason,
      winner,
      stats: this.statsCollector.getStats(),
      pgn: this.game.pgn()
    });
  }

  private _emptyFound(): FoundSet {
    return { myChecks: new Set(), myCaptures: new Set(), oppChecks: new Set(), oppCaptures: new Set() };
  }

  private _save(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      persistence.saveGameState({
        fen: this.game.fen(),
        pgn: this.game.pgn(),
        phase: this.phase,
        searchTimerRemaining: this.searchRemaining,
        whiteTimeRemaining: this.whiteMs,
        blackTimeRemaining: this.blackMs,
        stats: createEmptyStats(),
        moveNumber: this.game.moveNumber(),
      });
    }, 200);
  }
}

export { formatTime };
