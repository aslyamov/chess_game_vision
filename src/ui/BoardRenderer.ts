/**
 * BoardRenderer — Chessground wrapper.
 * Handles board initialization, position updates, movable configurations, and shapes.
 */

import type { DrawShape, CGColor } from '../types/index.js';
import { Chess } from 'chess.js';
import { getLegalDests } from '../core/ThreatAnalyzer.js';

interface BoardConfig {
  orientation?: 'white' | 'black';
  onMove: (orig: string, dest: string) => void;
}

export class BoardRenderer {
  private el: HTMLElement;
  private ground: any = null;
  private Chessground: any;
  private orientation: 'white' | 'black' = 'white';
  private persistentShapes: DrawShape[] = [];
  private onMoveCallback: (orig: string, dest: string) => void = () => {};
  private flashTimeout: ReturnType<typeof setTimeout> | null = null;

  constructor(el: HTMLElement, ChessgroundLib: any) {
    this.el = el;
    this.Chessground = ChessgroundLib;
  }

  initialize(config: BoardConfig): void {
    this.onMoveCallback = config.onMove;
    this.orientation = config.orientation ?? 'white';
    this.destroy();
    this.el.innerHTML = '';
    this.persistentShapes = [];

    // ALWAYS initialize without viewOnly so Chessground attaches all event listeners
    this.ground = this.Chessground(this.el, {
      fen: 'start',
      orientation: this.orientation,
      coordinates: true,
      movable: {
        color: 'both',
        free: false,
        dests: getLegalDests(new Chess()),
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

  setOrientation(o: 'white' | 'black'): void {
    this.orientation = o;
    this.ground?.set({ orientation: o });
  }

  // ── Position & Mode Setup ──────────────────────────────────

  private _setBoardMode(fen: string, dests: Map<string, string[]>, color: CGColor, extraShapes: DrawShape[] = []): void {
    if (!this.ground) return;
    this.ground.set({
      fen,
      turnColor: this.orientation,
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
        shapes: extraShapes,
        autoShapes: this.persistentShapes,
      },
    });
  }

  /**
   * Set board for Phase A (threat search):
   * movable color = 'both' so user can drag any piece to test threats.
   */
  setSearchMode(fen: string, dests: Map<string, string[]>): void {
    this._setBoardMode(fen, dests, 'both');
  }

  /**
   * Set board for Phase B (player move):
   * movable color matches player orientation.
   */
  setMoveMode(fen: string, dests: Map<string, string[]>): void {
    this._setBoardMode(fen, dests, this.orientation);
  }

  /**
   * Visually reset board after threat attempt in Phase A
   */
  undoVisual(fen: string, dests: Map<string, string[]>, isSearchMode = true): void {
    this._setBoardMode(fen, dests, isSearchMode ? 'both' : this.orientation);
  }

  setFen(fen: string): void {
    if (!this.ground) return;
    this.ground.set({ fen });
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
    if (this.flashTimeout) clearTimeout(this.flashTimeout);

    this.ground.set({
      drawable: {
        autoShapes: [...this.persistentShapes, shape],
      },
    });
    this.flashTimeout = setTimeout(() => {
      this._syncShapes();
      this.flashTimeout = null;
    }, durationMs);
  }

  highlightMove(orig: string, dest: string, brush: string): void {
    this.addPersistentShape({ orig, dest, brush });
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
    if (this.flashTimeout) {
      clearTimeout(this.flashTimeout);
      this.flashTimeout = null;
    }
    if (this.ground) {
      this.ground.destroy();
      this.ground = null;
    }
    this.persistentShapes = [];
  }
}
