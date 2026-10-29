// 消息中心纯逻辑测试：不联网、不发请求。配额、去重、话术、待复盘记录。
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'bili-inbox-'));
process.env.BILI_DIGEST_HOME = home;

const { normalize, quotaState, pickPending, buildReplyText, noteUnclear, readReview, LIMITS, recordReply, applyPreference } = await import('../lib/core/inbox.js');
const { readTagBook } = await import('../lib/core/tagbook.js');

const ownerMid = '9134117';

function msg(over = {}) {
  // 默认「一分钟前」：消息中心只回新消息，写死 100（1970 年）会被「太旧了」挡掉。
  const fresh = Math.floor(Date.now() / 1000) - 60;
  return { id: `reply:${over.rpid || '1'}`, kind: 'reply', mid: '1001', nickname: '路人甲', text: '这条讲得不错', ctime: fresh, bvid: 'BV1aaaaaaaaa', oid: '111', rpid: '1', root: '1', ...over };
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
  const toOwner = buildReplyText(msg({ mid: ownerMid, text: '这个我喜欢' }), { ownerMid });
  assert.ok(toOwner.text.length > 0);
  assert.doesNotMatch(toOwner.text, /@/);
  assert.equal(toOwner.intent, 'like');
  const toOther = buildReplyText(msg({ mid: '2002', text: '路过看看' }), { ownerMid });
  assert.match(toOther.text, /(谢谢|路过|记下)/);
  assert.doesNotMatch(toOther.text, /@/);
  assert.equal(toOther.intent, 'guest');
  assert.ok(toOwner.text.length < 90 && toOther.text.length < 90);
});

test('buildReplyText: 人类下指令→应一声；强烈不满→dislike_strong；池子见底→饭不够了', () => {
  const ack = buildReplyText(msg({ mid: ownerMid, text: '最近多看看 deepseek 的新视频' }), { ownerMid });
  assert.equal(ack.intent, 'ack');
  const strong = buildReplyText(msg({ mid: ownerMid, text: '特别不喜欢这种，别再推了' }), { ownerMid });
  assert.equal(strong.intent, 'dislike_strong');
  const tired = buildReplyText(msg({ mid: '2003', text: '路过' }), { ownerMid, quota: { hourLeft: 1 } });
  assert.equal(tired.intent, 'fatigue');
  assert.match(tired.text, /(饭|力气)/);
});

test('pickPending: 从新到旧、同一个人最多两次、已回过的不再回', () => {
  const now = new Date();
  const fresh = {
    hourUsed: 0,
    dayUsed: 0,
    perPerson: {},
    limits: LIMITS,
    hourLeft: LIMITS.otherPerHour,
    dayLeft: LIMITS.otherPerDay,
  };
  const base = Math.floor(Date.now() / 1000) - 120;
  const messages = [
    msg({ rpid: '11', mid: '3003', ctime: base }),
    msg({ rpid: '10', mid: '3003', ctime: base - 10 }),
    msg({ rpid: '8', mid: '3003', ctime: base - 20 }),
    msg({ rpid: '9', mid: '4004', ctime: base - 30 }),
  ];
  const { picked, skipped } = pickPending(messages, fresh, ownerMid);
  // 3003 有 3 条，只回前两条；4004 正常回。
  assert.deepEqual(picked.map((item) => item.rpid), ['11', '10', '9']);
  assert.equal(skipped.length, 1);
  assert.match(skipped[0].reason, /回过 2 次/);

  recordReply({ id: 'reply:9', mid: '4004' }, now);
  const second = pickPending(messages, quotaState(undefined, now), ownerMid);
  assert.deepEqual(second.picked.map((item) => item.rpid), ['11', '10']);
});

