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
  private pendingTimeout: ReturnType<typeof setTimeout> | null = null;
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
      this._cleanupPending(new Error(e.message || 'Stockfish worker error'));
    };

    this._send('uci');
  }

  private _send(cmd: string): void {
    this.worker?.postMessage(cmd);
  }

  private _cleanupPending(err?: Error, result?: StockfishResult): void {
    if (this.pendingTimeout) {
      clearTimeout(this.pendingTimeout);
      this.pendingTimeout = null;
    }
    if (result && this.pendingResolve) {
      this.pendingResolve(result);
    } else if (err && this.pendingReject) {
      this.pendingReject(err);
    }
    this.pendingResolve = null;
    this.pendingReject = null;
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
          this.lastScoreCp = mateIn > 0
            ? (10000 - Math.min(100, Math.abs(mateIn) * 10))
            : (-10000 + Math.min(100, Math.abs(mateIn) * 10));
        }
      }
    }

    // Parse bestmove response
    if (data.startsWith('bestmove')) {
      const parts = data.split(' ');
      const bestMove = parts[1] || '';
      this._cleanupPending(undefined, { bestMove, score: this.lastScoreCp });
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

      // Reject previous pending request if new one arrives
      if (this.pendingReject) {
        this._cleanupPending(new Error('Cancelled by subsequent request'));
      }

      this.pendingResolve = resolve;
      this.pendingReject = reject;
      this.lastScoreCp = 0;

      this.pendingTimeout = setTimeout(() => {
        this._cleanupPending(new Error('Stockfish evaluation timed out'));
      }, thinkMs + 6000);

      this._send(`position fen ${fen}`);
      this._send(`go movetime ${thinkMs}`);
    });
  }

  destroy(): void {
    this._cleanupPending(new Error('Stockfish destroyed'));
    this.worker?.terminate();
    this.worker = null;
  }
}
