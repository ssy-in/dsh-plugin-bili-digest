/**
 * 作息：让「每小时自动刷一轮」看起来像一个人的作息，而不是定时任务。
 *
 * 规则（全部可由配置覆盖）：
 * - 睡觉时间不刷（默认 01:30–08:00 静默），醒着才动；
 * - 早饭 / 午饭 / 晚饭 / 睡前是高峰，间隔更短；
 * - 上午下午的上班时段间隔拉长（像在偷看手机）；
 * - 每次间隔带抖动，另有小概率整轮跳过（人会走神，机器不会）。
 *
 * 这一层只算「下一次什么时候跑」，不碰网络。
 */

export const SCHEDULE_DEFAULTS = {
  scheduleEnabled: true,
  activeFrom: '08:00',
  activeTo: '01:30',
  scheduleJitter: 0.35,
  scheduleSkipChance: 0.1,
};

export const PEAKS = [
  { from: '08:00', to: '09:30', factor: 0.6, label: '早饭' },
  { from: '12:00', to: '13:30', factor: 0.6, label: '午饭' },
  { from: '18:00', to: '20:00', factor: 0.65, label: '晚饭' },
  { from: '22:30', to: '01:30', factor: 0.55, label: '睡前' },
];

export const BUSY = [
  { from: '09:30', to: '12:00', factor: 1.5, label: '上午在忙' },
  { from: '14:00', to: '18:00', factor: 1.6, label: '下午在忙' },
];

const clamp = (value, lo, hi) => Math.min(hi, Math.max(lo, value));
const MINUTE = 60_000;

/** 'HH:MM' → 当天第几分钟；解析不出来就退回 fallback。 */
export function parseClock(text, fallback = 0) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(text || '').trim());
  if (!m) return fallback;
  const hour = Number(m[1]);
  const minute = Number(m[2]);
  if (!Number.isFinite(hour) || !Number.isFinite(minute) || hour > 23 || minute > 59) return fallback;
  return hour * 60 + minute;
}

export function minuteOfDay(date) {
  return date.getHours() * 60 + date.getMinutes();
}

/** 支持跨夜的窗口（from > to 表示跨零点）。 */
export function inWindow(minute, from, to) {
  const a = parseClock(from, 0);
  const b = parseClock(to, 0);
  if (a === b) return false;
  return a < b ? minute >= a && minute < b : minute >= a || minute < b;
}

/** 现在处在哪个时段：高峰 / 忙 / 空闲。 */
export function currentSlot(now = new Date()) {
  const minute = minuteOfDay(now);
  for (const slot of PEAKS) if (inWindow(minute, slot.from, slot.to)) return { ...slot, kind: 'peak' };
  for (const slot of BUSY) if (inWindow(minute, slot.from, slot.to)) return { ...slot, kind: 'busy' };
  return { factor: 1, label: '空闲', kind: 'idle', from: '', to: '' };
}

/** 睡觉中吗？醒着的窗口由 activeFrom/activeTo 定义（可跨夜）。 */
export function isAwake(now = new Date(), config = {}) {
  const from = config.activeFrom || SCHEDULE_DEFAULTS.activeFrom;
  const to = config.activeTo || SCHEDULE_DEFAULTS.activeTo;
  return inWindow(minuteOfDay(now), from, to);
}

/** 下一个起床时间（含 0–25 分钟赖床抖动）。 */
export function nextWake(now = new Date(), config = {}, rng = Math.random) {
  const from = parseClock(config.activeFrom || SCHEDULE_DEFAULTS.activeFrom, 8 * 60);
  const at = new Date(now.getTime());
  at.setSeconds(0, 0);
  const minute = minuteOfDay(at);
  const offset = (from - minute + 24 * 60) % (24 * 60) || 24 * 60;
  at.setTime(at.getTime() + offset * MINUTE + Math.floor(rng() * 25) * MINUTE);
  return at;
}

/**
 * 下一次自动刷的时间。
 * @returns {{at: Date, delayMs: number, reason: string, slot: string, skipped: boolean}}
 */
export function planNextRun(now = new Date(), config = {}, rng = Math.random) {
  const base = Number(config.autoEveryMinutes) || 0;
  const enabled = config.scheduleEnabled !== false;
  if (!(base > 0)) {
    return { at: new Date(now.getTime()), delayMs: 0, reason: '自动刷已关闭', slot: 'off', skipped: false };
  }
  if (!enabled) {
    const delayMs = base * MINUTE;
    return { at: new Date(now.getTime() + delayMs), delayMs, reason: '固定间隔', slot: 'fixed', skipped: false };
  }
  if (!isAwake(now, config)) {
    const at = nextWake(now, config, rng);
    return {
      at,
      delayMs: Math.max(MINUTE, at.getTime() - now.getTime()),
      reason: '睡觉中，醒了再刷',
      slot: 'sleep',
      skipped: false,
    };
  }
  const slot = currentSlot(now);
  const jitter = Number(config.scheduleJitter ?? SCHEDULE_DEFAULTS.scheduleJitter);
  const spread = clamp(Number.isFinite(jitter) ? jitter : 0.35, 0, 1);
  const jitterFactor = 1 + (rng() * 2 - 1) * spread;
  const skipChance = clamp(Number(config.scheduleSkipChance ?? SCHEDULE_DEFAULTS.scheduleSkipChance), 0, 0.5);
  const skipped = rng() < skipChance;
  const factor = slot.factor * jitterFactor * (skipped ? 1.8 : 1);
  const delayMs = Math.max(MINUTE, Math.round(base * MINUTE * factor));
  const reason = skipped ? `${slot.label}（走神了，这一轮往后挪）` : slot.label;
  return { at: new Date(now.getTime() + delayMs), delayMs, reason, slot: slot.kind, skipped };
}

/** 一句话描述当前作息状态，给界面/日志用。 */
export function describeSchedule(now = new Date(), config = {}) {
  const plan = planNextRun(now, config, () => 0.5);
  const hhmm = (date) => `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
  const label = plan.slot === 'sleep' ? `睡觉中（${config.activeFrom || '08:00'} 起床）` : plan.reason;
  return {
    awake: isAwake(now, config),
    slot: plan.slot,
    label,
    nextAt: plan.at.toISOString(),
    nextAtLocal: hhmm(plan.at),
    nextInMinutes: Math.round(plan.delayMs / MINUTE),
    activeFrom: config.activeFrom || SCHEDULE_DEFAULTS.activeFrom,
    activeTo: config.activeTo || SCHEDULE_DEFAULTS.activeTo,
  };
}
