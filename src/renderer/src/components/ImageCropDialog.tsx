/** 文件用途：左右图片共用的裁剪弹框；拖动只更新轮廓，按钮预览生成小图，确认才提交原像素裁剪。 */
import { useEffect, useRef, useState } from 'react';
import type { PointerEvent } from 'react';
import { cropPixelBounds, cropShapePath, renderCrop } from '../../../shared/crop';
import type { CropSettings, CropShape, CropSource, CropTarget } from '../../../shared/crop';
import { resizeHandles, rotateVector } from '../../../shared/canvas';
import type { ResizeHandle } from '../../../shared/canvas';

const initialCrop: CropSettings = { shape: 'rectangle', cx: .5, cy: .5, width: .8, height: .8, angle: 0, inverse: false };
type Gesture = { kind: ResizeHandle | 'move' | 'rotate'; pointer: number; x: number; y: number; start: CropSettings };

/** 保证旋转控制框完整留在图片内；统一收缩并约束中心，避免出现原图之外的空白。 */
function constrainCrop(crop: CropSettings, width: number, height: number): CropSettings {
  const angle = crop.angle * Math.PI / 180, c = Math.abs(Math.cos(angle)), s = Math.abs(Math.sin(angle));
  let w = crop.width * width, h = crop.height * height;
  const scale = Math.min(1, width / (c * w + s * h), height / (s * w + c * h));
  w *= scale; h *= scale;
  const halfW = (c * w + s * h) / 2 / width, halfH = (s * w + c * h) / 2 / height;
  return { ...crop, width: w / width, height: h / height,
    cx: Math.max(halfW, Math.min(1 - halfW, crop.cx)), cy: Math.max(halfH, Math.min(1 - halfH, crop.cy)) };
}

/** 缩放碰到图片边界时沿本次手势截断，保留固定对角/对边及单轴规则，不联动改变另一边。 */
function limitResize(start: CropSettings, next: CropSettings, width: number, height: number): CropSettings {
  const angle = start.angle * Math.PI / 180, c = Math.abs(Math.cos(angle)), s = Math.abs(Math.sin(angle));
  const interpolate = (factor: number): CropSettings => ({ ...start,
    cx: start.cx + (next.cx - start.cx) * factor, cy: start.cy + (next.cy - start.cy) * factor,
    width: start.width + (next.width - start.width) * factor, height: start.height + (next.height - start.height) * factor });
  const fits = (candidate: CropSettings): boolean => {
    const halfW = (c * candidate.width * width + s * candidate.height * height) / 2 / width;
    const halfH = (s * candidate.width * width + c * candidate.height * height) / 2 / height;
    return candidate.width <= 1 && candidate.height <= 1 && candidate.cx >= halfW - 1e-10 && candidate.cx <= 1 - halfW + 1e-10
      && candidate.cy >= halfH - 1e-10 && candidate.cy <= 1 - halfH + 1e-10;
  };
  if (fits(next)) return next;
  let low = 0, high = 1;
  for (let i = 0; i < 30; i++) { const middle = (low + high) / 2; if (fits(interpolate(middle))) low = middle; else high = middle; }
  return interpolate(low);
}

