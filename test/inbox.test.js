// 消息中心纯逻辑测试：不联网、不发请求。配额、去重、话术、待复盘记录。
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'bili-inbox-'));
process.env.BILI_DIGEST_HOME = home;

const { normalize, quotaState, pickPending, buildReplyText, noteUnclear, readReview, LIMITS, recordReply } = await import('../lib/core/inbox.js');

const ownerMid = '9134117';

function msg(over = {}) {
  return { id: `reply:${over.rpid || '1'}`, kind: 'reply', mid: '1001', nickname: '路人甲', text: '这条讲得不错', ctime: 100, bvid: 'BV1aaaaaaaaa', oid: '111', rpid: '1', root: '1', ...over };
}

test('normalize: 从消息中心条目里取到能回评论所需的字段', () => {
  const item = {
    user: { mid: 9134117, nickname: '三千型四季丶' },
    item: { source_id: 555, root_id: 0, subject_id: 777, source_content: '这个视频好看', uri: 'https://www.bilibili.com/video/BV1DvHP6nEJk' },
    reply_time: 1700000000,
  };
  const flat = normalize(item, 'reply');
  assert.equal(flat.mid, '9134117');
  assert.equal(flat.nickname, '三千型四季丶');
  assert.equal(flat.text, '这个视频好看');
  assert.equal(flat.oid, '777');
  assert.equal(flat.rpid, '555');
  assert.equal(flat.bvid, 'BV1DvHP6nEJk');
  assert.equal(flat.ctime, 1700000000);
});

test('buildReplyText: 给人类一句熟话，给其他人一句客气话，都不带 @', () => {
  const toOwner = buildReplyText(msg({ mid: ownerMid, text: '把它放我喜欢的视频里' }), { ownerMid });
  assert.match(toOwner, /收到/);
  assert.doesNotMatch(toOwner, /@/);
  const toOther = buildReplyText(msg({ mid: '2002', text: '路过看看' }), { ownerMid });
  assert.match(toOther, /谢谢/);
  assert.doesNotMatch(toOther, /@/);
  assert.ok(toOwner.length < 90 && toOther.length < 90);
});

test('pickPending: 从新到旧、同一人只回一次、已回过的不再回', () => {
  const now = new Date();
  const fresh = { hourUsed: 0, dayUsed: 0, perPerson: {}, limits: LIMITS, hourLeft: LIMITS.perHour, dayLeft: LIMITS.perDay };
  const messages = [
    msg({ rpid: '11', mid: '3003', ctime: 300 }),
    msg({ rpid: '10', mid: '3003', ctime: 200 }),
    msg({ rpid: '9', mid: '4004', ctime: 100 }),
  ];
  const { picked, skipped } = pickPending(messages, fresh, ownerMid);
  assert.deepEqual(picked.map((item) => item.rpid), ['11', '9']);
  assert.equal(skipped.length, 1);
  assert.match(skipped[0].reason, /回过一次/);

  recordReply({ id: 'reply:9', mid: '4004' }, now);
  const second = pickPending(messages, quotaState(undefined, now), ownerMid);
  assert.deepEqual(second.picked.map((item) => item.rpid), ['11']);
});

test('quotaState: 每小时 10 次、每天 50 次的上限被算出来', () => {
  const now = new Date();
  const state = quotaState({ items: [] }, now);
  assert.equal(state.hourLeft, LIMITS.perHour);
  assert.equal(state.dayLeft, LIMITS.perDay);
  const many = Array.from({ length: 12 }, (_, index) => ({ id: `reply:${index}`, mid: `9${index}`, at: new Date(now.getTime() - index * 1000).toISOString() }));
  const used = quotaState({ items: many }, now);
  assert.equal(used.hourUsed, 12);
  assert.equal(used.hourLeft, 0);
  const old = Array.from({ length: 60 }, (_, index) => ({ id: `old:${index}`, mid: `8${index}`, at: new Date(now.getTime() - (3 * 3600_000 + index * 60_000)).toISOString() }));
  const dayOnly = quotaState({ items: old }, now);
  assert.equal(dayOnly.hourUsed, 0);
  assert.equal(dayOnly.dayUsed, 60);
  assert.equal(dayOnly.dayLeft, 0);
});

test('pickPending: 配额用完就整批留给下一轮', () => {
  const now = new Date();
  const quota = { hourUsed: 10, dayUsed: 10, perPerson: {}, limits: LIMITS, hourLeft: 0, dayLeft: 40 };
  const { picked, skipped } = pickPending([msg({ rpid: '21', mid: '5005' })], quota, ownerMid);
  assert.equal(picked.length, 0);
  assert.match(skipped[0].reason, /这一小时/);
});

test('noteUnclear: 把人类的话和我的不确定写进 review.json 与当天日报', () => {
  const now = new Date('2026-10-24T09:00:00Z');
  const result = noteUnclear({ comment: '这条放我喜欢的视频里吧', bvid: 'BV1DvHP6nEJk', guess: '也许该进 mood 夹', reason: '他说的“这条”我不确定指哪条', now });
  assert.equal(result.ok, true);
  const items = readReview();
  assert.equal(items.length, 1);
  assert.match(items[0].comment, /我喜欢的视频/);
  const report = fs.readFileSync(result.report, 'utf8');
  assert.match(report, /人类说的，我拿不准/);
  assert.match(report, /我喜欢的视频/);
  assert.match(report, /等他复盘/);
});

test('pickPending: 人类的消息会被标成 toOwner', () => {
  const quota = { hourUsed: 0, dayUsed: 0, perPerson: {}, limits: LIMITS, hourLeft: 10, dayLeft: 50 };
  const { picked } = pickPending([msg({ rpid: '31', mid: ownerMid })], quota, ownerMid);
  assert.equal(picked[0].toOwner, true);
  const other = pickPending([msg({ rpid: '32', mid: '7777' })], quota, ownerMid);
  assert.equal(other.picked[0].toOwner, false);
});
