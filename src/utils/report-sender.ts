/**
 * report-sender.ts — send game report to coach via Formspree.
 */

import type { GameStats, GameSettings, MissedThreatsMap, PlayerColor } from '../types/index.js';
import { DEFAULT_FORMSPREE_ENDPOINT, getBotLevelConfig } from '../types/index.js';
import { pct } from './format.js';

export interface ReportData {
  settings: GameSettings;
  stats: GameStats;
  pgn: string;
  date: string;
  missedThreats?: MissedThreatsMap;
  studentColor?: PlayerColor;
}

/**
 * Build PGN with RAV subvariations for missed threats.
 *
 * For missed 'my' threats (student alternatives): inserted as `(N. Move {comment})`
 * For missed 'opp' threats (opponent threats):    inserted as `(N. -- N... Move {comment})`
 *   where `--` is a null/pass move (ChessBase convention).
 *
 * @param basePgn  - raw PGN from chess.js (headers + movetext)
 * @param missed   - map of ply→MissedThreat[] from GameLoop
 */
function buildPgnWithVariations(basePgn: string, missed: MissedThreatsMap): string {
  if (missed.size === 0) return basePgn;

  // Split PGN into headers block and movetext
  const headerEndIdx = basePgn.lastIndexOf(']\n');
  let headers = '';
  let movetext = basePgn;
  if (headerEndIdx >= 0) {
    headers = basePgn.substring(0, headerEndIdx + 2);
    movetext = basePgn.substring(headerEndIdx + 2).trim();
  }

  // Clean movetext of existing comments before tokenizing
  const cleanMovetext = movetext.replace(/\{[^}]*\}/g, '').trim();
  const tokens = cleanMovetext.match(/\S+/g) || [];

  // Build an ordered list of SAN moves (half-moves) from tokens
  const sanMoves: string[] = [];
  const resultTokens = new Set(['1-0', '0-1', '1/2-1/2', '*']);
  for (const tok of tokens) {
    if (tok.match(/^\d+\.+$/)) continue;  // skip move numbers like "1." or "1..."
    if (resultTokens.has(tok)) continue;    // skip result
    sanMoves.push(tok);
  }

  // Find result token
  let result = '*';
  for (let i = tokens.length - 1; i >= 0; i--) {
    if (resultTokens.has(tokens[i])) {
      result = tokens[i];
      break;
    }
  }

  // Rebuild movetext with subvariations
  const parts: string[] = [];

  for (let ply = 0; ply < sanMoves.length; ply++) {
    const fullMoveNum = Math.floor(ply / 2) + 1;
    const isWhiteMove = ply % 2 === 0;
    const missedAtPly = missed.get(ply);
    const hasVariations = Boolean(missedAtPly && missedAtPly.length > 0);

    // Insert subvariations for missed threats BEFORE this move
    // (these are alternatives/threats for the position before this move was played)
    if (hasVariations && missedAtPly) {
      const myMissed = missedAtPly.filter(m => m.side === 'my');
      const oppMissed = missedAtPly.filter(m => m.side === 'opp');

      // Student's own missed threats — direct alternatives at this move number
      for (const m of myMissed) {
        const label = m.category === 'check' ? 'шах не найден' : 'взятие не найдено';
        if (isWhiteMove) {
          parts.push(`(${fullMoveNum}. ${m.san} {${label}})`);
        } else {
          parts.push(`(${fullMoveNum}... ${m.san} {${label}})`);
        }
      }

      // Opponent's missed threats — null move for student, then opponent's move
      for (const m of oppMissed) {
        const label = m.category === 'check' ? 'шах соперника не найден' : 'взятие соперника не найдено';
        if (isWhiteMove) {
          // Student is white, passes (--), then black threatens
          parts.push(`(${fullMoveNum}. -- ${fullMoveNum}... ${m.san} {${label}})`);
        } else {
          // Student is black, passes (--), then white threatens
          const nextMoveNum = fullMoveNum + 1;
          parts.push(`(${fullMoveNum}... -- ${nextMoveNum}. ${m.san} {${label}})`);
        }
      }
    }

    // Add move number prefix
    if (isWhiteMove) {
      parts.push(`${fullMoveNum}.`);
    } else if (hasVariations) {
      // If variations preceded Black's move, prefix with 'N...' for valid standard PGN
      parts.push(`${fullMoveNum}...`);
    }

    // Add the actual move
    parts.push(sanMoves[ply]);
  }

  // Append result
  parts.push(result);

  const annotatedMovetext = parts.join(' ');
  return headers ? `${headers}\n\n${annotatedMovetext}` : annotatedMovetext;
}

