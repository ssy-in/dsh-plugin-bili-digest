// 抓帧纯逻辑测试：分镜解析、格位换算、选帧、裁剪（不联网、不解码 JPEG）。
import test from 'node:test';
import assert from 'node:assert/strict';

import { MAX_FRAMES, frameCountFor, parseStoryboard, cellRect, frameIndexAt, planFrames, cropRgba } from '../lib/core/frames.js';

// 复刻真实接口形状：index[0] 是占位，之后每 5 秒一个时间戳；200 帧、2 张 10×10 分镜图。
const INDEX = [0, ...Array.from({ length: 200 }, (_, i) => i * 5)];
const STORYBOARD = {
  pvdata: 'pvdata-token',
  img_x_len: 10,
  img_y_len: 10,
  img_x_size: 160,
  img_y_size: 90,
  image: ['//i0.hdslb.com/bfs/storyboard/a.jpg', '//i0.hdslb.com/bfs/storyboard/b.jpg'],
  index: INDEX,
  video_shots: 2,
};

test('frameCountFor 按时长给出 6/12/16/20 帧', () => {
  assert.equal(frameCountFor(30), 6);
  assert.equal(frameCountFor(180), 6);
  assert.equal(frameCountFor(181), 12);
  assert.equal(frameCountFor(900), 12);
  assert.equal(frameCountFor(2700), 16);
  assert.equal(frameCountFor(7200), 20);
  assert.ok(frameCountFor(7200) <= MAX_FRAMES);
});

test('parseStoryboard 把 index[0] 当占位并推出时间轴', () => {
  const board = parseStoryboard(STORYBOARD);
  assert.equal(board.cols, 10);
  assert.equal(board.rows, 10);
  assert.equal(board.cellsPerSheet, 100);
  assert.equal(board.cellWidth, 160);
  assert.equal(board.cellHeight, 90);
  assert.equal(board.sheets.length, 2);
  assert.equal(board.step, 5);
  assert.equal(board.times.length, 200);
  assert.deepEqual(board.times.slice(0, 3), [0, 5, 10]);
  assert.equal(board.duration, 1000);
  assert.ok(board.sheets[0].startsWith('https://'));
});

test('parseStoryboard 拒绝坏数据', () => {
  assert.throws(() => parseStoryboard(null), /videoshot/);
  assert.throws(() => parseStoryboard({ ...STORYBOARD, image: [] }), /分镜图片/);
  assert.throws(() => parseStoryboard({ ...STORYBOARD, index: [] }), /时间索引/);
});

test('cellRect 按行列换算格位坐标', () => {
  const board = parseStoryboard(STORYBOARD);
  assert.deepEqual(cellRect(board, 0), { sheetIndex: 0, x: 0, y: 0, width: 160, height: 90 });
  assert.deepEqual(cellRect(board, 11), { sheetIndex: 0, x: 160, y: 90, width: 160, height: 90 });
  const second = cellRect(board, 123);
  assert.equal(second.sheetIndex, 1);
  assert.equal(second.x, 160 * 3);
  assert.equal(second.y, 90 * 2);
  assert.throws(() => cellRect(board, -1), /越界/);
  assert.throws(() => cellRect(board, 200), /越界/);
});

test('frameIndexAt 取最近的时间点', () => {
  const times = [0, 5, 10, 15, 20];
  assert.equal(frameIndexAt(times, 0), 0);
  assert.equal(frameIndexAt(times, 6.9), 1);
  assert.equal(frameIndexAt(times, 8), 2);
  assert.equal(frameIndexAt(times, 999), 4);
});

test('planFrames 均匀取样、按时间点取帧、并尊重上限', () => {
  const times = [0, 5, 10, 15, 20];
  const even = planFrames(times, { count: 3 });
  assert.deepEqual(even.indices, [0, 2, 4]);
  assert.equal(even.count, 3);
  assert.equal(even.capped, false);

  const points = planFrames(times, { seconds: [18, 4] });
  assert.deepEqual(points.indices, [1, 4]);

  const all = planFrames(times, { count: 99 });
  assert.deepEqual(all.indices, [0, 1, 2, 3, 4]);
  assert.equal(all.capped, false);

  const single = planFrames(times, { count: 1 });
  assert.deepEqual(single.indices, [0]);

  const long = Array.from({ length: 300 }, (_, i) => i * 5);
  const auto = planFrames(long, { duration: 1500 });
  assert.equal(auto.count, 16);

  const tooMany = planFrames(long, { seconds: Array.from({ length: 40 }, (_, i) => i * 20) });
  assert.equal(tooMany.capped, true);
  assert.equal(tooMany.count, MAX_FRAMES);
});

test('cropRgba 从整张图里裁出正确的像素', () => {
  const width = 4;
  const height = 3;
  const data = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 4;
      data[offset] = x * 10;
      data[offset + 1] = y * 10;
      data[offset + 2] = 7;
      data[offset + 3] = 255;
    }
  }
  const cropped = cropRgba({ width, height, data }, { x: 1, y: 1, width: 2, height: 2 });
  assert.equal(cropped.width, 2);
  assert.equal(cropped.height, 2);
  assert.equal(cropped.data.length, 2 * 2 * 4);
  assert.deepEqual([...cropped.data.subarray(0, 4)], [10, 10, 7, 255]);
  assert.deepEqual([...cropped.data.subarray(4, 8)], [20, 10, 7, 255]);
  assert.deepEqual([...cropped.data.subarray(8, 12)], [10, 20, 7, 255]);
});

test('cropRgba 越界时报错而不是返回坏图', () => {
  const decoded = { width: 2, height: 2, data: Buffer.alloc(2 * 2 * 4) };
  assert.throws(() => cropRgba(decoded, { x: 1, y: 1, width: 4, height: 4 }), /越界/);
  assert.throws(() => cropRgba(null, { x: 0, y: 0, width: 1, height: 1 }), /不可用/);
});
