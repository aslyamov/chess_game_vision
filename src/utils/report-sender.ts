/**
 * report-sender.ts — send game report to coach via Formspree.
 */

import type { GameStats, GameSettings } from '../types/index.js';
import { DEFAULT_FORMSPREE_ENDPOINT, getBotLevelConfig } from '../types/index.js';
import { pct } from './format.js';

export interface ReportData {
  settings: GameSettings;
  stats: GameStats;
  pgn: string;
  date: string;
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
${data.pgn}
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
