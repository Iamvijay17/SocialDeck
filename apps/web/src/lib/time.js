import { TZDate } from '@date-fns/tz';

/**
 * Timestamps are stored in UTC. Everything shown to the user is rendered in their configured IANA timezone,
 * and every date the user enters is interpreted in that timezone and converted back to a UTC instant.
 */

export function formatInZone(value, timeZone, opts = { dateStyle: 'medium', timeStyle: 'short' }) {
  if (!value) return '—';
  return new Intl.DateTimeFormat(undefined, { timeZone, ...opts }).format(new Date(value));
}

export const formatTimeInZone = (value, timeZone) => formatInZone(value, timeZone, { hour: '2-digit', minute: '2-digit' });

export function relativeTime(value, now = Date.now()) {
  if (!value) return '';
  const diff = new Date(value).getTime() - now;
  const abs = Math.abs(diff);
  const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
  if (abs < 60_000) return rtf.format(Math.round(diff / 1000), 'second');
  if (abs < 3_600_000) return rtf.format(Math.round(diff / 60_000), 'minute');
  if (abs < 86_400_000) return rtf.format(Math.round(diff / 3_600_000), 'hour');
  return rtf.format(Math.round(diff / 86_400_000), 'day');
}

/** Value for <input type="datetime-local"> showing `instant` in `timeZone`. */
export function toLocalInput(instant, timeZone) {
  const d = new TZDate(new Date(instant).getTime(), timeZone);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** Interpret a datetime-local string as wall-clock time in `timeZone` and return the UTC ISO string. */
export function fromLocalInput(local, timeZone) {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(local ?? '');
  if (!m) return null;
  const d = new TZDate(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), 0, timeZone);
  return new Date(d.getTime()).toISOString();
}

/** Day cells for a month grid (6 weeks, Monday first) in the given timezone. */
export function monthGrid(year, month, timeZone) {
  const first = new TZDate(year, month, 1, timeZone);
  const offset = (first.getDay() + 6) % 7; // Monday = 0
  const start = new TZDate(year, month, 1 - offset, timeZone);
  return Array.from({ length: 42 }, (_, i) => new TZDate(start.getFullYear(), start.getMonth(), start.getDate() + i, timeZone));
}

export function weekDays(anchor, timeZone) {
  const a = new TZDate(anchor.getTime(), timeZone);
  const offset = (a.getDay() + 6) % 7;
  return Array.from({ length: 7 }, (_, i) => new TZDate(a.getFullYear(), a.getMonth(), a.getDate() - offset + i, timeZone));
}

export const dayKey = (d, timeZone) => {
  const t = new TZDate(new Date(d).getTime(), timeZone);
  return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`;
};

export const startOfDayIso = (d) => new Date(d.getTime()).toISOString();

export const localTimezone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;

export const commonTimezones = () => {
  try {
    return Intl.supportedValuesOf('timeZone');
  } catch {
    return ['UTC'];
  }
};
