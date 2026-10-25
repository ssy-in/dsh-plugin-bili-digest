// 短视频赛道：≤ shortVideoMax 秒的视频不看字幕，只看标签和画面。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'bili-short-'));
process.env.BILI_DIGEST_HOME = HOME;

const { readVideo, VERDICT } = await import('../lib/core/gate.js');
const { renderShort, renderReport } = await import('../lib/core/render.js');

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

test('短视频（120 秒 ≤ 300）判成 short，且不需要字幕清单', async () => {
  const api = fakeApi();
  const gate = await readVideo(api, 'BV1aa411c7aa', { checkTone: false, shortVideoMax: 300 });
  assert.equal(gate.verdict, VERDICT.SHORT);
  assert.equal(api.askedSubtitle(), false);
  assert.deepEqual(gate.meta.tags, ['cos', '舞蹈']);
});

test('关掉短视频赛道（shortVideoMax=0）时仍然走字幕门槛', async () => {
  const api = fakeApi();
  const gate = await readVideo(api, 'BV1aa411c7aa', { checkTone: false, shortVideoMax: 0 });
  assert.equal(gate.verdict, VERDICT.NO_SUBTITLE);
  assert.equal(api.askedSubtitle(), true);
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
