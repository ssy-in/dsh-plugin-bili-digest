import test from 'node:test';
import assert from 'node:assert/strict';
import { loginAlertText, sessionUsable, describeSession } from '../lib/core/session.js';

test('登录失效的提醒带上时间、原因和下一步', () => {
  const now = new Date('2026-10-29T05:07:00');
  const text = loginAlertText(now);
  assert.match(text, /^## 05:07$/m);
  assert.ok(text.includes('登录态失效'));
  assert.ok(text.includes('SESSDATA'));
  assert.ok(!text.includes('心情分'));
});

test('只有明确 isLogin 才算能干活', () => {
  assert.equal(sessionUsable({ isLogin: true, uname: '困困的鲸鲸' }), true);
  assert.equal(sessionUsable({ isLogin: false }), false);
  assert.equal(sessionUsable(null), false);
  assert.equal(sessionUsable(undefined), false);
});

test('describeSession 说人话', () => {
  assert.equal(describeSession({ isLogin: true, uname: '困困的鲸鲸' }), '已登录：困困的鲸鲸');
  assert.ok(describeSession({ isLogin: false }).includes('更新 SESSDATA'));
  assert.ok(describeSession(null).includes('未知'));
});
