// 抓帧编排：分镜清单 → 挑帧 → 取图 → 解码 → 裁格 → 编码，并把结果落盘备用。
import fs from 'node:fs';
import path from 'node:path';
import { parseStoryboard, planFrames, renderFrames } from './frames.js';
import { decodeJpeg, encodeJpeg } from './jpeg.js';
import { cacheGet, cacheSet, paths } from './store.js';

const BOARD_TTL_MS = 24 * 60 * 60 * 1000;

// 一张分镜图解码后是 4800×2700×4 ≈ 52 MB，所以内存里最多留两张：同一视频的多帧通常共用一张图。
const SHEET_CACHE_MAX = 2;
const SHEET_CACHE = new Map();

/** 清掉分镜解码缓存（测试与内存吃紧时用）。 */
export function clearSheetCache() {
  SHEET_CACHE.clear();
}

async function loadSheetCached(api, url) {
  const hit = SHEET_CACHE.get(url);
  if (hit) return hit;
  const decoded = decodeJpeg(await api.fetchImage(url));
  if (SHEET_CACHE.size >= SHEET_CACHE_MAX) SHEET_CACHE.delete(SHEET_CACHE.keys().next().value);
  SHEET_CACHE.set(url, decoded);
  return decoded;
}

/**
 * 取分镜板（带缓存：分镜清单很小，一天内复用）。
 * @param {ReturnType<import('./api.js').createApi>} api
 * @param {string} bvid
 * @param {number} cid
 */
export async function boardFor(api, bvid, cid, { cache = true } = {}) {
  if (cache) {
    const hit = cacheGet(`sb:${bvid}`, BOARD_TTL_MS);
    if (hit) {
      try {
        return parseStoryboard(hit);
      } catch {
        /* 缓存坏了就重新取 */
      }
    }
  }
  const data = await api.storyboard(bvid, cid);
  if (cache) {
    try {
      cacheSet(`sb:${bvid}`, data);
    } catch {
      /* 缓存失败不影响主流程 */
    }
  }
  return parseStoryboard(data);
}

/**
 * 抓一组帧。
 * @param {ReturnType<import('./api.js').createApi>} api
 * @param {string} bvid
 * @param {{cid:number, duration?:number, count?:number, seconds?:number[], quality?:number, cache?:boolean}} options
 * @returns {Promise<{board:any, plan:{indices:number[],count:number,capped:boolean},
 *   frames:Array<{index:number, second:number, buffer:Buffer, width:number, height:number}>}>}
 */
export async function collectFrames(api, bvid, options = {}) {
  const { cid, duration, count, seconds, quality = 82, cache = true } = options;
  if (!Number.isInteger(Number(cid)) || Number(cid) <= 0) throw new Error('抓帧需要 cid');
  const board = await boardFor(api, bvid, Number(cid), { cache });
  const plan = planFrames(board.times, { count, seconds, duration: duration ?? board.duration });
  const frames = await renderFrames(board, plan.indices, {
    loadSheet: async (sheetIndex) => {
      const url = board.sheets[sheetIndex];
      if (!url) throw new Error(`分镜图缺失：第 ${sheetIndex + 1} 张`);
      return loadSheetCached(api, url);
    },
    encode: (rgba) => encodeJpeg(rgba, quality),
  });
  return { board, plan, frames };
}

/**
 * 没有附件服务（或纯 CLI 场景）时，把帧写到磁盘并返回路径。
 * @param {string} bvid
 * @param {Array<{second:number, buffer:Buffer}>} frames
 * @returns {{dir:string, files:Array<{second:number, file:string}>}}
 */
export function saveFrames(bvid, frames) {
  const dir = path.join(paths().frames, bvid);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const files = frames.map((frame) => {
    const name = `${String(Math.round(frame.second)).padStart(6, '0')}s.jpg`;
    const file = path.join(dir, name);
    fs.writeFileSync(file, frame.buffer, { mode: 0o600 });
    return { second: frame.second, file };
  });
  return { dir, files };
}
