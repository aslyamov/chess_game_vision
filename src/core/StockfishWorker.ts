/**
 * StockfishWorker — Promise-based wrapper over Fairy-Stockfish WASM.
 * Uses the fairy-stockfish-nnue.wasm package which provides Stockfish()
 * factory with addMessageListener/postMessage API (not plain Worker).
 * Supports negative Skill Level values (Lichess-style).
 */

import type { GameSettings, StockfishResult } from '../types/index.js';
import { getBotLevelConfig } from '../types/index.js';

// Fairy-Stockfish instance interface (from the WASM module)
interface FairyStockfishInstance {
  addMessageListener(fn: (line: string) => void): void;
  removeMessageListener(fn: (line: string) => void): void;
  postMessage(cmd: string): void;
  terminate(): void;
}

// The Stockfish() factory function type
type StockfishFactory = (opts?: Record<string, unknown>) => Promise<FairyStockfishInstance>;

declare global {
  // eslint-disable-next-line no-var
  var Stockfish: StockfishFactory | undefined;
}

export class StockfishEngine {
  private sf: FairyStockfishInstance | null = null;
  private ready = false;
  private pendingResolve: ((r: StockfishResult) => void) | null = null;
  private pendingReject: ((e: Error) => void) | null = null;
  private pendingTimeout: ReturnType<typeof setTimeout> | null = null;
  private currentLevel = 3;
  private lastScoreCp = 0;
  private initPromise: Promise<void>;

  constructor() {
    this.initPromise = this._init();
  }

  private async _init(): Promise<void> {
    const base = (import.meta.env.BASE_URL || '/').replace(/\/$/, '');

    try {
      // Load Fairy-Stockfish script via <script> tag so it registers
      // the global Stockfish factory (required for pthread worker spawning).
      await this._loadScript(`${base}/stockfish/fairy-stockfish.js`);

      const factory = globalThis.Stockfish;
      if (!factory) {
        throw new Error('Stockfish factory not found after script load');
      }

      this.sf = await factory();

      this.sf.addMessageListener((line: string) => this._onMessage(line));

      // Send UCI init
      this.sf.postMessage('uci');
    } catch (err) {
      console.error('Fairy-Stockfish failed to initialize:', err);
    }
  }

  /**
   * Load a script via <script> tag and wait for it to finish.
   */
  private _loadScript(url: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = url;
      script.onload = () => resolve();
      script.onerror = () => reject(new Error(`Failed to load script: ${url}`));
      document.head.appendChild(script);
    });
  }

  private _onMessage(data: string): void {
    if (data === 'uciok') {
      this.ready = true;
      this._applyLevel(this.currentLevel);
      this.sf?.postMessage('isready');
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

  private _applyLevel(level: number): void {
    const cfg = getBotLevelConfig(level);
    // Fairy-Stockfish supports negative Skill Level (unlike standard Stockfish).
    // This matches Lichess fishnet configuration exactly.
    this.sf?.postMessage('setoption name UCI_LimitStrength value false');
    this.sf?.postMessage(`setoption name Skill Level value ${cfg.skillLevel}`);
  }

  private setLevel(level: number): void {
    this.currentLevel = level;
    if (this.ready) {
      this._applyLevel(level);
    }
  }

  applySettings(settings: GameSettings): void {
    this.setLevel(settings.stockfishLevel);
  }

  /**
   * Request bot move using configured level (skill level, depth, movetime).
   */
  getBotMove(fen: string): Promise<StockfishResult> {
    const cfg = getBotLevelConfig(this.currentLevel);
    return this.searchMove(fen, { depth: cfg.depth, movetimeMs: cfg.movetimeMs });
  }

  /**
   * Request evaluation for player accuracy analysis.
   */
  getEvaluation(fen: string, thinkMs = 250): Promise<StockfishResult> {
    return this.searchMove(fen, { movetimeMs: thinkMs, depth: 10 });
  }

  /**
   * General search command.
   */
  searchMove(fen: string, options?: { depth?: number; movetimeMs?: number }): Promise<StockfishResult> {
    return new Promise((resolve, reject) => {
      // Wait for init to complete
      this.initPromise.then(() => {
        if (!this.sf) {
          reject(new Error('Fairy-Stockfish not available'));
          return;
        }

        // Reject previous pending request if new one arrives
        if (this.pendingReject) {
          this._cleanupPending(new Error('Cancelled by subsequent request'));
        }

        this.pendingResolve = resolve;
        this.pendingReject = reject;
        this.lastScoreCp = 0;

        const movetime = options?.movetimeMs ?? 200;
        const depth = options?.depth;

        this.pendingTimeout = setTimeout(() => {
          this._cleanupPending(new Error('Stockfish evaluation timed out'));
        }, Math.max(movetime, 500) + 6000);

        this.sf!.postMessage(`position fen ${fen}`);
        if (depth !== undefined && depth > 0) {
          this.sf!.postMessage(`go depth ${depth} movetime ${movetime}`);
        } else {
          this.sf!.postMessage(`go movetime ${movetime}`);
        }
      }).catch(reject);
    });
  }

  destroy(): void {
    this._cleanupPending(new Error('Stockfish destroyed'));
    this.sf?.terminate();
    this.sf = null;
    this.ready = false;
  }
}
