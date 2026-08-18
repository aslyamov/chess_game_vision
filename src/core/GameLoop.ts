/**
 * GameLoop — core state machine for the dual-phase chess trainer.
 *
 * Supports playing as either White or Black (randomly selected on new game).
 *
 * Phase A (search):  "Поиск шахов и взятий"
 *   User drags pieces to find checks and captures.
 *   Move is tested against threat maps and visually reverted.
 *
 * Phase B (move):    "Ваш ход"
 *   User plays the actual chess move.
 *   Stockfish responds. Loop transitions back to Phase A.
 */

import { Chess } from 'chess.js';
import type { GameSettings, GameState, Phase, ThreatResult, ThreatMove, GameStats, PlayerColor } from '../types/index.js';
import { getBotLevelConfig } from '../types/index.js';
import { analyzeThreatsFull, getMoveKey, getLegalDests } from './ThreatAnalyzer.js';
import { StatsCollector, cpToWinPercent, calculateMoveAccuracy } from './StatsCollector.js';
import { StockfishEngine } from './StockfishWorker.js';
import { persistence } from './PersistenceManager.js';

export interface GameLoopCallbacks {
  onGameInit?:       (studentColor: PlayerColor) => void;
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
  studentColor: PlayerColor;
  stats: GameStats;
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

  private studentColor: PlayerColor = 'w';
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

  private isBusy = false;
  private isGameOver = false;

  constructor(settings: GameSettings, callbacks: GameLoopCallbacks) {
    this.settings = settings;
    this.cb = callbacks;
    this.engine = new StockfishEngine();
    this.engine.applySettings(settings);
  }

  // ── Public API ───────────────────────────────────────────────

  startFresh(): void {
    this.studentColor = Math.random() < 0.5 ? 'w' : 'b';
    this.isGameOver = false;
    this.isBusy = false;
    this.statsCollector.reset();
    this.game = new Chess();
    this.whiteMs = this.settings.gameTimeMinutes * 60 * 1000;
    this.blackMs = this.settings.gameTimeMinutes * 60 * 1000;
    persistence.clearGameState();

    this.cb.onGameInit?.(this.studentColor);
    this.cb.onGameTimerTick(this.whiteMs, this.blackMs);

    if (this.studentColor === 'w') {
      this._enterPhaseA();
    } else {
      void this._stockfishOpeningMove();
    }
  }

  restoreFromState(state: GameState): void {
    this.studentColor = state.studentColor || 'w';
    this.isGameOver = false;
    this.isBusy = false;
    this.game = new Chess();
    try {
      this.game.loadPgn(state.pgn);
    } catch {
      this.game.load(state.fen);
    }
    this.whiteMs = state.whiteTimeRemaining;
    this.blackMs = state.blackTimeRemaining;
    this.statsCollector.restoreStats(state.stats);

    this.cb.onGameInit?.(this.studentColor);
    this.cb.onGameTimerTick(this.whiteMs, this.blackMs);

    if (state.phase === 'search') {
      this._enterPhaseA(state.searchTimerRemaining);
    } else {
      this._enterPhaseB();
    }
  }

  getStudentColor(): PlayerColor {
    return this.studentColor;
  }

