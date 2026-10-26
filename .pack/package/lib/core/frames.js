// 分镜抓帧的纯逻辑：解析 B 站 videoshot（storyboard）数据、挑帧、算格位、裁像素。
// 这里不碰网络、不碰图片库，方便单测；解码/编码在 ./jpeg.js 里，网络在 ./visual.js 里。

/** 单次最多返回多少帧（超过这个数模型的看图预算会失控）。 */
export const MAX_FRAMES = 24;

/**
 * 按视频时长给出"够看懂"的默认帧数。
 * 依据：单帧 480×270 ≈ 170 token；12 帧 ≈ 2k token，与 3600 字字幕同档。
 * @param {number} duration 秒
 * @returns {number}
 */
export function frameCountFor(duration) {
  const d = Number(duration) || 0;
  if (d <= 180) return 6;
  if (d <= 900) return 12;
  if (d <= 2700) return 16;
  return 20;
}

function positiveInt(value, name) {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) throw new Error(`videoshot 数据异常：${name} 不是正整数`);
  return n;
}

function normalizeSheetUrl(raw) {
  const text = String(raw || '').trim();
  if (!text) return '';
  return text.startsWith('//') ? `https:${text}` : text;
}

/**
 * 解析 `/x/player/videoshot` 的 data。
 *
 * 实测（BV1Fdna6mE9W，330s，10×10 网格）：`index` 形如 `0,0,5,10,…,325`，
 * 第一项是占位；真正的时间戳从 `index[1]` 开始，第 k 帧对应 `times[k]`、
 * 也就是第 k 个格子（超出 times 长度的格子是重复填充，不能当独立帧）。
 *
 * @param {any} data 接口返回的 data 字段
 * @returns {{cols:number, rows:number, cellsPerSheet:number, cellWidth:number, cellHeight:number,
 *   sheets:string[], times:number[], step:number, duration:number}}
 */
export function parseStoryboard(data) {
  if (!data || typeof data !== 'object') throw new Error('videoshot 数据为空');
  const cols = positiveInt(data.img_x_len, 'img_x_len');
  const rows = positiveInt(data.img_y_len, 'img_y_len');
  const cellWidth = positiveInt(data.img_x_size, 'img_x_size');
  const cellHeight = positiveInt(data.img_y_size, 'img_y_size');
  const sheets = (Array.isArray(data.image) ? data.image : []).map(normalizeSheetUrl).filter(Boolean);
  if (sheets.length === 0) throw new Error('videoshot 没有返回分镜图片地址');
  const rawIndex = Array.isArray(data.index) ? data.index : [];
  if (rawIndex.length < 2) throw new Error('videoshot 没有返回分镜时间索引');

  const cellsPerSheet = cols * rows;
  const usable = Math.min(rawIndex.length - 1, sheets.length * cellsPerSheet);
  const times = [];
  for (let k = 0; k < usable; k += 1) {
    const t = Number(rawIndex[k + 1]);
    if (!Number.isFinite(t) || t < 0) break;
    times.push(t);
  }
  if (times.length === 0) throw new Error('videoshot 时间索引不可用');
  const step = times.length > 1 ? Math.max(1, Math.round((times[times.length - 1] - times[0]) / (times.length - 1))) : 5;
  return {
    cols,
    rows,
    cellsPerSheet,
    cellWidth,
    cellHeight,
    sheets,
    times,
    step,
    duration: times[times.length - 1] + step,
  };
}

/**
 * 第 k 帧在哪张图的哪个格子里。
 * @param {ReturnType<typeof parseStoryboard>} board
 * @param {number} k 帧序号（0 基）
 */
export function cellRect(board, k) {
  const index = Number(k);
  if (!Number.isInteger(index) || index < 0 || index >= board.times.length) {
    throw new Error(`帧序号越界：${k}（有效范围 0-${board.times.length - 1}）`);
  }
  const sheetIndex = Math.floor(index / board.cellsPerSheet);
  if (sheetIndex >= board.sheets.length) throw new Error(`帧 ${k} 所在的分镜图不存在`);
  const within = index % board.cellsPerSheet;
  return {
    sheetIndex,
    x: (within % board.cols) * board.cellWidth,
    y: Math.floor(within / board.cols) * board.cellHeight,
    width: board.cellWidth,
    height: board.cellHeight,
  };
}

