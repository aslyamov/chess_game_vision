/**
 * main.ts — Main application orchestration.
 * Connects UI, Settings, GameLoop, BoardRenderer, and reporting.
 */

import { Chessground } from 'chessground';
import type { GameSettings, GameStats } from './types/index.js';
import {
  GameLoop,
  type GameLoopCallbacks,
  type FoundSet,
  type ThreatTotals,
  type GameOverResult,
  formatTime,
} from './core/GameLoop.js';
import { BoardRenderer } from './ui/BoardRenderer.js';
import { persistence } from './core/PersistenceManager.js';
import { sendReport } from './utils/report-sender.js';

// ── DOM Helpers ───────────────────────────────────────────────

const $ = <T extends HTMLElement = HTMLElement>(id: string): T =>
  document.getElementById(id) as T;

// ── DOM References ────────────────────────────────────────────

const settingsScreen  = $('settings-screen');
const gameScreen      = $('game-screen');
const statsModal      = $('stats-modal');

const inpName         = $<HTMLInputElement>('student-name');
const inpElo          = $<HTMLInputElement>('sf-elo');
const inpEloDisp      = $('sf-elo-display');
const inpSearchTimer  = $<HTMLInputElement>('search-timer');
const inpSearchDisp   = $('search-timer-display');
const inpMinutes      = $<HTMLInputElement>('game-minutes');
const inpIncrement    = $<HTMLInputElement>('game-increment');
const inpShowCounts   = $<HTMLInputElement>('show-counts');
const inpFormspree    = $<HTMLInputElement>('formspree-url');
const btnStart        = $('btn-start');
const btnResume       = $('btn-resume');
const btnMenu         = $('btn-menu');
const btnSkipSearch   = $('btn-skip-search');

const phaseBadge      = $('phase-badge');
const statusMsg       = $('status-msg');
const clockWhite      = $('clock-white');
const clockBlack      = $('clock-black');
const boardEl         = $('board');
const playerNameDisp  = $('player-name-display');

const ringProgress    = document.getElementById('ring-progress') as unknown as SVGCircleElement;
const ringInnerText   = $('ring-inner-text');
const searchTimerDisp = $('search-timer-display-game');
const countersCard    = $('counters-card');

const btnSendReport   = $('btn-send-report');
const btnNewGame      = $('btn-new-game');

// ── State ─────────────────────────────────────────────────────

let gameLoop: GameLoop | null = null;
let boardRenderer: BoardRenderer | null = null;
let currentSettings: GameSettings = persistence.loadSettings();
let lastGameOver: GameOverResult | null = null;
let searchTimerTotal = 0;

// ── Settings Screen ───────────────────────────────────────────

function initSettingsScreen(): void {
  inpName.value          = currentSettings.studentName;
  inpElo.value           = String(currentSettings.stockfishElo);
  inpEloDisp.textContent = `${currentSettings.stockfishElo} Elo`;
  inpSearchTimer.value   = String(currentSettings.searchTimerSeconds);
  inpSearchDisp.textContent = `${currentSettings.searchTimerSeconds} сек`;
  inpMinutes.value       = String(currentSettings.gameTimeMinutes);
  inpIncrement.value     = String(currentSettings.incrementSeconds);
  inpShowCounts.checked  = currentSettings.showTargetCounts;
  inpFormspree.value     = currentSettings.formspreeEndpoint;

  inpElo.addEventListener('input', () => {
    inpEloDisp.textContent = `${inpElo.value} Elo`;
  });
  inpSearchTimer.addEventListener('input', () => {
    inpSearchDisp.textContent = `${inpSearchTimer.value} сек`;
  });

  if (persistence.hasUnfinishedGame()) {
    btnResume.classList.remove('hidden');
  }

  btnStart.addEventListener('click', () => startGame(false));
  btnResume.addEventListener('click', () => startGame(true));
  btnMenu.addEventListener('click', goToSettings);
  btnSkipSearch.addEventListener('click', () => gameLoop?.skipToMovePhase());
}

function readSettings(): GameSettings {
  return {
    studentName:        inpName.value.trim() || 'Ученик',
    stockfishElo:       parseInt(inpElo.value, 10),
    searchTimerSeconds: parseInt(inpSearchTimer.value, 10),
    showTargetCounts:   inpShowCounts.checked,
    gameTimeMinutes:    parseInt(inpMinutes.value, 10) || 10,
    incrementSeconds:   parseInt(inpIncrement.value, 10) || 0,
    formspreeEndpoint:  inpFormspree.value.trim(),
  };
}

// ── Navigation ────────────────────────────────────────────────

