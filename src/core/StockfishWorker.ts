/**
 * StockfishWorker — Promise-based wrapper over stockfish WebWorker.
 * Handles initialization, skill level, move requests, and evaluation.
 */

import type { GameSettings, StockfishResult } from '../types/index.js';

export class StockfishEngine {
  private worker: Worker | null = null;
  private ready = false;
  private pendingResolve: ((r: StockfishResult) => void) | null = null;
  private pendingReject: ((e: Error) => void) | null = null;
  private currentElo = 1500;
  private lastScoreCp = 0;

  constructor() {
    this._init();
  }

  private _init(): void {
    const base = (import.meta.env.BASE_URL || '/').replace(/\/$/, '');
    const candidatePaths = [
      `${base}/stockfish/stockfish-18-lite-single.js`,
      `${base}/stockfish/stockfish-18-lite.js`,
      `${base}/stockfish/stockfish-18-asm.js`,
    ];

    for (const p of candidatePaths) {
      try {
        this.worker = new Worker(p);
        break;
      } catch {
        // try next
      }
    }

    if (!this.worker) {
      console.error('Stockfish worker failed to initialize');
      return;
    }

    this.worker.onmessage = (e: MessageEvent) => this._onMessage(e.data);
    this.worker.onerror = (e: ErrorEvent) => {
      console.error('Stockfish error:', e);
      this.pendingReject?.(new Error(e.message));
      this.pendingReject = null;
      this.pendingResolve = null;
    };

    this._send('uci');
  }

  private _send(cmd: string): void {
    this.worker?.postMessage(cmd);
  }

  private _onMessage(data: string): void {
    if (data === 'uciok') {
      this.ready = true;
      this._applyElo(this.currentElo);
      this._send('isready');
      return;
    }

    if (data === 'readyok') {
      return;
    }

    // Parse score from info lines
    if (data.startsWith('info') && data.includes('score')) {
      const cpMatch = data.match(/score cp (-?\d+)/);
      if (cpMatch) {
        this.lastScoreCp = parseInt(cpMatch[1], 10);
      } else {
        const mateMatch = data.match(/score mate (-?\d+)/);
        if (mateMatch) {
          const mateIn = parseInt(mateMatch[1], 10);
          this.lastScoreCp = mateIn > 0 ? 10000 : -10000;
        }
      }
    }

    // Parse bestmove response
    if (data.startsWith('bestmove')) {
      const parts = data.split(' ');
      const bestMove = parts[1] || '';

      if (this.pendingResolve) {
        this.pendingResolve({ bestMove, score: this.lastScoreCp });
        this.pendingResolve = null;
        this.pendingReject = null;
      }
    }
  }

  private _applyElo(elo: number): void {
    this._send('setoption name UCI_LimitStrength value true');
    this._send(`setoption name UCI_Elo value ${elo}`);
  }

  setElo(elo: number): void {
    this.currentElo = elo;
    if (this.ready) {
      this._applyElo(elo);
    }
  }

  applySettings(settings: GameSettings): void {
    this.setElo(settings.stockfishElo);
  }

  /**
   * Ask Stockfish for best move and evaluation in given position.
   * Returns a Promise that resolves with bestMove and score (cp).
   */
  getBestMove(fen: string, thinkMs = 500): Promise<StockfishResult> {
    return new Promise((resolve, reject) => {
      if (!this.worker) {
        reject(new Error('Stockfish not available'));
        return;
      }

      this.pendingResolve = resolve;
      this.pendingReject = reject;
      this.lastScoreCp = 0;

      this._send(`position fen ${fen}`);
      this._send(`go movetime ${thinkMs}`);
    });
  }

  /**
   * Evaluate a specific player move against Stockfish's best move.
   * Returns { bestMove, isBestMove }.
   */
  async evaluatePlayerMove(fen: string, _playerMove: string): Promise<{ bestMove: string; isBestMove: boolean }> {
    try {
      const result = await this.getBestMove(fen, 300);
      // Convert UCI move format: "e2e4" → "e2-e4" or check exact
      const stockfishMove = result.bestMove.replace(/(..)(..).*/, '$1$2'); // strip promotion
      const playerMoveNorm = _playerMove.replace('-', '').substring(0, 4);
      const isBestMove = stockfishMove === playerMoveNorm;
      return { bestMove: result.bestMove, isBestMove };
    } catch {
      return { bestMove: '', isBestMove: false };
    }
  }

  destroy(): void {
    this.worker?.terminate();
    this.worker = null;
    this.pendingResolve = null;
    this.pendingReject = null;
  }
}