/** 原生模态焦点限制背景操作；关闭释放只读源图租约与本次预览，不改变任何文件。 */
export function ImageCropDialog({ target, name, onClose, onApplied }: {
  target: CropTarget; name: string; onClose: () => void; onApplied: (path: string | null) => void;
}): React.JSX.Element {
  const dialog = useRef<HTMLDialogElement>(null), svg = useRef<SVGSVGElement>(null), image = useRef<HTMLImageElement>(null);
  const requestRef = useRef<{ attempt: number; promise: ReturnType<typeof window.desktop.beginImageCrop>; users: number } | null>(null);
  const previewRef = useRef('');
  const gesture = useRef<Gesture | null>(null);
  const [source, setSource] = useState<CropSource | null>(null), [crop, setCrop] = useState<CropSettings>(initialCrop);
  const [loaded, setLoaded] = useState(false), [pending, setPending] = useState(false), [error, setError] = useState('');
  const [preview, setPreview] = useState(''), [opening, setOpening] = useState(true), [attempt, setAttempt] = useState(0);
  useEffect(() => { dialog.current?.showModal(); return () => dialog.current?.close(); }, []);
  useEffect(() => {
    let active = true;
    setOpening(true); setError('');
    // 开发模式会重放 effect：共用尚未结束的申请，避免第二次请求被主进程互斥锁拒绝。
    const request = requestRef.current?.attempt === attempt ? requestRef.current
      : { attempt, promise: window.desktop.beginImageCrop(target), users: 0 };
    requestRef.current = request; request.users++;
    void request.promise.then(result => {
      if (!active) return;
      if (result.status === 'success') {
        setSource(result.value);
      } else setError(result.status === 'error' ? result.message : '已取消打开裁剪。');
    }).catch(() => { if (active) setError('图片读取失败，请重试。'); }).finally(() => { if (active) setOpening(false); });
    return () => {
      active = false;
      request.users--;
      // 延迟到同步重放结束再判断是否真正卸载；即使申请晚到，也只释放这次申请的令牌。
      queueMicrotask(() => {
        if (request.users !== 0) return;
        void request.promise.then(result => {
          if (result.status === 'success') return window.desktop.releaseImageCrop(result.value.token);
        }).catch(() => undefined);
      });
      if (previewRef.current) URL.revokeObjectURL(previewRef.current);
    };
  }, [attempt]);
  useEffect(() => {
    /** 失焦只取消当前手势，保留弹框；Esc 在拖动中恢复手势起点，否则关闭弹框。 */
    const cancel = (): void => { if (gesture.current) { setCrop(gesture.current.start); gesture.current = null; } };
    window.addEventListener('blur', cancel);
    return () => window.removeEventListener('blur', cancel);
  }, []);
  const width = source?.width ?? 1000, height = source?.height ?? 700;
  const padding = Math.max(width, height) * .08, radius = Math.max(width, height) * .009;
  const frameWidth = crop.width * width, frameHeight = crop.height * height;
  const locked = pending || opening || !loaded;

  /** 屏幕鼠标先转换到 SVG 原图像素，操作不受弹框尺寸和图片查看缩放影响。 */
  function point(event: PointerEvent<SVGSVGElement>): DOMPoint {
    return new DOMPoint(event.clientX, event.clientY).matrixTransform(svg.current!.getScreenCTM()!.inverse());
  }
  /** 仅主键命中控制框时开始手势，捕获指针以支持拖出框外后继续调整。 */
  function begin(event: PointerEvent<SVGSVGElement>): void {
    if (locked || preview || event.button !== 0) return;
    const handle = (event.target as Element).closest('[data-crop-handle]')?.getAttribute('data-crop-handle') as Gesture['kind'] | undefined;
    if (!handle) return;
    event.preventDefault(); event.currentTarget.setPointerCapture(event.pointerId);
    const position = point(event);
    gesture.current = { kind: handle, pointer: event.pointerId, x: position.x, y: position.y, start: { ...crop } };
  }
  /** 四角固定对角等比，四边固定对边单轴；缩放在旋转框局部坐标中计算，无需 Ctrl。 */
  function update(event: PointerEvent<SVGSVGElement>): void {
    const current = gesture.current;
    if (!current || current.pointer !== event.pointerId) return;
    const position = point(event), start = current.start;
    let next = { ...start };
    const dx = position.x - current.x, dy = position.y - current.y;
    if (current.kind === 'move') { next.cx += dx / width; next.cy += dy / height; }
    else if (current.kind === 'rotate') {
      const cx = start.cx * width, cy = start.cy * height;
      const delta = Math.atan2(position.y - cy, position.x - cx) - Math.atan2(current.y - cy, current.x - cx);
      next.angle = ((start.angle + delta * 180 / Math.PI) % 360 + 360) % 360;
    } else {
      const local = rotateVector(dx, dy, -start.angle);
      const sx = current.kind.includes('e') ? 1 : current.kind.includes('w') ? -1 : 0;
      const sy = current.kind.includes('s') ? 1 : current.kind.includes('n') ? -1 : 0;
      const w = start.width * width, h = start.height * height, minimum = Math.max(1, Math.min(width, height) * .005);
      let nextW = sx ? Math.max(minimum, w + sx * local.x) : w;
      let nextH = sy ? Math.max(minimum, h + sy * local.y) : h;
      if (sx && sy) {
        const factor = Math.max(minimum / Math.min(w, h), 1 + (sx * local.x * w + sy * local.y * h) / (w * w + h * h));
        nextW = w * factor; nextH = h * factor;
      }
      const shift = rotateVector(sx * (nextW - w) / 2, sy * (nextH - h) / 2, start.angle);
      next = { ...next, cx: start.cx + shift.x / width, cy: start.cy + shift.y / height, width: nextW / width, height: nextH / height };
    }
    setCrop(current.kind === 'move' || current.kind === 'rotate' ? constrainCrop(next, width, height) : limitResize(start, next, width, height)); setError('');
  }
  /** 松手保留当前框，系统取消则恢复手势起点，统一释放指针捕获。 */
  function end(event: PointerEvent<SVGSVGElement>, canceled = false): void {
    const current = gesture.current;
    if (!current || current.pointer !== event.pointerId) return;
    if (canceled) setCrop(current.start); else update(event);
    gesture.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  }

  /** 仅按钮触发小图绘制与异步 PNG 编码；旧预览先释放，成品仍使用后台原图处理。 */
  async function showPreview(): Promise<void> {
    if (!source || !image.current || locked) return;
    setPending(true); setError('');
    let canvas: HTMLCanvasElement | null = null;
    try {
      await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
      canvas = renderCrop(image.current, width, height, crop, cropPixelBounds(crop, width, height), cropShapePath(crop.shape), 1200);
      const blob = await new Promise<Blob | null>(resolve => canvas!.toBlob(resolve, 'image/png'));
      if (!blob) throw new Error('预览生成失败。');
      if (previewRef.current) URL.revokeObjectURL(previewRef.current);
      previewRef.current = URL.createObjectURL(blob); setPreview(previewRef.current);
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { if (canvas) { canvas.width = 0; canvas.height = 0; } setPending(false); }
  }
  /** 确认才请求后台裁剪；失败保留参数供调整，成功后由宿主刷新素材或当前页草稿。 */
  async function submit(): Promise<void> {
    if (!source || locked) return;
    setPending(true); setError('');
    try {
      const result = await window.desktop.applyImageCrop(source.token, crop);
      if (result.status === 'success') { await window.desktop.releaseImageCrop(source.token); onApplied(result.value); }
      else if (result.status === 'error') setError(result.message);
    } catch (reason) { setError(`裁剪失败：${reason instanceof Error ? reason.message : String(reason)}`); }
    finally { setPending(false); }
  }
  /** 切换形状以方形框初始化圆与心形；之后边中点允许自由拉伸，角点保持当前比例。 */
  function changeShape(shape: CropShape): void {
    const side = Math.min(width, height) * .7;
    setCrop(constrainCrop({ ...crop, shape, ...(shape === 'rectangle' ? {} : { width: side / width, height: side / height }) }, width, height));
  }
  return <dialog ref={dialog} className="group-dialog crop-dialog" aria-labelledby="crop-title" data-image-crop
    onCancel={event => {
      event.preventDefault(); if (pending || opening) return;
      if (gesture.current) { setCrop(gesture.current.start); gesture.current = null; } else onClose();
    }}>
    <div className="crop-heading"><h2 id="crop-title">{preview ? '裁剪结果预览' : '裁剪图片'}</h2><span title={name}>{name}</span>
      <button type="button" disabled={pending || opening} onClick={onClose} aria-label="关闭裁剪">关闭</button></div>
    <div className="crop-stage" aria-busy={pending || opening}>
      {source && <img ref={image} className="crop-source-loader" crossOrigin="anonymous" src={source.url} alt="" onLoad={() => setLoaded(true)} onError={() => setError('图片加载失败，请关闭后重试。')} />}
      {loaded && !preview && <svg ref={svg} viewBox={`${-padding} ${-padding} ${width + padding * 2} ${height + padding * 2}`}
        aria-label="裁剪范围，四角等比缩放，四边单轴缩放" onPointerDown={begin} onPointerMove={update}
        onPointerUp={event => end(event)} onPointerCancel={event => end(event, true)} onLostPointerCapture={event => { if (gesture.current) end(event, true); }}>
        <image href={source!.url} width={width} height={height} />
        <g transform={`translate(${crop.cx * width} ${crop.cy * height}) rotate(${crop.angle})`}>
          <rect data-crop-handle="move" x={-frameWidth / 2} y={-frameHeight / 2} width={frameWidth} height={frameHeight} className="crop-frame" />
          <path d={cropShapePath(crop.shape)} transform={`translate(${-frameWidth / 2} ${-frameHeight / 2}) scale(${frameWidth} ${frameHeight})`}
            className="crop-outline" vectorEffect="non-scaling-stroke" />
          <line x1={0} x2={0} y1={-frameHeight / 2} y2={-frameHeight / 2 - radius * 4} className="crop-line" vectorEffect="non-scaling-stroke" />
          <circle data-crop-handle="rotate" cx={0} cy={-frameHeight / 2 - radius * 4} r={radius * 1.2} className="crop-control crop-rotate" />
          {resizeHandles.map(handle => <circle key={handle} data-crop-handle={handle} r={radius} className={`crop-control crop-${handle}`}
            cx={handle.includes('w') ? -frameWidth / 2 : handle.includes('e') ? frameWidth / 2 : 0}
            cy={handle.includes('n') ? -frameHeight / 2 : handle.includes('s') ? frameHeight / 2 : 0} />)}
        </g>
      </svg>}
      {preview && <img className="crop-result" src={preview} alt="裁剪结果，棋盘格表示透明区域" />}
      {(pending || opening || (!loaded && !error)) && <div className="crop-status" role="status">{opening || !loaded ? '正在加载图片…' : '正在处理图片…'}</div>}
    </div>
    <div className="crop-tools">
      <label>裁剪形状<select aria-label="裁剪形状" value={crop.shape} disabled={locked || !!preview} onChange={event => changeShape(event.target.value as CropShape)}>
        <option value="rectangle">矩形</option><option value="ellipse">圆形／椭圆</option><option value="heart">心形</option></select></label>
      <label>旋转角度<input aria-label="裁剪旋转角度" type="number" value={Number(crop.angle.toFixed(1))} step="1" disabled={locked || !!preview}
        onChange={event => { const value = event.target.valueAsNumber; if (Number.isFinite(value)) setCrop(constrainCrop({ ...crop, angle: ((value % 360) + 360) % 360 }, width, height)); }} /></label>
      <label className="crop-inverse"><input type="checkbox" checked={crop.inverse} disabled={locked || !!preview} onChange={event => setCrop({ ...crop, inverse: event.target.checked })} />反向裁剪（保留形状外部）</label>
      <button type="button" disabled={locked || !!preview} onClick={() => { setCrop(initialCrop); setError(''); }}>重置</button>
    </div>
    <p className="crop-hint">四角等比例缩放，四边只改长宽；拖动框内移动，上方圆点旋转。点击预览查看透明裁剪效果。</p>
    <p className="crop-hint">{target.kind === 'asset' ? '确定后直接替换素材，已有画布副本不变。' : '确定后替换当前画布图片，保存后删除旧图片。'}裁掉的内容在提交后无法恢复。</p>
    {error && <p className="crop-error" role="alert">{error}{!source && !opening && <button type="button" onClick={() => setAttempt(value => value + 1)}>重试</button>}</p>}
    <div className="dialog-actions"><button type="button" disabled={pending || opening} onClick={onClose}>取消</button>
      {preview ? <button type="button" disabled={pending} onClick={() => { URL.revokeObjectURL(previewRef.current); previewRef.current = ''; setPreview(''); }}>返回调整</button>
        : <button type="button" disabled={locked} onClick={() => void showPreview()}>预览</button>}
      <button type="button" className="primary-button" disabled={locked} onClick={() => void submit()}>确定</button></div>
  </dialog>;
}