function showScreen(name: 'settings' | 'game'): void {
  settingsScreen.classList.toggle('hidden', name !== 'settings');
  gameScreen.classList.toggle('hidden', name !== 'game');
  statsModal.classList.add('hidden');
}

function goToSettings(): void {
  gameLoop?.destroy();
  gameLoop = null;
  showScreen('settings');
  btnResume.classList.toggle('hidden', !persistence.hasUnfinishedGame());
}

// ── Game Lifecycle ────────────────────────────────────────────

function startGame(resume: boolean): void {
  currentSettings = readSettings();
  persistence.saveSettings(currentSettings);
  searchTimerTotal = currentSettings.searchTimerSeconds * 1000;

  playerNameDisp.textContent = currentSettings.studentName || 'Вы';
  countersCard.classList.toggle('hidden', !currentSettings.showTargetCounts);

  showScreen('game');

  boardRenderer?.destroy();
  boardRenderer = new BoardRenderer(boardEl, Chessground);
  boardRenderer.initialize({ onMove: handleBoardMove });

  gameLoop?.destroy();
  gameLoop = new GameLoop(currentSettings, buildCallbacks());

  const saved = persistence.loadGameState();
  if (resume && saved) {
    gameLoop.restoreFromState(saved);
  } else {
    persistence.clearGameState();
    gameLoop.startFresh();
  }
}

function handleBoardMove(orig: string, dest: string): void {
  gameLoop?.handleBoardMove(orig, dest);
}

// ── Callbacks ─────────────────────────────────────────────────

function buildCallbacks(): GameLoopCallbacks {
  return {
    onPhaseChange(phase, fen, dests) {
      const isSearch = phase === 'search';

      if (isSearch) {
        phaseBadge.className = 'phase-badge phase-badge--search';
        phaseBadge.textContent = '🔍 Поиск шахов и взятий';
        btnSkipSearch.classList.remove('hidden');
        boardRenderer?.setSearchMode(fen, dests);
      } else {
        phaseBadge.className = 'phase-badge phase-badge--move';
        phaseBadge.textContent = '♟ Ваш ход';
        btnSkipSearch.classList.add('hidden');
        boardRenderer?.setMoveMode(fen, dests);
      }

      clockWhite.classList.toggle('clock--active',   !isSearch);
      clockWhite.classList.toggle('clock--inactive',  isSearch);
      clockBlack.classList.remove('clock--active');
      clockBlack.classList.add('clock--inactive');
    },

    onSearchTimerTick(remainingMs) {
      const secs = Math.max(0, Math.ceil(remainingMs / 1000));
      const m = Math.floor(secs / 60);
      const s = secs % 60;
      const label = m > 0
        ? `${m}:${s.toString().padStart(2, '0')}`
        : `:${s.toString().padStart(2, '0')}`;

      searchTimerDisp.textContent = label;
      ringInnerText.textContent   = label;

      const fraction = Math.max(0, Math.min(1, remainingMs / searchTimerTotal));
      const circumference = 314;
      ringProgress.style.strokeDashoffset = String(circumference * (1 - fraction));
      ringProgress.style.stroke =
        remainingMs < 10_000 ? '#f87272' :
        remainingMs < 20_000 ? '#fbbd23' :
                               '#3abff8';
    },

    onGameTimerTick(whiteMs, blackMs) {
      clockWhite.textContent = formatTime(whiteMs);
      clockBlack.textContent = formatTime(blackMs);
      clockWhite.classList.toggle('clock--low', whiteMs < 30_000);
      clockBlack.classList.toggle('clock--low', blackMs < 30_000);
    },

    onThreatFeedback(orig, dest, correct) {
      const brush = correct ? 'green' : 'red';
      boardRenderer?.flashShape({ orig, dest, brush }, 500);

      // Revert piece position on board back to current FEN
      if (gameLoop) {
        boardRenderer?.undoVisual(gameLoop.getCurrentFen(), gameLoop.getCurrentDests(), true);
      }
    },

    onCountersUpdate(found: FoundSet, totals: ThreatTotals) {
      if (!currentSettings.showTargetCounts) return;
      updateCounter('myChecks',    found.myChecks.size,    totals.myChecks);
      updateCounter('myCaptures',  found.myCaptures.size,  totals.myCaptures);
      updateCounter('oppChecks',   found.oppChecks.size,   totals.oppChecks);
      updateCounter('oppCaptures', found.oppCaptures.size, totals.oppCaptures);
    },

    onStockfishMove({ from, to, fen }) {
      boardRenderer?.clearPersistentShapes();
      boardRenderer?.highlightMove(from, to, 'yellow');
      boardRenderer?.setFen(fen);
    },

    onGameOver(result) {
      lastGameOver = result;
      showStatsModal(result);
    },

    onStatusMessage(msg, type) {
      statusMsg.textContent = msg;
      const colors: Record<string, string> = {
        success: '#36d399',
        error:   '#f87272',
        warn:    '#fbbd23',
        info:    '#a6adbb',
      };
      statusMsg.style.color = colors[type] ?? colors.info;
    },
  };
}

