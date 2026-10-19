/** 文件用途：以 HTML/CSS 绘制当前页，接收素材拖放并独立处理图片移动帧。 */
import { memo, useEffect, useRef, useState } from 'react';
import type { PointerEvent } from 'react';
import { assetDragType, imageViewBox, screenDeltaToPaper } from '../../../shared/canvas';
import type { CanvasSnapshot, ImageGeometry, ImageObject } from '../../../shared/canvas';
import type { Orientation } from '../../../shared/framework';
import { ImageSelection } from './ImageSelection';

interface PictureProps {
  object: ImageObject;
  albumId: string;
  pageId: string;
  orientation: Orientation;
  zoom: number;
  selected: boolean;
  busy: boolean;
  onSelect: (id: string | null) => void;
  onMove: (id: string, xMm: number, yMm: number) => void;
}

/** 拖动帧只更新本图片 DOM；松手才提交基础坐标，取消则恢复，不刷新整页树。 */
const CanvasPicture = memo(function CanvasPicture({ object, albumId, pageId, orientation, zoom, selected, busy, onSelect, onMove }: PictureProps): React.JSX.Element {
  const element = useRef<HTMLDivElement>(null);
  const drag = useRef<{ pointer: number; x: number; y: number; nextX: number; nextY: number; frame: number | null } | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => () => { if (drag.current?.frame) cancelAnimationFrame(drag.current.frame); }, []);
  useEffect(() => { setFailed(false); }, [object.id]);

  /** 独立选框随移动预览平移，选择底层图片时也不改变真实图片叠层。 */
  function paintPosition(xMm: number, yMm: number): void {
    if (!element.current) return;
    element.current.style.left = `${xMm}mm`; element.current.style.top = `${yMm}mm`;
    const selection = element.current.closest('.canvas-view')?.querySelector<HTMLElement>('[data-selection-for]');
    if (selection?.dataset.selectionFor === object.id) {
      const box = imageViewBox({ ...object, xMm, yMm }, orientation);
      selection.style.left = `${box.x}mm`; selection.style.top = `${box.y}mm`;
    }
  }

  /** 指针捕获保证拖出页面边界仍能结束，查看缩放与横版旋转通过同一换算处理。 */
  function begin(event: PointerEvent<HTMLDivElement>): void {
    if (busy || event.button !== 0 || drag.current) return;
    event.preventDefault(); event.stopPropagation();
    // 越界图片获取焦点时不滚动画布，选中本身不能改变纸张内的显示位置。
    onSelect(object.id); event.currentTarget.focus({ preventScroll: true });
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { pointer: event.pointerId, x: event.clientX, y: event.clientY, nextX: object.xMm, nextY: object.yMm, frame: null };
  }

  /** 坐标先反变换，再按毫米更新元素，不修改原始对象尺寸或角度。 */
  function update(event: PointerEvent<HTMLDivElement>): void {
    const current = drag.current;
    if (!current || current.pointer !== event.pointerId) return;
    const delta = screenDeltaToPaper(event.clientX - current.x, event.clientY - current.y, zoom, orientation);
    current.nextX = object.xMm + delta.x; current.nextY = object.yMm + delta.y;
    if (current.frame === null) current.frame = requestAnimationFrame(() => {
      if (element.current && drag.current === current) {
        paintPosition(current.nextX, current.nextY);
      }
      current.frame = null;
    });
  }

  /** 松手使用最终指针位置，防止最后一帧尚未绘制导致位移丢失。 */
  function end(event: PointerEvent<HTMLDivElement>, cancel = false): void {
    if (!drag.current || drag.current.pointer !== event.pointerId) return;
    if (!cancel) update(event);
    const current = drag.current;
    if (current.frame !== null) cancelAnimationFrame(current.frame);
    drag.current = null;
    paintPosition(object.xMm, object.yMm);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    if (!cancel && (Math.abs(current.nextX - object.xMm) > 0.001 || Math.abs(current.nextY - object.yMm) > 0.001)) {
      onMove(object.id, current.nextX, current.nextY);
    }
  }

  return <div className={`canvas-picture ${selected ? 'is-selected' : ''}`} ref={element} data-object-id={object.id}
    role="button" tabIndex={0} aria-label={`图片：${object.sourceName}`} aria-pressed={selected}
    style={{ left: `${object.xMm}mm`, top: `${object.yMm}mm`, width: `${object.widthMm}mm`, height: `${object.heightMm}mm`,
      transform: `rotate(${object.rotation}deg)`, zIndex: object.zIndex + 1 }}
    onPointerDown={begin} onPointerMove={update} onPointerUp={event => end(event)}
    onPointerCancel={event => end(event, true)} onLostPointerCapture={event => { if (drag.current) end(event, true); }}
    onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onSelect(object.id); } }}>
    <img src={`album-page://image/${albumId}/${pageId}/${object.id}`} alt={object.sourceName} draggable={false} onError={() => setFailed(true)} />
    {failed && <div className="image-missing">图片无法加载<br />{object.fileName}</div>}
  </div>;
});

