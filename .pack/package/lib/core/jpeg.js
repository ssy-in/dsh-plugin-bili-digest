// JPEG 编解码的薄封装。jpeg-js 是纯 JS 实现，不需要 ffmpeg、不需要本机编译。
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
let codec = null;

function loadCodec() {
  if (codec) return codec;
  try {
    codec = require('jpeg-js');
  } catch {
    throw new Error('缺少依赖 jpeg-js：请在插件目录执行 npm install（抓帧需要它把 B 站分镜图裁成单帧）');
  }
  return codec;
}

/** 解码整张分镜图为 RGBA。 */
export function decodeJpeg(buffer) {
  if (!buffer || buffer.length === 0) throw new Error('分镜图数据为空');
  const image = loadCodec().decode(buffer, { useTArray: true, formatAsRGBA: true });
  if (!image || !image.width || !image.height || !image.data) throw new Error('分镜图解码失败');
  return { width: image.width, height: image.height, data: image.data };
}

/** 把一帧 RGBA 编码成 JPEG。 */
export function encodeJpeg(rgba, quality = 82) {
  const { width, height, data } = rgba || {};
  if (!width || !height || !data) throw new Error('帧数据为空');
  const q = Math.max(30, Math.min(95, Math.round(Number(quality) || 82)));
  const encoded = loadCodec().encode({ width, height, data }, q);
  return Buffer.from(encoded.data);
}