  /**
   * Handle user drag on the board.
   * Phase A: verifies threat, updates counters, visual is always undone.
   * Phase B: executes legal move, triggers Stockfish response.
   */
  handleBoardMove(orig: string, dest: string): void {
    if (this.isGameOver || this.isBusy) return;

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
    if (this.isGameOver || this.isBusy) return;

    if (this.phase === 'search') {
      if (this.settings.searchTimerSeconds === 0 && !this._allFound()) {
        this.cb.onStatusMessage('Нужно найти все шахи и взятия!', 'warn');
        return;
      }
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
    this.isGameOver = true;
    this.isBusy = false;
    this.searchTicker.stop();
    this.gameTicker.stop();
    if (this.transitionTimer) clearTimeout(this.transitionTimer);
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.engine.destroy();
  }

  // ── Stockfish Move Helper ────────────────────────────────────

  private _applyStockfishMove(bestMove: string): { from: string; to: string } | null {
    if (!bestMove || bestMove === '(none)') {
      this._endGame('stalemate');
      return null;
    }

    const from = bestMove.substring(0, 2);
    const to = bestMove.substring(2, 4);
    const promotion = bestMove.substring(4) || undefined;

    try {
      this.game.move({ from, to, promotion });
      return { from, to };
    } catch {
      this._endGame('stalemate');
      return null;
    }
  }

  // ── Opening Move when Student plays Black ────────────────────

  private async _stockfishOpeningMove(): Promise<void> {
    this.isBusy = true;
    this.cb.onStatusMessage('Stockfish делает первый ход (1. e4)…', 'info');

    try {
      const result = await this.engine.getBotMove(this.game.fen());
      const move = this._applyStockfishMove(result.bestMove);
      if (!move) return;

      this.whiteMs += this.settings.incrementSeconds * 1000;

      const newFen = this.game.fen();
      this.cachedDests = getLegalDests(this.game);

      this.cb.onStockfishMove({ from: move.from, to: move.to, fen: newFen, dests: this.cachedDests });
      this.cb.onGameTimerTick(this.whiteMs, this.blackMs);

      this._save();
      this.transitionTimer = setTimeout(() => this._enterPhaseA(), 500);
    } catch (e) {
      console.error('Stockfish error on opening move:', e);
      this.cb.onStatusMessage('Ошибка движка', 'error');
    } finally {
      this.isBusy = false;
    }
  }

  // ── Phase A: "Поиск шахов и взятий" ───────────────────────────

  private _enterPhaseA(existingMs?: number): void {
    if (this.isGameOver) return;

    this.phase = 'search';
    this.found = this._emptyFound();
    this.gameTicker.stop();
    if (this.transitionTimer) clearTimeout(this.transitionTimer);

    const fen = this.game.fen();
    const threatAnalysis = analyzeThreatsFull(fen, this.studentColor);
    this.threats = threatAnalysis;
    this.cachedDests = threatAnalysis.dests;

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

    this.searchRemaining = existingMs ?? (this.settings.searchTimerSeconds * 1000);
    this.cb.onSearchTimerTick(this.searchRemaining);

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

    if (this.settings.searchTimerSeconds > 0) {
      let lastTick = Date.now();
      this.searchTicker.start(() => {
        const now = Date.now();
        const delta = now - lastTick;
        lastTick = now;

        this.searchRemaining = Math.max(0, this.searchRemaining - delta);
        this.cb.onSearchTimerTick(this.searchRemaining);
        if (this.searchRemaining <= 0) {
          this.searchTicker.stop();
          this.statsCollector.endSearchPhase();
          this._enterPhaseB();
        }
      }, 150);
    }

    this._save();
  }

  private _handleThreatClick(orig: string, dest: string): void {
    if (!this.threats || this.isGameOver) return;
    const key = getMoveKey(orig, dest);
    let found = false;

    const categories: Array<{
      map: Map<string, ThreatMove>;
      foundSet: Set<string>;
      recordFn: () => void;
    }> = [
      { map: this.threats.myChecksMap,    foundSet: this.found.myChecks,    recordFn: () => this.statsCollector.recordMyCheckFound() },
      { map: this.threats.myCapturesMap,  foundSet: this.found.myCaptures,  recordFn: () => this.statsCollector.recordMyCaptureFound() },
      { map: this.threats.oppChecksMap,   foundSet: this.found.oppChecks,   recordFn: () => this.statsCollector.recordOppCheckFound() },
      { map: this.threats.oppCapturesMap, foundSet: this.found.oppCaptures, recordFn: () => this.statsCollector.recordOppCaptureFound() },
    ];

    for (const cat of categories) {
      if (cat.map.has(key) && !cat.foundSet.has(key)) {
        cat.foundSet.add(key);
        cat.recordFn();
        found = true;
      }
    }

    this.cb.onThreatFeedback(orig, dest, found);
    this.cb.onCountersUpdate({ ...this.found }, { ...this.totals });

    if (found) {
      this._save();
      if (this._allFound()) {
        this.searchTicker.stop();
        this.statsCollector.endSearchPhase();
        this.cb.onStatusMessage('Отлично! Все угрозы найдены!', 'success');
        this.transitionTimer = setTimeout(() => this._enterPhaseB(), 500);
      }
    }
  }

  // ── Phase B: "Ваш ход" ────────────────────────────────────────

  private _enterPhaseB(): void {
    if (this.isGameOver) return;

    this.searchTicker.stop();
    if (this.transitionTimer) clearTimeout(this.transitionTimer);
    this.phase = 'move';

    const fen = this.game.fen();
    this.cachedDests = getLegalDests(this.game);

    this.cb.onPhaseChange('move', fen, this.cachedDests);
    this.cb.onStatusMessage('Ваш ход', 'info');

    let lastGameTick = Date.now();
    this.gameTicker.start(() => {
      const now = Date.now();
      const delta = now - lastGameTick;
      lastGameTick = now;

      if (this.studentColor === 'w') {
        this.whiteMs = Math.max(0, this.whiteMs - delta);
        if (this.whiteMs <= 0) {
          this.gameTicker.stop();
          this._endGame('timeout', 'black');
          return;
        }
      } else {
        this.blackMs = Math.max(0, this.blackMs - delta);
        if (this.blackMs <= 0) {
          this.gameTicker.stop();
          this._endGame('timeout', 'white');
          return;
        }
      }

      this.cb.onGameTimerTick(this.whiteMs, this.blackMs);
    }, 200);

    this._save();
  }

  private async _handlePlayerMove(orig: string, dest: string): Promise<void> {
    if (this.isBusy || this.isGameOver) return;

    const fenBeforePlayer = this.game.fen();
    let moveResult;
    try {
      moveResult = this.game.move({ from: orig, to: dest, promotion: 'q' });
    } catch {
      return;
    }
    if (!moveResult) return;

    this.isBusy = true;
    this.gameTicker.stop();

    try {
      // 1. Evaluate player move against Stockfish in fenBeforePlayer (student's turn)
      let winBefore = 50;
      let isBestMove = false;
      try {
        const evalRes = await this.engine.getEvaluation(fenBeforePlayer, 250);
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

      // Add increment to player's clock
      if (this.studentColor === 'w') {
        this.whiteMs += this.settings.incrementSeconds * 1000;
      } else {
        this.blackMs += this.settings.incrementSeconds * 1000;
      }
      this.cb.onGameTimerTick(this.whiteMs, this.blackMs);

      this.cb.onStatusMessage('Stockfish думает…', 'info');

      // 2. Get Stockfish's response move for the new position
      const result = await this.engine.getBotMove(this.game.fen());

      // Score from side-to-move (Stockfish) -> negate for student's perspective
      const studentScoreAfter = -result.score;
      const winAfter = cpToWinPercent(studentScoreAfter);
      const moveAccuracy = isBestMove ? 100 : calculateMoveAccuracy(winBefore, winAfter);
      this.statsCollector.recordPlayerMove(moveAccuracy, isBestMove);

      const move = this._applyStockfishMove(result.bestMove);
      if (!move) return;

      // Add increment to Stockfish's clock
      if (this.studentColor === 'w') {
        this.blackMs += this.settings.incrementSeconds * 1000;
      } else {
        this.whiteMs += this.settings.incrementSeconds * 1000;
      }
      this.cb.onGameTimerTick(this.whiteMs, this.blackMs);

      const newFen = this.game.fen();
      this.cachedDests = getLegalDests(this.game);

      this.cb.onStockfishMove({ from: move.from, to: move.to, fen: newFen, dests: this.cachedDests });

      if (this._checkGameOver()) return;

      this._save();
      this.transitionTimer = setTimeout(() => this._enterPhaseA(), 500);
    } catch (e) {
      console.error('Stockfish error:', e);
      this.cb.onStatusMessage('Ошибка движка', 'error');
    } finally {
      this.isBusy = false;
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
      const loser = this.game.turn();
      const winner = loser === 'w' ? 'black' : 'white';
      this._endGame('checkmate', winner);
      return true;
    }
    if (this.game.isStalemate() || this.game.isDraw()) {
      this._endGame('draw', 'draw');
      return true;
    }
    return false;
  }

  private _endGame(reason: GameOverResult['reason'], winner?: 'white' | 'black' | 'draw'): void {
    this.isGameOver = true;
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

    const botConfig = getBotLevelConfig(this.settings.stockfishLevel);
    const botLabel = `Stockfish (${botConfig.name} - ~${botConfig.approxElo})`;

    const whitePlayer = this.studentColor === 'w'
      ? (this.settings.studentName || 'Ученик')
      : botLabel;

    const blackPlayer = this.studentColor === 'b'
      ? (this.settings.studentName || 'Ученик')
      : botLabel;

    try {
      this.game.header(
        'Event', 'Chess Game Vision Training',
        'Site', 'Chess Game Vision',
        'Date', dateStr,
        'Round', '1',
        'White', whitePlayer,
        'Black', blackPlayer,
        'Result', resultStr
      );
    } catch {
      // ignore header formatting errors
    }

    this.cb.onGameOver({
      reason,
      winner,
      studentColor: this.studentColor,
      stats: this.statsCollector.getStats(),
      pgn: this.game.pgn()
    });
  }

  private _emptyFound(): FoundSet {
    return { myChecks: new Set(), myCaptures: new Set(), oppChecks: new Set(), oppCaptures: new Set() };
  }

  private _save(): void {
    if (this.isGameOver) return;
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      persistence.saveGameState({
        fen: this.game.fen(),
        pgn: this.game.pgn(),
        phase: this.phase,
        studentColor: this.studentColor,
        searchTimerRemaining: this.searchRemaining,
        whiteTimeRemaining: this.whiteMs,
        blackTimeRemaining: this.blackMs,
        stats: this.statsCollector.getStats(),
        moveNumber: this.game.moveNumber(),
      });
    }, 200);
  }
}
