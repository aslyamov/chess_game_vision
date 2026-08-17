/**
 * BoardRenderer — Chessground wrapper.
 * Handles board initialization, position updates, movable configurations, and shapes.
 */

import type { DrawShape, CGColor } from '../types/index.js';
import { getAllDests } from '../core/ThreatAnalyzer.js';

interface BoardConfig {
  onMove: (orig: string, dest: string) => void;
}

export class BoardRenderer {
  private el: HTMLElement;
  private ground: any = null;
  private Chessground: any;
  private persistentShapes: DrawShape[] = [];
  private onMoveCallback: (orig: string, dest: string) => void = () => {};

  constructor(el: HTMLElement, ChessgroundLib: any) {
    this.el = el;
    this.Chessground = ChessgroundLib;
  }

  initialize(config: BoardConfig): void {
    this.onMoveCallback = config.onMove;
    if (this.ground) {
      this.ground.destroy();
      this.ground = null;
    }
    this.el.innerHTML = '';
    this.persistentShapes = [];

    // ALWAYS initialize without viewOnly so Chessground attaches all event listeners
    this.ground = this.Chessground(this.el, {
      fen: 'start',
      orientation: 'white',
      coordinates: true,
      movable: {
        color: 'both',
        free: false,
        dests: getAllDests('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1'),
        events: {
          after: (orig: string, dest: string) => {
            this.onMoveCallback(orig, dest);
          },
        },
      },
      drawable: {
        enabled: true,
        visible: true,
        autoShapes: [],
      },
    });

    setTimeout(() => {
      this.ground?.redrawAll?.();
    }, 50);
  }

  // ── Position & Mode Setup ──────────────────────────────────

  /**
   * Set board for Phase A (threat search):
   * movable color = 'both' so user can drag any piece to test threats.
   */
  setSearchMode(fen: string, dests: Map<string, string[]>): void {
    if (!this.ground) return;
    this.ground.set({
      fen,
      turnColor: 'white',
      movable: {
        color: 'both' as CGColor,
        free: false,
        dests,
        events: {
          after: (orig: string, dest: string) => {
            this.onMoveCallback(orig, dest);
          },
        },
      },
      drawable: {
        autoShapes: this.persistentShapes,
      },
    });
  }

  /**
   * Set board for Phase B (player move):
   * movable color = 'white', turnColor = 'white'.
   */
  setMoveMode(fen: string, dests: Map<string, string[]>): void {
    if (!this.ground) return;
    this.ground.set({
      fen,
      turnColor: 'white',
      movable: {
        color: 'white' as CGColor,
        free: false,
        dests,
        events: {
          after: (orig: string, dest: string) => {
            this.onMoveCallback(orig, dest);
          },
        },
      },
      drawable: {
        autoShapes: this.persistentShapes,
      },
    });
  }

  /**
   * Visually reset board after threat attempt in Phase A
   */
  undoVisual(fen: string, dests: Map<string, string[]>, isSearchMode = true): void {
    if (!this.ground) return;
    const color: CGColor = isSearchMode ? 'both' : 'white';
    this.ground.set({
      fen,
      turnColor: 'white',
      movable: {
        color,
        free: false,
        dests,
        events: {
          after: (orig: string, dest: string) => {
            this.onMoveCallback(orig, dest);
          },
        },
      },
      drawable: {
        shapes: [],
        autoShapes: this.persistentShapes,
      },
    });
  }

  setFen(fen: string): void {
    if (!this.ground) return;
    this.ground.set({ fen });
  }

  setOrientation(o: 'white' | 'black'): void {
    this.ground?.set({ orientation: o });
  }

  // ── Shapes & Highlights ────────────────────────────────────

  addPersistentShape(shape: DrawShape): void {
    this.persistentShapes.push(shape);
    this._syncShapes();
  }

  clearPersistentShapes(): void {
    this.persistentShapes = [];
    this._syncShapes();
  }

  flashShape(shape: DrawShape, durationMs = 500): void {
    if (!this.ground) return;
    this.ground.set({
      drawable: {
        autoShapes: [...this.persistentShapes, shape],
      },
    });
    setTimeout(() => this._syncShapes(), durationMs);
  }

  highlightMove(orig: string, dest: string, brush: string): void {
    this.addPersistentShape({ orig, dest, brush });
  }

  highlightSquare(sq: string, brush: string): void {
    this.addPersistentShape({ orig: sq, brush });
  }

  private _syncShapes(): void {
    if (!this.ground) return;
    this.ground.set({
      drawable: {
        autoShapes: this.persistentShapes,
        visible: true,
      },
    });
  }

  destroy(): void {
    if (this.ground) {
      this.ground.destroy();
      this.ground = null;
    }
    this.persistentShapes = [];
  }
}