test('quotaState: 其他人的池子按小时/每天算，人类单独计数且不占池子', () => {
  const now = new Date();
  const state = quotaState({ items: [] }, now, { ownerMid });
  assert.equal(state.hourLeft, LIMITS.otherPerHour);
  assert.equal(state.dayLeft, LIMITS.otherPerDay);
  const many = Array.from({ length: 12 }, (_, index) => ({ id: `reply:${index}`, mid: `9${index}`, at: new Date(now.getTime() - index * 1000).toISOString() }));
  const used = quotaState({ items: many }, now, { ownerMid });
  assert.equal(used.hourUsed, 12);
  assert.equal(used.hourLeft, 0);
  const old = Array.from({ length: 60 }, (_, index) => ({ id: `old:${index}`, mid: `8${index}`, at: new Date(now.getTime() - (3 * 3600_000 + index * 60_000)).toISOString() }));
  const dayOnly = quotaState({ items: old }, now, { ownerMid });
  assert.equal(dayOnly.hourUsed, 0);
  assert.equal(dayOnly.dayUsed, 60);
  assert.equal(dayOnly.dayLeft, 0);
  // 人类回了一堆，也不吃池子。
  const withOwner = Array.from({ length: 30 }, (_, index) => ({ id: `owner:${index}`, mid: ownerMid, at: new Date(now.getTime() - index * 1000).toISOString() }));
  const ownerState = quotaState({ items: withOwner }, now, { ownerMid });
  assert.equal(ownerState.dayUsed, 0);
  assert.equal(ownerState.ownerUsed, 30);
  assert.equal(ownerState.dayLeft, LIMITS.otherPerDay);
});

test('pickPending: 配额用完就整批留给下一轮；但人类的消息照样回', () => {
  const now = new Date();
  const quota = { hourUsed: LIMITS.otherPerHour, dayUsed: 10, perPerson: {}, limits: LIMITS, hourLeft: 0, dayLeft: 0 };
  const { picked, skipped } = pickPending([msg({ rpid: '21', mid: '5005' })], quota, ownerMid);
  assert.equal(picked.length, 0);
  assert.match(skipped[0].reason, /这一小时/);
  const owner = pickPending([msg({ rpid: '22', mid: ownerMid })], quota, ownerMid);
  assert.equal(owner.picked.length, 1, '人类不限额');
  assert.equal(owner.picked[0].toOwner, true);
});

test('pickPending: 老消息不追着回，人类一轮最多接几条', () => {
  const now = new Date();
  const quota = { hourUsed: 0, dayUsed: 0, perPerson: {}, limits: LIMITS, hourLeft: LIMITS.otherPerHour, dayLeft: LIMITS.otherPerDay };
  const old = msg({ rpid: '41', mid: '8888', ctime: Math.floor(now.getTime() / 1000) - 4 * 24 * 3600 });
  const fresh = msg({ rpid: '42', mid: '8889' });
  const mixed = pickPending([old, fresh], quota, ownerMid, { now, maxAgeHours: 72 });
  assert.deepEqual(mixed.picked.map((item) => item.rpid), ['42']);
  assert.match(mixed.skipped.find((item) => item.rpid === '41').reason, /太久了/);

  // 人类一口气回了好几条：一轮只接两条，剩下的留到下一轮。
  const owners = ['51', '52', '53'].map((rpid) => msg({ rpid, mid: ownerMid }));
  const capped = pickPending(owners, quota, ownerMid, { now, ownerPerRound: 2 });
  assert.deepEqual(capped.picked.map((item) => item.rpid), ['51', '52']);
  assert.match(capped.skipped.find((item) => item.rpid === '53').reason, /留到下一轮/);
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
  const quota = { hourUsed: 0, dayUsed: 0, perPerson: {}, limits: LIMITS, hourLeft: LIMITS.otherPerHour, dayLeft: LIMITS.otherPerDay };
  const { picked } = pickPending([msg({ rpid: '31', mid: ownerMid })], quota, ownerMid);
  assert.equal(picked[0].toOwner, true);
  const other = pickPending([msg({ rpid: '32', mid: '7777' })], quota, ownerMid);
  assert.equal(other.picked[0].toOwner, false);
});

test('人类说喜欢：记进标签库的 his 栏（没 csrf 时不碰收藏夹）', async () => {
  const result = await applyPreference(
    { csrf: '', atMid: ownerMid },
    { bvid: 'BV1ff411c7ff', text: '这个我喜欢' },
    'like',
    { api: { view: async () => ({ aid: 42, title: '被喜欢的视频', tags: ['评测', 'AI'] }) }, now: new Date('2026-10-24T09:00:00Z') },
  );
  assert.equal(result.ok, true);
  assert.equal(result.favorite, null);
  const book = readTagBook();
  const entry = book.his.find((item) => item.bvid === 'BV1ff411c7ff');
  assert.ok(entry, '应该进 his 栏');
  assert.equal(entry.note, '人类说喜欢');
  assert.deepEqual(entry.tags, ['评测', 'AI']);
});

