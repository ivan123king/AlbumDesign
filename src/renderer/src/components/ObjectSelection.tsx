/** 文件用途：图片和文字共用跟随角度的选框，局部预览四角/八点缩放与中心自由旋转。 */
import { useEffect, useRef, useState } from 'react';
import type { CSSProperties, PointerEvent, RefObject } from 'react';
import { normalizeAngle, objectView, resizeHandles, resizeObjectGeometry } from '../../../shared/canvas';
import type { CanvasObject, ObjectGeometry, ResizeHandle } from '../../../shared/canvas';
import type { Orientation } from '../../../shared/framework';

const handles: Record<ResizeHandle, { x: string; y: string; label: string; cursor: string }> = {
  nw: { x: '0%', y: '0%', label: '左上角等比例缩放', cursor: 'nwse-resize' },
  n: { x: '50%', y: '0%', label: '上边调整大小', cursor: 'ns-resize' },
  ne: { x: '100%', y: '0%', label: '右上角等比例缩放', cursor: 'nesw-resize' },
  e: { x: '100%', y: '50%', label: '右边调整大小', cursor: 'ew-resize' },
  se: { x: '100%', y: '100%', label: '右下角等比例缩放', cursor: 'nwse-resize' },
  s: { x: '50%', y: '100%', label: '下边调整大小', cursor: 'ns-resize' },
  sw: { x: '0%', y: '100%', label: '左下角等比例缩放', cursor: 'nesw-resize' },
  w: { x: '0%', y: '50%', label: '左边调整大小', cursor: 'ew-resize' }
};

/** 缩放光标随对象的可见角度调整到最近的 45°方向。 */
function handleCursor(handle: ResizeHandle, angle: number): string {
  const base = handles[handle].cursor === 'ew-resize' ? 0 : handles[handle].cursor === 'ns-resize' ? 90
    : handles[handle].cursor === 'nwse-resize' ? 45 : 135;
  return ['ew-resize', 'nwse-resize', 'ns-resize', 'nesw-resize'][Math.round(normalizeAngle(base + angle) / 45) % 4]!;
}

interface Gesture {
  pointer: number; button: HTMLButtonElement; element: HTMLElement; kind: ResizeHandle | 'rotate';
  x: number; y: number; centerX: number; centerY: number; pointerAngle: number; accumulated: number;
  next: ObjectGeometry & { rotation: number }; frame: number | null;
}

/** 只改变当前对象及文字显示比例，不触发 React 整页刷新。 */
export function paintObject(element: HTMLElement, object: CanvasObject, geometry: ObjectGeometry, rotation = object.rotation): void {
  element.style.left = `${geometry.xMm}mm`; element.style.top = `${geometry.yMm}mm`;
  element.style.width = `${geometry.widthMm}mm`; element.style.height = `${geometry.heightMm}mm`;
  element.style.transform = `rotate(${rotation}deg)`;
  if (object.kind === 'text') element.style.setProperty('--text-scale', String(geometry.widthMm / object.layoutWidthMm));
}

