/** 文件用途：在图片之上的独立编辑层绘制八点选框，局部预览缩放并提交毫米几何数据。 */
import { useEffect, useRef } from 'react';
import type { CSSProperties, PointerEvent, RefObject } from 'react';
import { geometryFromViewBox, imageViewBox, mmToPixels, resizeHandles, resizeViewBox } from '../../../shared/canvas';
import type { ImageGeometry, ImageObject, ImageViewBox, ResizeHandle } from '../../../shared/canvas';
import type { Orientation } from '../../../shared/framework';

const handles: Record<ResizeHandle, { x: string; y: string; label: string; cursor: string }> = {
  nw: { x: '0%', y: '0%', label: '左上角等比例缩放', cursor: 'nwse-resize' },
  n: { x: '50%', y: '0%', label: '上边调整高度', cursor: 'ns-resize' },
  ne: { x: '100%', y: '0%', label: '右上角等比例缩放', cursor: 'nesw-resize' },
  e: { x: '100%', y: '50%', label: '右边调整长度', cursor: 'ew-resize' },
  se: { x: '100%', y: '100%', label: '右下角等比例缩放', cursor: 'nwse-resize' },
  s: { x: '50%', y: '100%', label: '下边调整高度', cursor: 'ns-resize' },
  sw: { x: '0%', y: '100%', label: '左下角等比例缩放', cursor: 'nesw-resize' },
  w: { x: '0%', y: '50%', label: '左边调整长度', cursor: 'ew-resize' }
};

interface ResizeGesture {
  pointer: number; button: HTMLButtonElement; picture: HTMLElement;
  handle: ResizeHandle; x: number; y: number; start: ImageViewBox; next: ImageViewBox; frame: number | null;
}

/** 应用局部预览样式，不修改 React 页面模型或发起磁盘操作。 */
function paintPicture(element: HTMLElement, geometry: ImageGeometry): void {
  element.style.left = `${geometry.xMm}mm`; element.style.top = `${geometry.yMm}mm`;
  element.style.width = `${geometry.widthMm}mm`; element.style.height = `${geometry.heightMm}mm`;
}

/** 控制点按当前可见方向定义，对象旋转和整页方向通过共享换算转换回基础坐标。 */
export function ImageSelection({ object, orientation, zoom, busy, paper, onResize, onInteraction }: {
  object: ImageObject; orientation: Orientation; zoom: number; busy: boolean; paper: RefObject<HTMLElement | null>;
  onResize: (id: string, geometry: ImageGeometry) => Promise<boolean>; onInteraction: (active: boolean) => void;
}): React.JSX.Element {
  const overlay = useRef<HTMLDivElement>(null);
  const drag = useRef<ResizeGesture | null>(null);
  const box = imageViewBox(object, orientation);

  /** 选框和被选图片一起预览，只有本对象的两个 DOM 节点发生变化。 */
  function paint(current: ResizeGesture, next: ImageViewBox): void {
    if (overlay.current) {
      overlay.current.style.left = `${next.x}mm`; overlay.current.style.top = `${next.y}mm`;
      overlay.current.style.width = `${next.width}mm`; overlay.current.style.height = `${next.height}mm`;
    }
    paintPicture(current.picture, geometryFromViewBox(object, orientation, next));
  }

  /** 先撤销指针捕获再提交；失败或取消均恢复本次拖动前的完整矩形。 */
  function finish(cancel: boolean): void {
    const current = drag.current;
    if (!current) return;
    drag.current = null;
    if (current.frame !== null) cancelAnimationFrame(current.frame);
    if (current.button.hasPointerCapture(current.pointer)) current.button.releasePointerCapture(current.pointer);
    onInteraction(false);
    if (cancel) { paint(current, current.start); return; }
    paint(current, current.next);
    if (['x', 'y', 'width', 'height'].every(key => Math.abs(current.start[key as keyof ImageViewBox] - current.next[key as keyof ImageViewBox]) < 1e-8)) return;
    void onResize(object.id, geometryFromViewBox(object, orientation, current.next)).then(ok => {
      if (!ok) paint(current, current.start);
    }).catch(() => paint(current, current.start));
  }

  useEffect(() => {
    /** Escape 和窗口失焦都取消本次手势，不改变已保存或先前的草稿。 */
    const cancel = (): void => finish(true);
    const keydown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && drag.current) { event.preventDefault(); event.stopPropagation(); cancel(); }
    };
    document.addEventListener('keydown', keydown, true); window.addEventListener('blur', cancel);
    return () => { document.removeEventListener('keydown', keydown, true); window.removeEventListener('blur', cancel); cancel(); };
  }, [object, orientation, zoom]);

  /** 指针捕获后禁止画布缩放、切页及删除，保证本次拖动使用固定视角和查看比例。 */
  function begin(event: PointerEvent<HTMLButtonElement>, handle: ResizeHandle): void {
    if (busy || event.button !== 0 || drag.current) return;
    const picture = Array.from(paper.current?.querySelectorAll<HTMLElement>('[data-object-id]') ?? []).find(item => item.dataset.objectId === object.id);
    if (!picture) return;
    event.preventDefault(); event.stopPropagation();
    event.currentTarget.focus({ preventScroll: true }); event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { pointer: event.pointerId, button: event.currentTarget, picture, handle,
      x: event.clientX, y: event.clientY, start: box, next: box, frame: null };
    onInteraction(true);
  }

  /** 控制点使用可见毫米坐标，不读取 Ctrl；四角锁比例，四边中点只更新一个方向。 */
  function update(event: PointerEvent<HTMLButtonElement>): void {
    const current = drag.current;
    if (!current || current.pointer !== event.pointerId) return;
    const scale = mmToPixels * zoom;
    current.next = resizeViewBox(current.start, current.handle, (event.clientX - current.x) / scale, (event.clientY - current.y) / scale);
    if (current.frame === null) current.frame = requestAnimationFrame(() => {
      if (drag.current === current) paint(current, current.next);
      current.frame = null;
    });
  }

  return <div className="image-selection" data-selection-for={object.id} style={{ left: `${box.x}mm`, top: `${box.y}mm`,
    width: `${box.width}mm`, height: `${box.height}mm`, '--selection-pixel': `${1 / zoom}px` } as CSSProperties} ref={overlay}>
    {resizeHandles.map(handle => <button key={handle} type="button" className="resize-handle" data-resize-handle={handle}
      aria-label={handles[handle].label} title={handles[handle].label} disabled={busy && !drag.current}
      style={{ left: handles[handle].x, top: handles[handle].y, cursor: handles[handle].cursor }}
      onPointerDown={event => begin(event, handle)} onPointerMove={update}
      onPointerUp={event => { if (drag.current?.pointer === event.pointerId) { update(event); finish(false); } }}
      onPointerCancel={() => finish(true)} onLostPointerCapture={() => finish(true)} />)}
  </div>;
}