test('人类说喜欢：口味长在人类自己的表里，鲸鲸那张表一个字节都不动', async () => {
  const { readWeights, tagWeight } = await import('../lib/core/weights.js');
  const whaleFile = path.join(home, 'bili-digest', 'cache', 'weights.json');
  fs.mkdirSync(path.dirname(whaleFile), { recursive: true });
  fs.writeFileSync(
    whaleFile,
    JSON.stringify({ tags: { 塔防: { fast: 0.5, slow: 0.7, seen: 3, likes: 3, updatedAt: '2026-10-20T00:00:00.000Z' } }, updatedAt: '2026-10-20T00:00:00.000Z' }),
  );
  const before = fs.readFileSync(whaleFile, 'utf8');
  await applyPreference(
    { csrf: '', atMid: ownerMid },
    { bvid: 'BV1hh411c7hh', text: '这个我喜欢' },
    'like',
    { api: { view: async () => ({ aid: 43, title: '塔防视频', tags: ['塔防', '攻略'] }) }, now: new Date() },
  );
  assert.equal(fs.readFileSync(whaleFile, 'utf8'), before, '鲸鲸的口味表不该被人类的表态碰到');
  const human = readWeights('human');
  assert.ok(human.tags['塔防'], '人类表里应该长出「塔防」');
  assert.ok(human.tags['塔防'].fast > 0);
  // 幅度要「轻一档」：鲸鲸 like 是 1，人类 like 只有 0.45，摊到两个标签约 0.32，远低于鲸鲸那条已有 0.5+。
  assert.ok(tagWeight('塔防', human, new Date(), undefined, 'human') < 0.5, `人类表幅度应偏轻，实际 ${tagWeight('塔防', human, new Date(), undefined, 'human')}`);
});

test('人类说喜欢：view 不给 tags 时自己去 view/detail 补，别把表态记成空标签', async () => {
  const { readWeights } = await import('../lib/core/weights.js');
  let asked = '';
  const result = await applyPreference(
    { csrf: '', atMid: ownerMid },
    { bvid: 'BV1jj411c7jj', text: '这个我喜欢' },
    'like',
    {
      api: {
        view: async () => ({ aid: 44, title: '没有标签的视频', tags: [] }),
        tags: async (bvid) => {
          asked = bvid;
          return ['音乐', '现场'];
        },
      },
      now: new Date(),
    },
  );
  assert.equal(asked, 'BV1jj411c7jj', '应该补一次 view/detail');
  assert.deepEqual(result.tags, ['音乐', '现场']);
  const human = readWeights('human');
  assert.ok(human.tags['音乐'], '补齐的标签要进人类表');
});

test('normalize: 人类自己的回复没有 rpid，同一个人说同一句话只算一条', () => {
  const base = {
    user: { mid: 9134117, nickname: '三千型四季丶' },
    item: { source_content: '游戏挺有意思的[打call]', uri: 'https://www.bilibili.com/video/BV1oMnZ6yEhg' },
  };
  // 同一条消息两天被拉到，reply_time 不一样——旧实现会当成两条，收藏和口味重复记。
  const day1 = normalize({ ...base, reply_time: 1761447723 }, 'reply');
  const day2 = normalize({ ...base, reply_time: 1761523680 }, 'reply');
  assert.equal(day1.rpid, '');
  assert.equal(day1.id, day2.id, '不同 reply_time 的同一条消息应得到同一个 id');
});

test('人类说喜欢：「人类主人喜欢的视频」夹子被删了就退到默认收藏夹', async () => {
  let used = '';
  const result = await applyPreference(
    { csrf: 'a'.repeat(32), atMid: ownerMid },
    { bvid: 'BV1kk411c7kk', text: '这个我喜欢' },
    'like',
    {
      api: { view: async () => ({ aid: 45, title: '要收藏的视频', tags: ['记录'] }) },
      folders: { liked: '', misc: 3501772585 },
      deal: async (config, { add }) => {
        used = add[0];
        return { code: 0 };
      },
      now: new Date(),
    },
  );
  assert.equal(result.favorite, 'ok');
  assert.equal(used, 3501772585, 'liked 缺失时应退到默认收藏夹');
  assert.equal(result.folder, '人类主人喜欢的视频', '文案里仍说人类喜欢的那个夹子');
});
