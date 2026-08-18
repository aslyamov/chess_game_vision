/**
 * format.ts — Shared formatting utilities.
 */

export function pct(found: number, total: number): string {
  if (total === 0) return '—';
  return `${found}/${total} (${Math.round((found / total) * 100)}%)`;
}

export function formatTime(ms: number): string {
  const totalSeconds = Math.max(0, Math.ceil(ms / 1000));
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

export function formatSearchTime(remainingMs: number): string {
  const secs = Math.max(0, Math.ceil(remainingMs / 1000));
  return String(secs);
}
