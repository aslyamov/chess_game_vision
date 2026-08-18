/**
 * PersistenceManager — save/restore game state and settings via localStorage.
 */

import type { GameState, GameSettings } from '../types/index.js';
import { DEFAULT_SETTINGS, DEFAULT_FORMSPREE_ENDPOINT } from '../types/index.js';

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
        const loaded = JSON.parse(raw);
        let level = DEFAULT_SETTINGS.stockfishLevel;
        if (typeof loaded.stockfishLevel === 'number') {
          level = Math.max(1, Math.min(8, Math.round(loaded.stockfishLevel)));
        } else if (typeof loaded.stockfishElo === 'number') {
          level = Math.max(1, Math.min(8, Math.round((loaded.stockfishElo - 500) / 300)));
        }

        return {
          ...DEFAULT_SETTINGS,
          ...loaded,
          stockfishLevel: level,
          formspreeEndpoint: loaded.formspreeEndpoint || DEFAULT_FORMSPREE_ENDPOINT,
        };
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
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed.fen === 'string' && typeof parsed.pgn === 'string') {
          return parsed as GameState;
        }
      }
    } catch { /* corrupt */ }
    return null;
  }

  hasUnfinishedGame(): boolean {
    try {
      const raw = localStorage.getItem(KEYS.GAME_STATE);
      if (!raw) return false;
      const parsed = JSON.parse(raw);
      return Boolean(parsed && typeof parsed.fen === 'string');
    } catch {
      return false;
    }
  }

  clearGameState(): void {
    try {
      localStorage.removeItem(KEYS.GAME_STATE);
    } catch { /* ignore */ }
  }
}

export const persistence = new PersistenceManager();