/** 只挂载当前页；横版整页逆时针旋转，基础坐标和对象自身角度保持独立。 */
export function CanvasEditor({ canvas, albumId, zoom, busy, selectedId, onSelect, onMove, onResize, onInteraction, onDropAsset, onMessage }: {
  canvas: CanvasSnapshot; albumId: string; zoom: number; busy: boolean; selectedId: string | null;
  onSelect: (id: string | null) => void; onMove: (id: string, x: number, y: number) => void;
  onDropAsset: (path: string) => void; onMessage: (message: string) => void;
  onResize: (id: string, geometry: ImageGeometry) => Promise<boolean>; onInteraction: (active: boolean) => void;
}): React.JSX.Element {
  const [over, setOver] = useState(false);
  const paper = useRef<HTMLElement>(null);
  const document = canvas.document;
  const selected = document.objects.find(object => object.id === selectedId);
  return <><section ref={paper} className={`paper editable-paper ${over ? 'drop-active' : ''}`} data-paper data-page-id={canvas.pageId}
    data-orientation={document.orientation} aria-label="当前画布" style={{ width: '210mm', height: '297mm',
      transform: document.orientation === 'landscape' ? 'translateY(210mm) rotate(-90deg)' : undefined }}
    onPointerDown={() => { if (!busy) onSelect(null); }}
    onDragOver={event => {
      if (!busy && event.dataTransfer.types.includes(assetDragType)) { event.preventDefault(); event.dataTransfer.dropEffect = 'copy'; setOver(true); }
    }} onDragLeave={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOver(false); }}
    onDrop={event => {
      event.preventDefault(); setOver(false);
      if (busy) return;
      try {
        const payload = JSON.parse(event.dataTransfer.getData(assetDragType)) as { albumId: string; assetPath: string };
        if (payload.albumId !== albumId || typeof payload.assetPath !== 'string') throw new Error();
        onDropAsset(payload.assetPath);
      } catch { onMessage('请从当前画册左侧拖入一张图片素材。'); }
    }}>
    {!document.objects.length && <div className="canvas-empty"><span aria-hidden="true">▧</span><p>从左侧拖入图片</p><small>图片将等比例适应画布并居中</small></div>}
    {document.objects.map(object => <CanvasPicture key={object.id} object={object} albumId={albumId} pageId={canvas.pageId}
      orientation={document.orientation} zoom={zoom} selected={selectedId === object.id} busy={busy} onSelect={onSelect} onMove={onMove} />)}
  </section>{selected && <ImageSelection key={selected.id} object={selected} orientation={document.orientation} zoom={zoom}
    busy={busy} paper={paper} onResize={onResize} onInteraction={onInteraction} />}</>;
}