// ── UI Helpers ────────────────────────────────────────────────

type CounterKey = 'myChecks' | 'myCaptures' | 'oppChecks' | 'oppCaptures';

function updateCounter(cat: CounterKey, found: number, total: number): void {
  const el = (id: string) => document.getElementById(id);
  const foundEl = el(`found-${cat}`);
  const totalEl = el(`total-${cat}`);
  const barEl   = el(`bar-${cat}`);
  if (foundEl) foundEl.textContent = String(found);
  if (totalEl) totalEl.textContent = String(total);
  if (barEl) {
    const pct = total > 0 ? (found / total) * 100 : 0;
    barEl.style.width = `${pct}%`;
    barEl.style.background = pct >= 100 ? '#36d399' : '';
  }
}

function pct(found: number, total: number): string {
  if (total === 0) return '—';
  return `${found}/${total} (${Math.round((found / total) * 100)}%)`;
}

function showStatsModal(result: GameOverResult): void {
  const s = result.stats as GameStats;

  $('stat-myChecks').textContent    = pct(s.myChecks.found,    s.myChecks.total);
  $('stat-myCaptures').textContent  = pct(s.myCaptures.found,  s.myCaptures.total);
  $('stat-oppChecks').textContent   = pct(s.oppChecks.found,   s.oppChecks.total);
  $('stat-oppCaptures').textContent = pct(s.oppCaptures.found, s.oppCaptures.total);

  const accuracy = s.totalMoves > 0
    ? (Math.round((s.accuracySum / s.totalMoves) * 10) / 10) : 0;
  $('stat-accuracy').textContent    = `${accuracy}%`;
  $('stat-accuracy-sub').textContent =
    s.totalMoves > 0 ? `Лучших ходов: ${s.bestMoveMatches} из ${s.totalMoves}` : '';

  const totalSec = Math.round(s.totalSearchTimeMs / 1000);
  const avgSec   = s.searchPhaseCount > 0
    ? (s.totalSearchTimeMs / s.searchPhaseCount / 1000).toFixed(1) : '—';
  $('stat-total-time').textContent = `${totalSec} сек`;
  $('stat-avg-time').textContent   = `${avgSec} сек`;

  const reasons: Record<string, string> = {
    checkmate: result.winner === 'white' ? '🏆 Вы поставили мат!' : '♟ Stockfish поставил мат',
    stalemate: '🤝 Пат',
    timeout:   result.winner === 'white' ? '⏰ Время Stockfish вышло' : '⏰ Ваше время вышло',
    draw:      '🤝 Ничья',
  };
  $('stat-result-msg').textContent = reasons[result.reason] ?? '';

  statsModal.classList.remove('hidden');
}

function initModalActions(): void {
  btnNewGame.addEventListener('click', () => {
    statsModal.classList.add('hidden');
    persistence.clearGameState();
    goToSettings();
  });

  btnSendReport.addEventListener('click', async () => {
    if (!lastGameOver) return;
    btnSendReport.textContent = '⏳ Отправка…';
    btnSendReport.setAttribute('disabled', '');
    try {
      await sendReport({
        settings: currentSettings,
        stats: lastGameOver.stats as GameStats,
        pgn: lastGameOver.pgn,
        date: new Date().toLocaleDateString('ru-RU', {
          day: '2-digit', month: '2-digit', year: 'numeric',
          hour: '2-digit', minute: '2-digit',
        }),
      });
      showToast('✅ Отчёт успешно отправлен!', 'success');
    } catch (e: unknown) {
      showToast(`❌ ${(e as Error).message}`, 'error');
    } finally {
      btnSendReport.textContent = '📧 Отправить тренеру';
      btnSendReport.removeAttribute('disabled');
    }
  });
}

function showToast(msg: string, type: 'success' | 'error' | 'info' = 'info'): void {
  const container = $('toast-container');
  const el = document.createElement('div');
  el.className = `toast toast--${type}`;
  el.textContent = msg;
  container.appendChild(el);
  setTimeout(() => {
    el.style.animation = 'toast-out .2s ease forwards';
    setTimeout(() => el.remove(), 220);
  }, 3500);
}

// ── Bootstrap ─────────────────────────────────────────────────

initSettingsScreen();
initModalActions();
