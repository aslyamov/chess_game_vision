/**
 * ThreatAnalyzer — isolated chess threat detection module.
 * No UI dependencies. Pure logic using chess.js.
 */

import { Chess } from 'chess.js';
import type { ThreatMove, ThreatResult, PlayerColor } from '../types/index.js';

export function getMoveKey(from: string, to: string): string {
  return `${from}-${to}`;
}

/**
 * Analyze checks and captures for both sides from a given FEN.
 * @param fen - position to analyze
 * @param studentColor - which color the student plays ('w' or 'b')
 */
export function analyzeThreatsFull(fen: string, studentColor: PlayerColor = 'w'): ThreatResult {
  const oppColor: PlayerColor = studentColor === 'w' ? 'b' : 'w';

  const myMoves = getMovesForColor(fen, studentColor);
  const oppMoves = getMovesForColor(fen, oppColor);

  return {
    myChecks:    myMoves.checks,
    myCaptures:  myMoves.captures,
    oppChecks:   oppMoves.checks,
    oppCaptures: oppMoves.captures,
    myChecksMap:    buildMap(myMoves.checks),
    myCapturesMap:  buildMap(myMoves.captures),
    oppChecksMap:   buildMap(oppMoves.checks),
    oppCapturesMap: buildMap(oppMoves.captures),
  };
}

interface ColorMoves {
  checks: ThreatMove[];
  captures: ThreatMove[];
}

/**
 * Get all checks and captures for a given color by temporarily
 * flipping the FEN turn indicator.
 */
function getMovesForColor(fen: string, color: PlayerColor): ColorMoves {
  let origTurn = 'w';
  let origInCheck = false;
  try {
    const origGame = new Chess(fen);
    origTurn = origGame.turn();
    origInCheck = origGame.inCheck();
  } catch {
    // ignore
  }

  const tokens = fen.split(' ');
  tokens[1] = color;
  tokens[3] = '-'; // clear en-passant to avoid illegal positions

  const checks: ThreatMove[] = [];
  const captures: ThreatMove[] = [];
  const seen = new Set<string>();

  try {
    const game = new Chess(tokens.join(' '));
    const moves = game.moves({ verbose: true }) as any[];

    for (const m of moves) {
      const key = getMoveKey(m.from, m.to);
      if (seen.has(key)) continue;
      seen.add(key);

      const threat: ThreatMove = {
        from:  m.from,
        to:    m.to,
        san:   m.san,
        piece: m.piece,
      };

      // Capture: flag 'c' (capture) or 'e' (en passant)
      if (m.flags.includes('c') || m.flags.includes('e')) {
        captures.push(threat);
      }

      // Check: only valid if opponent was not already in check before this move
      if (color === origTurn || !origInCheck) {
        try {
          game.move(m);
          if (game.inCheck()) {
            checks.push(threat);
          }
          game.undo();
        } catch {
          // ignore
        }
      }
    }
  } catch {
    // invalid position — return empty
  }

  return { checks, captures };
}

function buildMap(moves: ThreatMove[]): Map<string, ThreatMove> {
  const map = new Map<string, ThreatMove>();
  for (const m of moves) {
    map.set(getMoveKey(m.from, m.to), m);
  }
  return map;
}

/**
 * Get all legal destinations for both colors (used by chessground dests).
 */
export function getAllDests(fen: string): Map<string, string[]> {
  const dests = new Map<string, string[]>();

  const addDestsForColor = (f: string) => {
    try {
      const g = new Chess(f);
      const moves = g.moves({ verbose: true }) as any[];
      for (const m of moves) {
        const existing = dests.get(m.from) ?? [];
        if (!existing.includes(m.to)) existing.push(m.to);
        dests.set(m.from, existing);
      }
    } catch { /* ignore */ }
  };

  addDestsForColor(fen);

  // Also add opponent moves so chessground can show them (for visual only)
  const tokens = fen.split(' ');
  tokens[1] = tokens[1] === 'w' ? 'b' : 'w';
  tokens[3] = '-';
  addDestsForColor(tokens.join(' '));

  return dests;
}

/** Format seconds as MM:SS */
export function formatTime(ms: number): string {
  const secs = Math.max(0, Math.ceil(ms / 1000));
  const m = Math.floor(secs / 60).toString().padStart(2, '0');
  const s = (secs % 60).toString().padStart(2, '0');
  return `${m}:${s}`;
}
