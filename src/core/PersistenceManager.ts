/**
 * PersistenceManager — save/restore game state and settings via localStorage.
 */

import type { GameState, GameSettings } from '../types/index.js';
import { DEFAULT_SETTINGS } from '../types/index.js';

const KEYS = {
  SETTINGS: 'cgv_settings',
  GAME_STATE: 'cgv_game_state',
} as const;

export class PersistenceManager {
  // ── Settings ────────────────────────────────────────────────

  saveSettings(settings: GameSettings): void {
    try {
      localStorage.setItem(KEYS.SETTINGS, JSON.stringify(settings));
    } catch { /* quota exceeded — ignore */ }
  }

  loadSettings(): GameSettings {
    try {
      const raw = localStorage.getItem(KEYS.SETTINGS);
      if (raw) {
        return { ...DEFAULT_SETTINGS, ...JSON.parse(raw) };
      }
    } catch { /* corrupt data */ }
    return { ...DEFAULT_SETTINGS };
  }

  // ── Game State ───────────────────────────────────────────────

  saveGameState(state: GameState): void {
    try {
      localStorage.setItem(KEYS.GAME_STATE, JSON.stringify(state));
    } catch { /* ignore */ }
  }

  loadGameState(): GameState | null {
    try {
      const raw = localStorage.getItem(KEYS.GAME_STATE);
      if (raw) return JSON.parse(raw) as GameState;
    } catch { /* corrupt */ }
    return null;
  }

  hasUnfinishedGame(): boolean {
    return !!localStorage.getItem(KEYS.GAME_STATE);
  }

  clearGameState(): void {
    localStorage.removeItem(KEYS.GAME_STATE);
  }
}

export const persistence = new PersistenceManager();