function buildEmailBody(data: ReportData): string {
  const { settings, stats, date } = data;
  const botConfig = getBotLevelConfig(settings.stockfishLevel);
  const avgSearch = stats.searchPhaseCount > 0
    ? (stats.totalSearchTimeMs / stats.searchPhaseCount / 1000).toFixed(1)
    : '—';
  const totalSearch = (stats.totalSearchTimeMs / 1000).toFixed(0);
  const accuracy = stats.totalMoves > 0
    ? `${(stats.accuracySum / stats.totalMoves).toFixed(1)}%`
    : '—';

  // Build PGN with missed-threat subvariations when available
  const pgn = (data.missedThreats && data.missedThreats.size > 0)
    ? buildPgnWithVariations(data.pgn, data.missedThreats)
    : data.pgn;

  return `
=== ОТЧЕТ ТРЕНАЖЁРА ===
Ученик: ${settings.studentName || '(не указан)'}
Дата: ${date}
Сила Stockfish: ${botConfig.name} (~${botConfig.approxElo})

--- ПОИСК ЗА СЕБЯ ---
Мои шахи:     ${pct(stats.myChecks.found,    stats.myChecks.total)}
Мои взятия:   ${pct(stats.myCaptures.found,  stats.myCaptures.total)}

--- ПОИСК ЗА СОПЕРНИКА ---
Шахи соперника:   ${pct(stats.oppChecks.found,    stats.oppChecks.total)}
Взятия соперника: ${pct(stats.oppCaptures.found,  stats.oppCaptures.total)}

--- ТОЧНОСТЬ ИГРЫ (Lichess) ---
Точность: ${accuracy} (лучших ходов: ${stats.bestMoveMatches}/${stats.totalMoves})

--- ВРЕМЯ ---
Суммарное время поиска: ${totalSearch} сек
Среднее время поиска за ход: ${avgSearch} сек

--- PGN ---
${pgn}
`.trim();
}

export async function sendReport(data: ReportData): Promise<void> {
  const endpoint = data.settings.formspreeEndpoint || DEFAULT_FORMSPREE_ENDPOINT;
  const body = buildEmailBody(data);

  // Use FormData (CORS simple request) to bypass OPTIONS preflight block on localhost
  const formData = new FormData();
  formData.append('name', data.settings.studentName || 'Ученик');
  formData.append('email', 'noreply@chess-trainer.app');
  formData.append('message', body);
  formData.append('_subject', `Отчёт тренажёра: ${data.settings.studentName || 'Ученик'} (${data.date})`);

  let res: Response;
  try {
    res = await fetch(endpoint, {
      method: 'POST',
      headers: { Accept: 'application/json' },
      body: formData,
    });
  } catch {
    // Fallback: URLSearchParams simple request
    const params = new URLSearchParams();
    params.append('name', data.settings.studentName || 'Ученик');
    params.append('email', 'noreply@chess-trainer.app');
    params.append('message', body);
    params.append('_subject', `Отчёт тренажёра: ${data.settings.studentName || 'Ученик'} (${data.date})`);

    res = await fetch(endpoint, {
      method: 'POST',
      headers: { Accept: 'application/json' },
      body: params,
    });
  }

  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: `HTTP ${res.status} ${res.statusText}` }));
    throw new Error(`Ошибка отправки: ${err.error || res.statusText || res.status}`);
  }
}
