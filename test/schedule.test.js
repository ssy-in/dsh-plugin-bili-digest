import test from 'node:test';
import assert from 'node:assert/strict';

const { parseClock, inWindow, currentSlot, isAwake, nextWake, planNextRun, describeSchedule, catchUpPlan, SCHEDULE_DEFAULTS } = await import('../lib/core/schedule.js');

const at = (text) => new Date(text);
const noJitter = () => 0.5;
const config = { autoEveryMinutes: 60, ...SCHEDULE_DEFAULTS };
const minutes = (plan) => Math.round(plan.delayMs / 60_000);

test('parseClock / inWindow：支持跨夜窗口', () => {
  assert.equal(parseClock('08:00'), 480);
  assert.equal(parseClock('01:30'), 90);
  assert.equal(parseClock('乱写', 42), 42);
  assert.equal(parseClock('25:00', 7), 7);
  assert.equal(inWindow(490, '08:00', '09:30'), true, '08:10 在早饭窗口里');
  assert.equal(inWindow(600, '08:00', '09:30'), false, '10:00 已经过了早饭');
  assert.equal(inWindow(700, '08:00', '09:30'), false);
  // 跨零点：22:30–01:30
  assert.equal(inWindow(23 * 60, '22:30', '01:30'), true);
  assert.equal(inWindow(60, '22:30', '01:30'), true);
  assert.equal(inWindow(12 * 60, '22:30', '01:30'), false);
});

test('currentSlot：早饭/午饭/晚饭/睡前是高峰，上班时段是忙，其余空闲', () => {
  assert.equal(currentSlot(at('2026-10-24T08:10:00')).kind, 'peak');
  assert.equal(currentSlot(at('2026-10-24T08:10:00')).label, '早饭');
  assert.equal(currentSlot(at('2026-10-24T12:20:00')).label, '午饭');
  assert.equal(currentSlot(at('2026-10-24T19:00:00')).label, '晚饭');
  assert.equal(currentSlot(at('2026-10-24T23:50:00')).label, '睡前');
  assert.equal(currentSlot(at('2026-10-24T15:20:00')).kind, 'busy');
  assert.equal(currentSlot(at('2026-10-24T04:00:00')).kind, 'idle');
});

test('isAwake / nextWake：睡觉时间静默，醒来对齐到起床时间附近', () => {
  assert.equal(isAwake(at('2026-10-24T03:20:00'), config), false);
  assert.equal(isAwake(at('2026-10-24T10:00:00'), config), true);
  assert.equal(isAwake(at('2026-10-24T23:50:00'), config), true, '睡前还算醒着');
  const wake = nextWake(at('2026-10-24T03:20:00'), config, () => 0);
  assert.equal(wake.getHours(), 8);
  assert.equal(wake.getMinutes(), 0);
});

test('planNextRun：睡觉中直接排到起床，而且不会排到过去', () => {
  const plan = planNextRun(at('2026-10-24T03:20:00'), config, noJitter);
  assert.equal(plan.slot, 'sleep');
  assert.equal(plan.reason, '睡觉中，醒了再刷');
  assert.ok(plan.delayMs > 60 * 60_000, '至少还有一小时才醒');
  assert.equal(plan.at.getHours(), 8);
});

test('planNextRun：饭点比上班时段更勤，抖动关掉时是可算的', () => {
  const peak = planNextRun(at('2026-10-24T12:20:00'), { ...config, scheduleJitter: 0, scheduleSkipChance: 0 }, noJitter);
  const busy = planNextRun(at('2026-10-24T15:20:00'), { ...config, scheduleJitter: 0, scheduleSkipChance: 0 }, noJitter);
  assert.equal(peak.slot, 'peak');
  assert.equal(busy.slot, 'busy');
  assert.ok(minutes(peak) < minutes(busy), `饭点应该更快：${minutes(peak)} vs ${minutes(busy)}`);
  assert.equal(minutes(peak), 36);
  assert.equal(minutes(busy), 96);
});

test('planNextRun：走神跳过、关掉作息回到固定间隔、关掉自动刷返回 0', () => {
  const skipped = planNextRun(at('2026-10-24T12:20:00'), { ...config, scheduleJitter: 0, scheduleSkipChance: 0.5 }, () => 0.1);
  assert.equal(skipped.skipped, true);
  assert.ok(minutes(skipped) > 36, '跳过时这一轮往后挪');

  const fixed = planNextRun(at('2026-10-24T03:20:00'), { ...config, scheduleEnabled: false }, noJitter);
  assert.equal(fixed.slot, 'fixed');
  assert.equal(minutes(fixed), 60, '关掉作息就是固定间隔，睡觉也照跑');

  const off = planNextRun(at('2026-10-24T12:20:00'), { autoEveryMinutes: 0 }, noJitter);
  assert.equal(off.delayMs, 0);
  assert.equal(off.reason, '自动刷已关闭');
});

test('describeSchedule：给界面的一句话，含醒着与否与下次时间', () => {
  const awake = describeSchedule(at('2026-10-24T12:20:00'), config);
  assert.equal(awake.awake, true);
  assert.match(awake.nextAtLocal, /^\d{2}:\d{2}$/);
  assert.ok(awake.nextInMinutes >= 1);
  const sleep = describeSchedule(at('2026-10-24T03:20:00'), config);
  assert.equal(sleep.awake, false);
  assert.match(sleep.label, /睡觉中/);
  assert.equal(sleep.slot, 'sleep');
});

test('catchUpPlan：没跑过就补一轮，间隔没到就不补，睡觉时段只等起床', () => {
  const base = { autoEveryMinutes: 30, scheduleEnabled: true, activeFrom: '08:00', activeTo: '01:30' };
  // 从没跑过（上午 10:00，醒着）→ 补
  const first = catchUpPlan(new Date('2026-10-25T10:00:00'), base);
  assert.equal(first.overdue, true);
  assert.ok(first.delayMs > 0 && first.delayMs <= 70000);
  // 20 分钟前刚跑过 → 不补
  const recent = catchUpPlan(new Date('2026-10-25T10:20:00'), { ...base, lastAutoAt: '2026-10-25T10:00:00' });
  assert.equal(recent.overdue, false);
  assert.equal(recent.delayMs, null);
  // 3 小时前跑过 → 补
  const stale = catchUpPlan(new Date('2026-10-25T13:00:00'), { ...base, lastAutoAt: '2026-10-25T10:00:00' });
  assert.equal(stale.overdue, true);
  // 凌晨 3 点没跑过 → 不硬跑（睡觉时段）
  const night = catchUpPlan(new Date('2026-10-25T03:00:00'), base);
  assert.equal(night.overdue, true);
  assert.equal(night.delayMs, null);
  // 关掉自动刷 → 永远不补
  assert.equal(catchUpPlan(new Date('2026-10-25T10:00:00'), { ...base, autoEveryMinutes: 0 }).delayMs, null);
});
