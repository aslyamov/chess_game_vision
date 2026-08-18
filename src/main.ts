/**
 * main.ts — Main application orchestration.
 * Connects UI, Settings, GameLoop, BoardRenderer, and reporting.
 */

import { Chessground } from 'chessground';
import type { GameSettings, PlayerColor } from './types/index.js';
import { DEFAULT_FORMSPREE_ENDPOINT } from './types/index.js';
import {
  GameLoop,
  type GameLoopCallbacks,
  type FoundSet,
  type ThreatTotals,
  type GameOverResult,
} from './core/GameLoop.js';
import { BoardRenderer } from './ui/BoardRenderer.js';
import { persistence } from './core/PersistenceManager.js';
import { sendReport } from './utils/report-sender.js';
import { pct, formatTime, formatSearchTime } from './utils/format.js';

// ── DOM Helpers ───────────────────────────────────────────────

const $ = <T extends HTMLElement = HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Element #${id} not found`);
  return el as T;
};

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
const oppNameDisp     = $('opp-name-display');
const playerAvatar    = $('player-avatar');
const oppAvatar       = $('opp-avatar');

const counterHdrMine  = $('counter-hdr-mine');
const counterHdrOpp   = $('counter-hdr-opp');
const statHdrMine     = $('stat-hdr-mine');
const statHdrOpp      = $('stat-hdr-opp');

const ringProgress    = document.querySelector<SVGCircleElement>('#ring-progress')!;
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

function renderSearchTimer(remainingMs: number, totalMs: number): void {
  const label = formatSearchTime(remainingMs);

  searchTimerDisp.textContent = label;
  ringInnerText.textContent   = label;

  const fraction = totalMs > 0 ? Math.max(0, Math.min(1, remainingMs / totalMs)) : 1;
  const circumference = 314;
  ringProgress.style.strokeDashoffset = String(circumference * (1 - fraction));
  ringProgress.style.stroke =
    remainingMs < 10_000 ? '#f87272' :
    remainingMs < 20_000 ? '#fbbd23' :
                           '#3abff8';
}

function updateColorTheme(studentColor: PlayerColor): void {
  const isWhite = studentColor === 'w';
  boardRenderer?.setOrientation(isWhite ? 'white' : 'black');
  playerAvatar.textContent   = isWhite ? '♔' : '♚';
  oppAvatar.textContent      = isWhite ? '♚' : '♔';
  counterHdrMine.textContent = isWhite ? '♔ Ваши возможности' : '♚ Ваши возможности';
  counterHdrOpp.textContent  = isWhite ? '♚ Угрозы соперника' : '♔ Угрозы соперника';
  statHdrMine.textContent    = isWhite ? '♔ Ваши угрозы' : '♚ Ваши угрозы';
  statHdrOpp.textContent     = isWhite ? '♚ Угрозы Stockfish' : '♔ Угрозы Stockfish';
}

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
  inpFormspree.value     = currentSettings.formspreeEndpoint || DEFAULT_FORMSPREE_ENDPOINT;

  renderSearchTimer(currentSettings.searchTimerSeconds * 1000, currentSettings.searchTimerSeconds * 1000);

  inpElo.addEventListener('input', () => {
    inpEloDisp.textContent = `${inpElo.value} Elo`;
  });
  inpSearchTimer.addEventListener('input', () => {
    const val = parseInt(inpSearchTimer.value, 10) || 30;
    inpSearchDisp.textContent = `${val} сек`;
    renderSearchTimer(val * 1000, val * 1000);
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
    formspreeEndpoint:  inpFormspree.value.trim() || DEFAULT_FORMSPREE_ENDPOINT,
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

// ── Game Lifecycle ────────────────────────────────────

function startGame(resume: boolean): void {
  currentSettings = readSettings();
  persistence.saveSettings(currentSettings);
  searchTimerTotal = currentSettings.searchTimerSeconds * 1000;
  renderSearchTimer(searchTimerTotal, searchTimerTotal);

  playerNameDisp.textContent = currentSettings.studentName || 'Вы';
  oppNameDisp.textContent    = `Stockfish (${currentSettings.stockfishElo})`;
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
    onGameInit(studentColor) {
      updateColorTheme(studentColor);
    },

    onPhaseChange(phase, fen, dests) {
      const isSearch = phase === 'search';
      const studentColor = gameLoop?.getStudentColor() ?? 'w';
      const isStudentTurn = !isSearch;

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

      if (studentColor === 'w') {
        clockWhite.classList.toggle('clock--active',   isStudentTurn);
        clockWhite.classList.toggle('clock--inactive', !isStudentTurn);
        clockBlack.classList.remove('clock--active');
        clockBlack.classList.add('clock--inactive');
      } else {
        clockBlack.classList.toggle('clock--active',   isStudentTurn);
        clockBlack.classList.toggle('clock--inactive', !isStudentTurn);
        clockWhite.classList.remove('clock--active');
        clockWhite.classList.add('clock--inactive');
      }
    },

    onSearchTimerTick(remainingMs) {
      renderSearchTimer(remainingMs, searchTimerTotal);
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

const counterDomCache: Partial<Record<CounterKey, { foundEl: HTMLElement | null; totalEl: HTMLElement | null; barEl: HTMLElement | null }>> = {};

function updateCounter(cat: CounterKey, found: number, total: number): void {
  let dom = counterDomCache[cat];
  if (!dom) {
    dom = {
      foundEl: document.getElementById(`found-${cat}`),
      totalEl: document.getElementById(`total-${cat}`),
      barEl:   document.getElementById(`bar-${cat}`),
    };
    counterDomCache[cat] = dom;
  }
  if (dom.foundEl) dom.foundEl.textContent = String(found);
  if (dom.totalEl) dom.totalEl.textContent = String(total);
  if (dom.barEl) {
    const pctVal = total === 0 ? 100 : (found / total) * 100;
    dom.barEl.style.width = `${pctVal}%`;
    dom.barEl.style.background = pctVal >= 100 ? '#36d399' : '';
  }
}

function showStatsModal(result: GameOverResult): void {
  const s = result.stats;
  const isWhite = result.studentColor === 'w';

  statHdrMine.textContent = isWhite ? '♔ Ваши угрозы' : '♚ Ваши угрозы';
  statHdrOpp.textContent  = isWhite ? '♚ Угрозы Stockfish' : '♔ Угрозы Stockfish';

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

  const studentWon = result.winner === (isWhite ? 'white' : 'black');

  const reasons: Record<string, string> = {
    checkmate: studentWon ? '🏆 Вы поставили мат!' : '♟ Stockfish поставил мат',
    stalemate: '🤝 Пат',
    timeout:   studentWon ? '⏰ Время Stockfish вышло' : '⏰ Ваше время вышло',
    draw:      '🤝 Ничья',
  };
  $('stat-result-msg').textContent = reasons[result.reason] ?? '';

  statsModal.classList.remove('hidden');
}

function initModalActions(): void {
  const closeModal = () => {
    statsModal.classList.add('hidden');
    persistence.clearGameState();
    goToSettings();
  };

  btnNewGame.addEventListener('click', closeModal);

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !statsModal.classList.contains('hidden')) {
      closeModal();
    }
  });

  btnSendReport.addEventListener('click', async () => {
    if (!lastGameOver) return;
    btnSendReport.textContent = '⏳ Отправка…';
    btnSendReport.setAttribute('disabled', '');
    try {
      await sendReport({
        settings: currentSettings,
        stats: lastGameOver.stats,
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
