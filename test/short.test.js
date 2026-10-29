// 短视频赛道：≤ shortVideoMax 秒的视频先探一次字幕清单——
// 有字幕就照字幕读，没有才退回「标签 + 画面」（并多给几帧）。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'bili-short-'));
process.env.BILI_DIGEST_HOME = HOME;

const { readVideo, VERDICT } = await import('../lib/core/gate.js');
const { renderShort, renderReport, renderVideo } = await import('../lib/core/render.js');

function fakeApi(overrides = {}) {
  let subtitleAsked = false;
  return {
    askedSubtitle: () => subtitleAsked,
    view: async (bvid) => ({ bvid, aid: 1, cid: 2, duration: 120, title: '跳舞的 coser', up: '某个 UP', tags: [], owner: { mid: 9 } }),
    tags: async () => ['cos', '舞蹈'],
    subtitleList: async () => {
      subtitleAsked = true;
      return { needsLogin: false, tracks: [] };
    },
    fetchSubtitle: async () => [],
    ...overrides,
  };
}

test('短视频没有字幕时：判成 short，退回标签 + 画面', async () => {
  const api = fakeApi();
  const gate = await readVideo(api, 'BV1aa411c7aa', { checkTone: false, shortVideoMax: 300 });
  assert.equal(gate.verdict, VERDICT.SHORT);
  assert.equal(gate.short, true);
  assert.equal(api.askedSubtitle(), true, '短视频也会探一次字幕清单（1 次请求）');
  assert.deepEqual(gate.meta.tags, ['cos', '舞蹈']);
});

test('短视频有字幕时：照字幕读，结果带 short 标记', async () => {
  const api = fakeApi({
    subtitleList: async () => ({ needsLogin: false, tracks: [{ lan: 'ai-zh', label: '中文（AI）', url: 'https://example.com/s.json', ai: true }] }),
    fetchSubtitle: async () => [
      { from: 0, to: 2, text: '这个舞蹈动作其实细节很多，要看腰和肩的发力顺序才做得出来，' },
      { from: 2, to: 4, text: '很多人只抄动作不抄呼吸，所以看起来浮，落地也不稳。' },
      { from: 4, to: 6, text: '想学的话先把重心压下去，再一格一格慢慢加速，别急。' },
    ],
  });
  const gate = await readVideo(api, 'BV1aa411c7aa', { checkTone: false, shortVideoMax: 300 });
  assert.equal(gate.verdict, VERDICT.OK);
  assert.equal(gate.short, true);
  assert.ok(gate.chars > 0);
  const md = renderVideo({
    meta: gate.meta,
    picked: [{ from: 0, to: 2, text: '这个舞蹈动作其实细节很多，', chars: 12 }],
    chars: gate.chars,
    track: gate.track,
    charsPerMinute: gate.charsPerMinute,
    short: true,
  });
  assert.ok(md.includes('短视频（有字幕）'));
});

test('关掉短视频赛道（shortVideoMax=0）时仍然走字幕门槛', async () => {
  const api = fakeApi();
  const gate = await readVideo(api, 'BV1aa411c7aa', { checkTone: false, shortVideoMax: 0 });
  assert.equal(gate.verdict, VERDICT.NO_SUBTITLE);
  assert.equal(api.askedSubtitle(), true);
});

test('probeShortSubtitle=false 时不探字幕，直接看画面', async () => {
  const api = fakeApi();
  const gate = await readVideo(api, 'BV1aa411c7aa', { checkTone: false, shortVideoMax: 300, probeShortSubtitle: false });
  assert.equal(gate.verdict, VERDICT.SHORT);
  assert.equal(api.askedSubtitle(), false);
});

test('renderShort / renderReport 把短视频写成一行带标签的条目', () => {
  const short = { meta: { bvid: 'BV1aa411c7aa', title: '跳舞的 coser', duration: 120 }, tags: ['cos', '舞蹈'], frames: [{ second: 0 }, { second: 60 }] };
  const line = renderShort(short);
  assert.ok(line.includes('BV1aa411c7aa'));
  assert.ok(line.includes('cos'));
  assert.ok(line.includes('画面 2 帧'));
  const report = renderReport({
    sections: [],
    shorts: [short],
    skipped: [],
    stats: { keywords: ['cos'], candidates: 1, charsIn: 0, charsOut: 0, saved: 0 },
    generatedAt: new Date('2026-10-24T10:00:00Z'),
  });
  assert.ok(report.includes('短视频（不看字幕'));
});

test('热度分：收藏/点赞多的排前面，粉丝量不看', async () => {
  const { hotScore } = await import('../lib/core/digest.js');
  const cold = { play: 300, favorites: 2, like: 10 };
  const warm = { play: 20000, favorites: 300, like: 1500 };
  const hot = { play: 500000, favorites: 20000, like: 40000 };
  assert.ok(hotScore(hot) > hotScore(warm) && hotScore(warm) > hotScore(cold));
  // 同样播放量，收藏多的更热
  assert.ok(hotScore({ play: 10000, favorites: 800 }) > hotScore({ play: 10000, favorites: 10 }));
  assert.equal(hotScore({}), 0);
});

test('有字幕的短视频也带画面：报告里写帧数与时间点', () => {
  const section = {
    meta: { bvid: 'BV1SHORTSUB', title: '跳舞的 coser', up: '某个 UP', duration: 95, cid: 2 },
    picked: [{ from: 5, to: 20, text: '第一句话' }],
    chars: 120,
    track: { label: '中文（自动生成）', lan: 'ai-zh', ai: true },
    charsPerMinute: 75,
    short: true,
    frames: [{ second: 0 }, { second: 16 }, { second: 32 }, { second: 48 }, { second: 64 }, { second: 80 }],
    frameDir: 'H:/x/画面/20261029',
  };
  const text = renderVideo(section);
  assert.ok(text.includes('短视频（有字幕）'));
  assert.ok(text.includes('画面 6 帧'));
  assert.ok(text.includes('0:00') && text.includes('1:20'));
});
