/**
 * ThreatAnalyzer — isolated chess threat detection module.
 * No UI dependencies. Pure logic using chess.js.
 */

import { Chess } from 'chess.js';
import type { ThreatMove, ThreatResult, PlayerColor } from '../types/index.js';

export interface ThreatAnalysisFullResult extends ThreatResult {
  dests: Map<string, string[]>;
}

export function getMoveKey(from: string, to: string): string {
  return `${from}-${to}`;
}

/**
 * Get legal destinations for current side to move (fast, no threat parsing).
 */
export function getLegalDests(game: Chess): Map<string, string[]> {
  const dests = new Map<string, string[]>();
  try {
    const moves = game.moves({ verbose: true });
    for (const m of moves) {
      const list = dests.get(m.from);
      if (list) {
        list.push(m.to);
      } else {
        dests.set(m.from, [m.to]);
      }
    }
  } catch { /* ignore */ }
  return dests;
}

/**
 * Analyze checks and captures for both sides from a given FEN in a single pass,
 * including legal destinations for board interaction.
 */
export function analyzeThreatsFull(fen: string, studentColor: PlayerColor = 'w'): ThreatAnalysisFullResult {
  const oppColor: PlayerColor = studentColor === 'w' ? 'b' : 'w';
  const destsMap = new Map<string, Set<string>>();

  const myMoves = getMovesForColor(fen, studentColor, destsMap);
  const oppMoves = getMovesForColor(fen, oppColor, destsMap);

  const dests = new Map<string, string[]>();
  for (const [from, toSet] of destsMap) {
    dests.set(from, Array.from(toSet));
  }

  return {
    myChecks:    myMoves.checks,
    myCaptures:  myMoves.captures,
    oppChecks:   oppMoves.checks,
    oppCaptures: oppMoves.captures,
    myChecksMap:    buildMap(myMoves.checks),
    myCapturesMap:  buildMap(myMoves.captures),
    oppChecksMap:   buildMap(oppMoves.checks),
    oppCapturesMap: buildMap(oppMoves.captures),
    dests,
  };
}

interface ColorMoves {
  checks: ThreatMove[];
  captures: ThreatMove[];
}

/**
 * Get all checks and captures for a given color by temporarily
 * flipping the FEN turn indicator when analyzing opponent.
 */
function getMovesForColor(
  fen: string,
  color: PlayerColor,
  destsMap?: Map<string, Set<string>>
): ColorMoves {
  let origTurn = 'w';
  let origInCheck = false;
  let origGame: Chess | null = null;

  try {
    origGame = new Chess(fen);
    origTurn = origGame.turn();
    origInCheck = origGame.inCheck();
  } catch {
    // ignore
  }

  const tokens = fen.split(' ');
  tokens[1] = color;
  if (color !== origTurn) {
    tokens[3] = '-'; // clear en-passant when analyzing off-turn side to avoid illegal position
  }

  const checks: ThreatMove[] = [];
  const captures: ThreatMove[] = [];
  const seen = new Set<string>();

  try {
    const game = (color === origTurn && origGame) ? origGame : new Chess(tokens.join(' '));
    const moves = game.moves({ verbose: true });

    for (const m of moves) {
      if (destsMap) {
        let set = destsMap.get(m.from);
        if (!set) {
          set = new Set<string>();
          destsMap.set(m.from, set);
        }
        set.add(m.to);
      }

      const key = getMoveKey(m.from, m.to);
      if (seen.has(key)) continue;
      seen.add(key);

      const threat: ThreatMove = {
        from:  m.from,
        to:    m.to,
        san:   m.san,
        piece: m.piece,
      };

      // Capture: flag 'c' (capture) or 'e' (en passant) or captured property
      // Exclude king captures — in real chess the king can never be captured,
      // only checked. When FEN turn is flipped for analysis, chess.js may
      // generate king captures which are not real threats.
      if ((m.flags.includes('c') || m.flags.includes('e') || m.captured) && m.captured !== 'k') {
        captures.push(threat);
      }

      // Check: SAN already denotes check/mate with '+' or '#'
      if ((color === origTurn || !origInCheck) && (m.san.includes('+') || m.san.includes('#'))) {
        checks.push(threat);
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


