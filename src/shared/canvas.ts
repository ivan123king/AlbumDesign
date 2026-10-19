/** 文件用途：定义页面与图片/文字联合模型、固定文字排版区及任意角度的毫米坐标换算。 */
import type { Orientation } from './framework';

export interface ObjectGeometry {
  xMm: number;
  yMm: number;
  widthMm: number;
  heightMm: number;
}

export interface ObjectBase extends ObjectGeometry {
  id: string;
  /** 仅用于管理的自定义名称；缺省时显示来源文件名或文字摘要。 */
  displayName?: string;
  rotation: number;
  zIndex: number;
}

export interface ImageObject extends ObjectBase {
  kind: 'image';
  fileName: string;
  sourceName: string;
}

export type WritingMode = 'horizontal' | 'vertical';
/** 浏览器按实际字体测得的内容边界，单位毫米；与排版区分离以免收紧后重新换行。 */
export interface TextContentBounds { xMm: number; yMm: number; widthMm: number; heightMm: number }
export interface TextDraft {
  text: string;
  writingMode: WritingMode;
  fontFamily: string;
  fontSizePt: number;
  color: string;
  letterSpacingPt: number;
  lineSpacing: number;
  columns: number;
  columnGapMm: number;
  widthMm: number;
  heightMm: number;
  contentBounds?: TextContentBounds;
}

/** 固定排版区域与最终显示尺寸分开，等比缩放只改变后者，不重新换行或换列。 */
export interface TextObject extends ObjectBase, Omit<TextDraft, 'widthMm' | 'heightMm'> {
  kind: 'text';
  layoutWidthMm: number;
  layoutHeightMm: number;
}

/** 旧文字沿用整个排版区；新文字以内容边界为基础尺寸，缩放不改变排版。 */
export function textBaseSize(object: TextObject): { widthMm: number; heightMm: number } {
  return object.contentBounds ?? { widthMm: object.layoutWidthMm, heightMm: object.layoutHeightMm };
}

export type CanvasObject = ImageObject | TextObject;
export interface TextFont { family: string; label: string; available: boolean }

/** 所有对象均使用竖向 A4 基础坐标；orientation 只控制整页编辑视角。 */
export interface CanvasDocument {
  formatVersion: 1 | 2;
  widthMm: 210;
  heightMm: 297;
  orientation: Orientation;
  nextImageNumber: number;
  objects: CanvasObject[];
}

export interface CanvasSnapshot {
  pageId: string;
  document: CanvasDocument;
  dirty: boolean;
  warnings: string[];
}

export type ImageGeometry = ObjectGeometry;
export interface ImageViewBox { x: number; y: number; width: number; height: number }
export type ResizeHandle = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w';
export const resizeHandles: readonly ResizeHandle[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];

export const assetDragType = 'application/x-album-asset';
export const textDragType = 'application/x-album-text';
export const mmToPixels = 96 / 25.4;

/** 保存角度归一化，避免跨过 0° 时丢失旋转方向；预览可使用连续角度。 */
export function normalizeAngle(angle: number): number { return ((angle % 360) + 360) % 360; }

/** 二维向量按顺时针角度旋转，屏幕与纸张的 y 轴都向下。 */
export function rotateVector(x: number, y: number, angle: number): { x: number; y: number } {
  const radians = angle * Math.PI / 180;
  return { x: x * Math.cos(radians) - y * Math.sin(radians), y: x * Math.sin(radians) + y * Math.cos(radians) };
}

/** 当前视角的对象中心及角度，供独立选框使用；长宽始终是对象自身尺寸。 */
export function objectView(object: ObjectBase, orientation: Orientation): { x: number; y: number; angle: number } {
  const cx = object.xMm + object.widthMm / 2;
  const cy = object.yMm + object.heightMm / 2;
  return { x: orientation === 'portrait' ? cx : cy, y: orientation === 'portrait' ? cy : 210 - cx,
    angle: object.rotation - (orientation === 'landscape' ? 90 : 0) };
}

/** 名称不作为文件路径；界面、IPC 与读盘共用长度及控制字符校验。 */
export function objectNameError(value: unknown): string | null {
  return typeof value !== 'string' || !value.trim() || value.length > 120 || /[\u0000-\u001f\u007f]/u.test(value)
    ? '对象名称需为 1～120 个字符，不能包含换行或控制字符。' : null;
}

/** 默认名称随来源或正文生成，不写入自定义字段，便于恢复默认。 */
export function defaultObjectLabel(object: CanvasObject): string {
  return object.kind === 'image' ? object.sourceName : `${object.writingMode === 'horizontal' ? '横排' : '竖排'}文字：${object.text.replace(/\s+/gu, ' ').slice(0, 28)}`;
}

/** 所有管理界面优先使用自定义名称，文字不消耗图片文件编号。 */
export function objectLabel(object: CanvasObject): string {
  return object.displayName ?? defaultObjectLabel(object);
}

/** 对象自身尺寸以中心为锚点调整；文字比例由主进程再次校验。 */
export function centeredGeometry(object: ObjectBase, widthMm: number, heightMm: number): ObjectGeometry {
  return { xMm: object.xMm + (object.widthMm - widthMm) / 2, yMm: object.yMm + (object.heightMm - heightMm) / 2, widthMm, heightMm };
}

/** 屏幕位移依次撤销查看比例、整页旋转及对象旋转，固定对象局部的对角或对边。 */
export function resizeObjectGeometry(object: ObjectBase, handle: ResizeHandle, dx: number, dy: number, zoom: number, orientation: Orientation): ObjectGeometry {
  const paper = screenDeltaToPaper(dx, dy, zoom, orientation);
  const local = rotateVector(paper.x, paper.y, -object.rotation);
  const next = resizeViewBox({ x: 0, y: 0, width: object.widthMm, height: object.heightMm }, handle, local.x, local.y);
  const shift = rotateVector(next.x + (next.width - object.widthMm) / 2, next.y + (next.height - object.heightMm) / 2, object.rotation);
  return { xMm: object.xMm + object.widthMm / 2 + shift.x - next.width / 2,
    yMm: object.yMm + object.heightMm / 2 + shift.y - next.height / 2, widthMm: next.width, heightMm: next.height };
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
    width = Math.max(1, Math.min(100000, width * scale)); height = Math.max(1, Math.min(100000, height * scale));
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
