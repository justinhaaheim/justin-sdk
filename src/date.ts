/**
 * Date/time formatting utilities for local (wall-clock) time.
 * No external dependencies — plain Date arithmetic only.
 */

const pad = (n: number) => n.toString().padStart(2, '0');

/**
 * Format a Date as YYYY-MM-DD-HHmmss in local time.
 * Suitable for filenames and archive suffixes.
 * Example: 2026-06-09-020118
 */
export function formatLocalTimestamp(d: Date): string {
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
  );
}

/**
 * Format a Date as YYYY-MM-DD in local time.
 * Example: 2026-06-09
 */
export function formatLocalDate(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * Format a Date as HH:mm:ss in local time.
 * Example: 02:01:18
 */
export function formatLocalTime(d: Date): string {
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/**
 * Return an ISO 8601 string in local time (not UTC).
 * Useful for log entries and human-readable metadata.
 * Example: 2026-06-09T02:01:18-07:00
 */
export function formatLocalISO(d: Date): string {
  const offsetMin = -d.getTimezoneOffset();
  const sign = offsetMin >= 0 ? '+' : '-';
  const absMin = Math.abs(offsetMin);
  const tzStr = `${sign}${pad(Math.floor(absMin / 60))}:${pad(absMin % 60)}`;
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}` +
    tzStr
  );
}
