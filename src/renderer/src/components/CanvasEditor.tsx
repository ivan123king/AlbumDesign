/** 文件用途：绘制当前页图片与真实文字，处理素材/文字入口拖放和局部移动预览。 */
import { memo, useEffect, useRef, useState } from 'react';
import type { CSSProperties, PointerEvent } from 'react';
import { assetDragType, mmToPixels, objectLabel, objectView, textBaseSize, screenDeltaToPaper, textDragType } from '../../../shared/canvas';
import type { CanvasObject, CanvasSnapshot, ObjectGeometry, TextObject, WritingMode } from '../../../shared/canvas';
import type { Orientation } from '../../../shared/framework';
import { ObjectSelection } from './ObjectSelection';
import { TextContent } from './TextContent';

interface ItemProps {
  object: CanvasObject; albumId: string; pageId: string; orientation: Orientation; zoom: number;
  selected: boolean; busy: boolean;
  onSelect: (id: string | null) => void; onMove: (id: string, x: number, y: number) => void;
  onEditText: (object: TextObject) => void; onInteraction: (active: boolean) => void;
}

/** 图片与文字共享移动行为；每帧只更新本对象和选框，单击的微小抖动不算拖动。 */
const CanvasItem = memo(function CanvasItem({ object, albumId, pageId, orientation, zoom, selected, busy, onSelect, onMove, onEditText, onInteraction }: ItemProps): React.JSX.Element {
  const element = useRef<HTMLDivElement>(null);
  const drag = useRef<{ pointer: number; x: number; y: number; nextX: number; nextY: number; moved: boolean; frame: number | null } | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => () => { if (drag.current?.frame) cancelAnimationFrame(drag.current.frame); if (drag.current) onInteraction(false); }, []);

  /** 选框按中心定位并保留角度，任意角度的对象移动后仍与选框一致。 */
  function paint(xMm: number, yMm: number): void {
    if (!element.current) return;
    element.current.style.left = `${xMm}mm`; element.current.style.top = `${yMm}mm`;
    const overlay = element.current.closest('.canvas-view')?.querySelector<HTMLElement>('[data-selection-for]');
    if (overlay?.dataset.selectionFor === object.id) {
      const view = objectView({ ...object, xMm, yMm }, orientation);
      overlay.style.left = `${view.x}mm`; overlay.style.top = `${view.y}mm`;
    }
  }

  /** 焦点不滚动画布，指针捕获允许移动到纸张外，整页查看参数在手势内固定。 */
  function begin(event: PointerEvent<HTMLDivElement>): void {
    if (busy || event.button !== 0 || drag.current) return;
    event.preventDefault(); event.stopPropagation(); onSelect(object.id);
    event.currentTarget.focus({ preventScroll: true }); event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { pointer: event.pointerId, x: event.clientX, y: event.clientY, nextX: object.xMm, nextY: object.yMm, moved: false, frame: null };
    onInteraction(true);
  }

  /** 超过三屏幕像素后再移动，撤销整页旋转和缩放，保持对象自身角度不变。 */
  function update(event: PointerEvent<HTMLDivElement>): void {
    const current = drag.current;
    if (!current || current.pointer !== event.pointerId) return;
    if (!current.moved && Math.hypot(event.clientX - current.x, event.clientY - current.y) < 3) return;
    current.moved = true;
    const delta = screenDeltaToPaper(event.clientX - current.x, event.clientY - current.y, zoom, orientation);
    current.nextX = object.xMm + delta.x; current.nextY = object.yMm + delta.y;
    if (current.frame === null) current.frame = requestAnimationFrame(() => { if (drag.current === current) paint(current.nextX, current.nextY); current.frame = null; });
  }

  /** 松手才提交位置草稿；捕获取消只恢复预览。 */
  function end(event: PointerEvent<HTMLDivElement>, cancel = false): void {
    if (!drag.current || drag.current.pointer !== event.pointerId) return;
    if (!cancel) update(event);
    const current = drag.current; drag.current = null;
    if (current.frame !== null) cancelAnimationFrame(current.frame);
    paint(object.xMm, object.yMm); onInteraction(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    if (!cancel && current.moved) onMove(object.id, current.nextX, current.nextY);
  }

  return <div className={`canvas-object ${object.kind === 'image' ? 'canvas-picture' : 'canvas-text'} ${selected ? 'is-selected' : ''}`}
    ref={element} data-object-id={object.id} data-object-kind={object.kind} role="button" tabIndex={0}
    aria-label={objectLabel(object)} aria-pressed={selected} style={{ left: `${object.xMm}mm`, top: `${object.yMm}mm`,
      width: `${object.widthMm}mm`, height: `${object.heightMm}mm`, transform: `rotate(${object.rotation}deg)`, zIndex: object.zIndex + 1,
      '--text-scale': object.kind === 'text' ? object.widthMm / textBaseSize(object).widthMm : 1 } as CSSProperties}
    onPointerDown={begin} onPointerMove={update} onPointerUp={event => end(event)} onPointerCancel={event => end(event, true)}
    onLostPointerCapture={event => { if (drag.current) end(event, true); }}
    onDoubleClick={event => { if (!busy && object.kind === 'text') { event.preventDefault(); onEditText(object); } }}
    onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onSelect(object.id); } }}>
    {object.kind === 'image' ? <><img src={`album-page://image/${albumId}/${pageId}/${object.id}`} alt={object.sourceName} draggable={false} onError={() => setFailed(true)} />
      {failed && <div className="image-missing">图片无法加载<br />{object.fileName}</div>}</> : <TextContent object={object} showOverflow />}
  </div>;
});