/** 选框与对象中心重合并随对象旋转，顶部旋转钮与顶边缩放圆点分开。 */
export function ObjectSelection({ object, orientation, zoom, busy, paper, onResize, onRotate, onInteraction }: {
  object: CanvasObject; orientation: Orientation; zoom: number; busy: boolean; paper: RefObject<HTMLElement | null>;
  onResize: (id: string, geometry: ObjectGeometry) => Promise<boolean>;
  onRotate: (id: string, angle: number) => Promise<boolean>; onInteraction: (active: boolean) => void;
}): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null);
  const drag = useRef<Gesture | null>(null);
  const [angle, setAngle] = useState<number | null>(null);
  const view = objectView(object, orientation);

  /** 根据基础几何数据更新两个节点，角度是对象自身角度，不包含整页方向。 */
  function paint(current: Gesture, next: Gesture['next']): void {
    const nextView = objectView({ ...object, ...next }, orientation);
    if (ref.current) {
      ref.current.style.left = `${nextView.x}mm`; ref.current.style.top = `${nextView.y}mm`;
      ref.current.style.width = `${next.widthMm}mm`; ref.current.style.height = `${next.heightMm}mm`;
      ref.current.style.transform = `translate(-50%, -50%) rotate(${nextView.angle}deg)`;
    }
    paintObject(current.element, object, next, next.rotation);
    if (current.kind === 'rotate') setAngle(normalizeAngle(next.rotation));
  }

  /** 松手才更新主进程草稿；Escape、失焦或捕获丢失恢复起始状态。 */
  function finish(cancel: boolean): void {
    const current = drag.current;
    if (!current) return;
    drag.current = null;
    if (current.frame !== null) cancelAnimationFrame(current.frame);
    if (current.button.hasPointerCapture(current.pointer)) current.button.releasePointerCapture(current.pointer);
    onInteraction(false); setAngle(null);
    const restore = (): void => { paint(current, object); setAngle(null); };
    if (cancel) { restore(); return; }
    const next = current.next;
    if (['xMm', 'yMm', 'widthMm', 'heightMm', 'rotation'].every(key => Math.abs(next[key as keyof typeof next] - object[key as keyof typeof next]) < 1e-8)) return;
    const operation = current.kind === 'rotate' ? onRotate(object.id, normalizeAngle(next.rotation)) : onResize(object.id, next);
    void operation.then(ok => { if (!ok) restore(); }).catch(restore);
  }

  useEffect(() => {
    const cancel = (): void => finish(true);
    const keydown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && drag.current) { event.preventDefault(); event.stopPropagation(); cancel(); }
    };
    document.addEventListener('keydown', keydown, true); window.addEventListener('blur', cancel);
    return () => { document.removeEventListener('keydown', keydown, true); window.removeEventListener('blur', cancel); cancel(); };
  }, [object, orientation, zoom]);

  /** 指针中心从屏幕矩形取得；鼠标按住后允许跨越 0° 连续转动，不依赖横向像素猜角度。 */
  function begin(event: PointerEvent<HTMLButtonElement>, kind: Gesture['kind']): void {
    if (busy || event.button !== 0 || drag.current || !ref.current) return;
    const element = Array.from(paper.current?.querySelectorAll<HTMLElement>('[data-object-id]') ?? []).find(item => item.dataset.objectId === object.id);
    if (!element) return;
    event.preventDefault(); event.stopPropagation();
    event.currentTarget.focus({ preventScroll: true }); event.currentTarget.setPointerCapture(event.pointerId);
    const bounds = ref.current.getBoundingClientRect();
    const centerX = bounds.left + bounds.width / 2; const centerY = bounds.top + bounds.height / 2;
    drag.current = { pointer: event.pointerId, button: event.currentTarget, element, kind,
      x: event.clientX, y: event.clientY, centerX, centerY,
      pointerAngle: Math.atan2(event.clientY - centerY, event.clientX - centerX) * 180 / Math.PI, accumulated: 0,
      next: { xMm: object.xMm, yMm: object.yMm, widthMm: object.widthMm, heightMm: object.heightMm, rotation: object.rotation }, frame: null };
    onInteraction(true);
  }

  /** 四角保持比例，文字不提供边点；自由旋转只改变角度，中心与大小保持。 */
  function update(event: PointerEvent<HTMLButtonElement>): void {
    const current = drag.current;
    if (!current || current.pointer !== event.pointerId) return;
    if (current.kind === 'rotate') {
      if (Math.hypot(event.clientX - current.centerX, event.clientY - current.centerY) < 2) return;
      const nextAngle = Math.atan2(event.clientY - current.centerY, event.clientX - current.centerX) * 180 / Math.PI;
      current.accumulated += ((nextAngle - current.pointerAngle + 540) % 360) - 180;
      current.pointerAngle = nextAngle;
      current.next.rotation = object.rotation + current.accumulated;
    } else current.next = { ...resizeObjectGeometry(object, current.kind, event.clientX - current.x, event.clientY - current.y, zoom, orientation), rotation: object.rotation };
    if (current.frame === null) current.frame = requestAnimationFrame(() => { if (drag.current === current) paint(current, current.next); current.frame = null; });
  }

  /** 控件事件共用，避免旋转按钮误触图片移动或画布取消选中。 */
  function events(kind: Gesture['kind']) {
    return { onPointerDown: (event: PointerEvent<HTMLButtonElement>) => begin(event, kind), onPointerMove: update,
      onPointerUp: (event: PointerEvent<HTMLButtonElement>) => { if (drag.current?.pointer === event.pointerId) { update(event); finish(false); } },
      onPointerCancel: () => finish(true), onLostPointerCapture: () => finish(true) };
  }

  return <div className="object-selection" data-selection-for={object.id} ref={ref} style={{ left: `${view.x}mm`, top: `${view.y}mm`,
    width: `${object.widthMm}mm`, height: `${object.heightMm}mm`, transform: `translate(-50%, -50%) rotate(${view.angle}deg)`,
    '--selection-pixel': `${1 / zoom}px` } as CSSProperties}>
    {resizeHandles.filter(handle => object.kind === 'image' || handle.length === 2).map(handle => <button key={handle} type="button" className="resize-handle"
      data-resize-handle={handle} aria-label={handles[handle].label} title={handles[handle].label} aria-disabled={busy}
      style={{ left: handles[handle].x, top: handles[handle].y, cursor: handleCursor(handle, view.angle) }} {...events(handle)} />)}
    <span className="rotation-stem" aria-hidden="true" /><button type="button" className="rotation-handle" data-rotation-handle aria-label="按住拖动旋转" title="按住拖动旋转"
      aria-disabled={busy} {...events('rotate')}>↻</button>
    {angle !== null && <output className="rotation-angle">{angle.toFixed(1)}°</output>}
  </div>;
}
