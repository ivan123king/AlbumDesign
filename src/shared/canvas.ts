/** 文件用途：定义正式页面、图片对象及毫米基础坐标与编辑视角的换算。 */
import type { Orientation } from './framework';

export interface ImageObject {
  id: string;
  kind: 'image';
  fileName: string;
  sourceName: string;
  xMm: number;
  yMm: number;
  widthMm: number;
  heightMm: number;
  rotation: 0 | 90 | 180 | 270;
  zIndex: number;
}

/** 所有对象均使用竖向 A4 基础坐标；orientation 只控制整页编辑视角。 */
export interface CanvasDocument {
  formatVersion: 1;
  widthMm: 210;
  heightMm: 297;
  orientation: Orientation;
  nextImageNumber: number;
  objects: ImageObject[];
}

export interface CanvasSnapshot {
  pageId: string;
  document: CanvasDocument;
  dirty: boolean;
  warnings: string[];
}

export type ImageGeometry = Pick<ImageObject, 'xMm' | 'yMm' | 'widthMm' | 'heightMm'>;
export interface ImageViewBox { x: number; y: number; width: number; height: number }
export type ResizeHandle = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w';
export const resizeHandles: readonly ResizeHandle[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];

export const assetDragType = 'application/x-album-asset';
export const mmToPixels = 96 / 25.4;

/** 对象角度与整页视角合并后，仅 90°/270°交换可见宽高；不改写对象自身角度。 */
function swapsViewAxes(object: ImageObject, orientation: Orientation): boolean {
  return (object.rotation + (orientation === 'landscape' ? 270 : 0)) % 180 !== 0;
}

/** 返回当前画布视角中的外接矩形，单位毫米，用于控制点与尺寸对话框。 */
export function imageViewBox(object: ImageObject, orientation: Orientation): ImageViewBox {
  const cx = object.xMm + object.widthMm / 2;
  const cy = object.yMm + object.heightMm / 2;
  const swapped = swapsViewAxes(object, orientation);
  const width = swapped ? object.heightMm : object.widthMm;
  const height = swapped ? object.widthMm : object.heightMm;
  const centerX = orientation === 'portrait' ? cx : cy;
  const centerY = orientation === 'portrait' ? cy : 210 - cx;
  return { x: centerX - width / 2, y: centerY - height / 2, width, height };
}

/** 可见矩形反算为竖向基础坐标；图片角度及文件引用保持原值。 */
export function geometryFromViewBox(object: ImageObject, orientation: Orientation, box: ImageViewBox): ImageGeometry {
  const swapped = swapsViewAxes(object, orientation);
  const widthMm = swapped ? box.height : box.width;
  const heightMm = swapped ? box.width : box.height;
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  return { xMm: (orientation === 'portrait' ? cx : 210 - cy) - widthMm / 2,
    yMm: (orientation === 'portrait' ? cy : cx) - heightMm / 2, widthMm, heightMm };
}

/** 八点缩放：角点沿原矩形对角线投影并锁比例，边点仅改变对应轴，对角/对边固定。 */
export function resizeViewBox(box: ImageViewBox, handle: ResizeHandle, dx: number, dy: number): ImageViewBox {
  const sx = handle.includes('e') ? 1 : handle.includes('w') ? -1 : 0;
  const sy = handle.includes('s') ? 1 : handle.includes('n') ? -1 : 0;
  let width = box.width;
  let height = box.height;
  if (sx && sy) {
    const scale = Math.max(Math.max(1 / width, 1 / height), Math.min(Math.min(100000 / width, 100000 / height),
      1 + (sx * width * dx + sy * height * dy) / (width * width + height * height)));
    width *= scale; height *= scale;
  } else {
    if (sx) width = Math.max(1, Math.min(100000, width + sx * dx));
    if (sy) height = Math.max(1, Math.min(100000, height + sy * dy));
  }
  return { x: sx < 0 ? box.x + box.width - width : box.x,
    y: sy < 0 ? box.y + box.height - height : box.y, width, height };
}

/** 浏览器像素位移先除查看比例；横版视角逆时针 90°，故反变换为 (-dy, dx)。 */
export function screenDeltaToPaper(dx: number, dy: number, zoom: number, orientation: Orientation): { x: number; y: number } {
  const scale = mmToPixels * zoom;
  return orientation === 'portrait' ? { x: dx / scale, y: dy / scale } : { x: -dy / scale, y: dx / scale };
}

/** 横版新图片以顺时针 90°作为初始对象角度，在横版阅读视角中保持照片朝向。 */
export function fitImage(width: number, height: number, orientation: Orientation): Pick<ImageObject, 'xMm' | 'yMm' | 'widthMm' | 'heightMm' | 'rotation'> {
  const landscape = orientation === 'landscape';
  const ratio = Math.min((landscape ? 297 : 210) / width, (landscape ? 210 : 297) / height);
  const widthMm = width * ratio;
  const heightMm = height * ratio;
  return { xMm: (210 - widthMm) / 2, yMm: (297 - heightMm) / 2, widthMm, heightMm, rotation: landscape ? 90 : 0 };
}