/** 仅挂载当前页，图片与文字的角度独立于整页编辑方向。 */
export function CanvasEditor({ canvas, albumId, zoom, busy, selectedId, onSelect, onMove, onResize, onRotate, onInteraction, onEditText, onDropText, onDropAsset, onMessage }: {
  canvas: CanvasSnapshot; albumId: string; zoom: number; busy: boolean; selectedId: string | null;
  onSelect: (id: string | null) => void; onMove: (id: string, x: number, y: number) => void;
  onResize: (id: string, geometry: ObjectGeometry) => Promise<boolean>; onRotate: (id: string, angle: number) => Promise<boolean>;
  onInteraction: (active: boolean) => void; onEditText: (object: TextObject) => void;
  onDropText: (mode: WritingMode, position: { xMm: number; yMm: number }) => void;
  onDropAsset: (path: string) => void; onMessage: (message: string) => void;
}): React.JSX.Element {
  const [over, setOver] = useState(false); const paper = useRef<HTMLElement>(null);
  const document = canvas.document;
  const selected = document.objects.find(object => object.id === selectedId);
  return <><section ref={paper} className={`paper editable-paper ${over ? 'drop-active' : ''}`} data-paper data-page-id={canvas.pageId}
    data-orientation={document.orientation} aria-label="当前画布" style={{ width: '210mm', height: '297mm',
      transform: document.orientation === 'landscape' ? 'translateY(210mm) rotate(-90deg)' : undefined }}
    onPointerDown={() => { if (!busy) onSelect(null); }} onDragOver={event => {
      if (!busy && [assetDragType, textDragType].some(type => event.dataTransfer.types.includes(type))) {
        event.preventDefault(); event.dataTransfer.dropEffect = 'copy'; setOver(true);
      }
    }} onDragLeave={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOver(false); }}
    onDrop={event => {
      event.preventDefault(); setOver(false); if (busy) return;
      if (event.dataTransfer.types.includes(textDragType)) {
        const mode = event.dataTransfer.getData(textDragType);
        if (mode !== 'horizontal' && mode !== 'vertical') return;
        const rect = event.currentTarget.getBoundingClientRect();
        const x = (event.clientX - rect.left) / (mmToPixels * zoom); const y = (event.clientY - rect.top) / (mmToPixels * zoom);
        onDropText(mode, document.orientation === 'portrait' ? { xMm: x, yMm: y } : { xMm: 210 - y, yMm: x }); return;
      }
      try {
        const payload = JSON.parse(event.dataTransfer.getData(assetDragType)) as { albumId: string; assetPath: string };
        if (payload.albumId !== albumId || typeof payload.assetPath !== 'string') throw new Error();
        onDropAsset(payload.assetPath);
      } catch { onMessage('请从当前画册左侧拖入一张图片素材。'); }
    }}>
    {!document.objects.length && <div className="canvas-empty"><span aria-hidden="true">▧</span><p>拖入图片或添加文字</p><small>横排、竖排文字均可移动、缩放和旋转</small></div>}
    {document.objects.map(object => <CanvasItem key={object.id} object={object} albumId={albumId} pageId={canvas.pageId} orientation={document.orientation}
      zoom={zoom} selected={selectedId === object.id} busy={busy} onSelect={onSelect} onMove={onMove} onEditText={onEditText} onInteraction={onInteraction} />)}
  </section>{selected && <ObjectSelection key={selected.id} object={selected} orientation={document.orientation} zoom={zoom}
    busy={busy} paper={paper} onResize={onResize} onRotate={onRotate} onInteraction={onInteraction} />}</>;
}
