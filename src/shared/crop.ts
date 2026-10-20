/** 文件用途：定义图片裁剪契约、统一形状路径及预览/后台成品共用的像素绘制规则。 */
export type CropShape = 'rectangle' | 'ellipse' | 'heart';
/** 中心和长宽相对原图归一化；角度按原图像素坐标旋转，与画布对象角度无关。 */
export interface CropSettings { shape: CropShape; cx: number; cy: number; width: number; height: number; angle: number; inverse: boolean }
export type CropTarget = { kind: 'asset'; albumId: string; path: string }
  | { kind: 'page'; albumId: string; pageId: string; objectId: string };
export interface CropSource { token: string; url: string; width: number; height: number }
export interface CropBounds { x: number; y: number; width: number; height: number }

/** 路径均占据 0～1 的控制框；心形允许边中点拉伸，八点规则对所有形状一致。 */
export function cropShapePath(shape: CropShape): string {
  if (shape === 'ellipse') return 'M 1 .5 A .5 .5 0 1 0 0 .5 A .5 .5 0 1 0 1 .5 Z';
  if (shape === 'heart') return 'M .5 1 C .42 .88 0 .60 0 .27 C 0 -.02 .34 -.09 .5 .16 C .66 -.09 1 -.02 1 .27 C 1 .60 .58 .88 .5 1 Z';
  return 'M 0 0 H 1 V 1 H 0 Z';
}

/** IPC 边界与绘制共用校验，拒绝无效数值、空裁剪框及不支持的形状。 */
export function validateCrop(crop: CropSettings): void {
  if (!crop || !['rectangle', 'ellipse', 'heart'].includes(crop.shape) || typeof crop.inverse !== 'boolean'
    || ![crop.cx, crop.cy, crop.width, crop.height, crop.angle].every(Number.isFinite)
    || crop.cx < 0 || crop.cx > 1 || crop.cy < 0 || crop.cy > 1 || crop.width <= 0 || crop.width > 1
    || crop.height <= 0 || crop.height > 1 || Math.abs(crop.angle) > 360000) throw new Error('裁剪形状或范围无效。');
}

/** 普通裁剪收紧到旋转控制框的像素外接范围，反向裁剪保留原图边界。 */
export function cropPixelBounds(crop: CropSettings, width: number, height: number): CropBounds {
  validateCrop(crop);
  if (crop.inverse) return { x: 0, y: 0, width, height };
  const angle = crop.angle * Math.PI / 180;
  const w = Math.abs(Math.cos(angle)) * crop.width * width + Math.abs(Math.sin(angle)) * crop.height * height;
  const h = Math.abs(Math.sin(angle)) * crop.width * width + Math.abs(Math.cos(angle)) * crop.height * height;
  const x = Math.max(0, Math.floor(crop.cx * width - w / 2));
  const y = Math.max(0, Math.floor(crop.cy * height - h / 2));
  return { x, y, width: Math.max(1, Math.min(width, Math.ceil(crop.cx * width + w / 2)) - x),
    height: Math.max(1, Math.min(height, Math.ceil(crop.cy * height + h / 2)) - y) };
}

/** 无外部依赖，便于在沙箱后台执行同一绘制函数；透明像素保留，失败不修改源文件。 */
export function renderCrop(image: CanvasImageSource, width: number, height: number, crop: CropSettings,
  bounds: CropBounds, path: string, maxEdge: number): HTMLCanvasElement {
  const scale = Math.min(1, maxEdge / Math.max(bounds.width, bounds.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(bounds.width * scale)); canvas.height = Math.max(1, Math.round(bounds.height * scale));
  const context = canvas.getContext('2d');
  if (!context) throw new Error('无法生成裁剪图片。');
  context.scale(canvas.width / bounds.width, canvas.height / bounds.height);
  context.translate(-bounds.x, -bounds.y);
  context.drawImage(image, 0, 0, width, height);
  context.globalCompositeOperation = crop.inverse ? 'destination-out' : 'destination-in';
  // 先在独立透明蒙版绘制轮廓，再整张合成；destination-in 的路径外部也必须清空。
  const mask = document.createElement('canvas'); mask.width = canvas.width; mask.height = canvas.height;
  const maskContext = mask.getContext('2d');
  if (!maskContext) throw new Error('无法生成裁剪蒙版。');
  maskContext.scale(canvas.width / bounds.width, canvas.height / bounds.height);
  maskContext.translate(crop.cx * width - bounds.x, crop.cy * height - bounds.y);
  maskContext.rotate(crop.angle * Math.PI / 180);
  maskContext.scale(crop.width * width, crop.height * height); maskContext.translate(-.5, -.5);
  maskContext.fill(new Path2D(path));
  context.setTransform(1, 0, 0, 1, 0, 0); context.drawImage(mask, 0, 0);
  mask.width = 0; mask.height = 0;
  return canvas;
}