/** 最接近某个时间点的帧序号。 */
export function frameIndexAt(times, second) {
  const target = Math.max(0, Number(second) || 0);
  let best = 0;
  let bestGap = Infinity;
  for (let k = 0; k < times.length; k += 1) {
    const gap = Math.abs(times[k] - target);
    if (gap < bestGap) {
      bestGap = gap;
      best = k;
    }
  }
  return best;
}

/**
 * 规划要抓哪些帧。
 * - 给了 `seconds` 就按时间点就近取，去重、按时间排序；
 * - 只给 `count`（或什么都不给）就按时长均匀铺开。
 * @param {number[]} times 每帧的时间戳
 * @param {{count?:number, seconds?:number[], duration?:number}} [options]
 * @returns {{indices:number[], count:number, capped:boolean}}
 */
export function planFrames(times, options = {}) {
  if (!Array.isArray(times) || times.length === 0) throw new Error('没有可用的帧时间戳');
  const seconds = Array.isArray(options.seconds) ? options.seconds.map(Number).filter((n) => Number.isFinite(n) && n >= 0) : [];
  let indices;
  if (seconds.length > 0) {
    indices = [...new Set(seconds.map((s) => frameIndexAt(times, s)))].sort((a, b) => a - b);
  } else {
    const wanted = Math.min(
      MAX_FRAMES,
      Math.max(1, Math.round(Number(options.count) || frameCountFor(options.duration ?? times[times.length - 1]))),
    );
    if (wanted >= times.length) {
      indices = times.map((_, k) => k);
    } else if (wanted === 1) {
      indices = [0];
    } else {
      indices = [...new Set(Array.from({ length: wanted }, (_, i) => Math.round((i * (times.length - 1)) / (wanted - 1))))];
    }
  }
  const capped = indices.length > MAX_FRAMES;
  if (capped) indices = indices.filter((_, i) => i < MAX_FRAMES);
  return { indices, count: indices.length, capped };
}

/**
 * 从整张分镜图的 RGBA 位图里裁出一格。
 * @param {{width:number, height:number, data:Uint8Array|Buffer}} decoded
 * @param {{x:number,y:number,width:number,height:number}} rect
 * @returns {{width:number, height:number, data:Buffer}}
 */
export function cropRgba(decoded, rect) {
  const { width, height, data } = decoded || {};
  if (!width || !height || !data) throw new Error('分镜位图不可用');
  if (rect.x < 0 || rect.y < 0 || rect.x + rect.width > width || rect.y + rect.height > height) {
    throw new Error(`裁剪区域越界：${rect.width}x${rect.height}@${rect.x},${rect.y} 超出 ${width}x${height}`);
  }
  const out = Buffer.alloc(rect.width * rect.height * 4);
  const rowBytes = rect.width * 4;
  for (let y = 0; y < rect.height; y += 1) {
    const from = ((rect.y + y) * width + rect.x) * 4;
    out.set(data.subarray ? data.subarray(from, from + rowBytes) : data.slice(from, from + rowBytes), y * rowBytes);
  }
  return { width: rect.width, height: rect.height, data: out };
}

/**
 * 一次抓帧的编排：给定分镜板、需要哪些帧、以及取图/解码/编码三个回调，返回帧缓冲区列表。
 * 回调允许外部注入，便于单测与替换实现。
 * @param {ReturnType<typeof parseStoryboard>} board
 * @param {number[]} indices
 * @param {{loadSheet:(sheetIndex:number)=>Promise<{width:number,height:number,data:any}>,
 *   encode:(rgba:{width:number,height:number,data:Buffer})=>Buffer}} io
 * @returns {Promise<Array<{index:number, second:number, buffer:Buffer, width:number, height:number}>>}
 */
export async function renderFrames(board, indices, io) {
  const sheets = new Map();
  const frames = [];
  for (const index of indices) {
    const rect = cellRect(board, index);
    if (!sheets.has(rect.sheetIndex)) sheets.set(rect.sheetIndex, await io.loadSheet(rect.sheetIndex));
    const decoded = sheets.get(rect.sheetIndex);
    const rgba = cropRgba(decoded, rect);
    frames.push({
      index,
      second: board.times[index],
      buffer: io.encode(rgba),
      width: rgba.width,
      height: rgba.height,
    });
  }
  return frames;
}
