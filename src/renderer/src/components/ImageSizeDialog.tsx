/** 文件用途：按当前画布视角编辑图片长度与宽度，支持仅输入长度的等比例缩放。 */
import { useEffect, useRef, useState } from 'react';
import { geometryFromViewBox, imageViewBox } from '../../../shared/canvas';
import type { ImageGeometry, ImageObject } from '../../../shared/canvas';
import type { Orientation } from '../../../shared/framework';

/** 长度为当前视角水平方向，宽度为垂直方向；确认时中心固定并反算基础毫米坐标。 */
export function ImageSizeDialog({ object, orientation, busy, onSubmit, onClose }: {
  object: ImageObject; orientation: Orientation; busy: boolean;
  onSubmit: (geometry: ImageGeometry) => Promise<boolean>; onClose: () => void;
}): React.JSX.Element {
  const dialog = useRef<HTMLDialogElement>(null);
  const box = imageViewBox(object, orientation);
  const [length, setLength] = useState(String(box.width));
  const [width, setWidth] = useState(String(box.height));
  const [proportional, setProportional] = useState(true);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const locked = busy || pending;
  const ratio = box.width / box.height;
  const actualLength = length.trim() ? Number(length) : NaN;
  const actualWidth = proportional ? actualLength / ratio : width.trim() ? Number(width) : NaN;
  const computedWidth = Number.isFinite(actualWidth) ? String(Math.round(actualWidth * 1e8) / 1e8) : '';
  useEffect(() => { const element = dialog.current; element?.showModal(); return () => element?.close(); }, []);

  /** 使用未四舍五入的计算值提交；字段为空、非数值、过小或过大时保留表单。 */
  async function submit(): Promise<void> {
    if (locked) return;
    if (![actualLength, actualWidth].every(value => Number.isFinite(value) && value >= 1 && value <= 100000)) {
      setError('长度和宽度都必须在 1～100000 mm 之间。'); return;
    }
    setPending(true); setError('');
    try {
      const geometry = geometryFromViewBox(object, orientation, { x: box.x + (box.width - actualLength) / 2,
        y: box.y + (box.height - actualWidth) / 2, width: actualLength, height: actualWidth });
      if (await onSubmit(geometry)) onClose();
    } finally { setPending(false); }
  }

  return <dialog ref={dialog} className="group-dialog image-size-dialog" aria-labelledby="image-size-title"
    onCancel={event => { event.preventDefault(); if (!locked) onClose(); }}>
    <form onSubmit={event => { event.preventDefault(); void submit(); }}>
      <h2 id="image-size-title">调整图片大小</h2><p className="size-image-name" title={object.sourceName}>{object.sourceName}</p>
      <p>按当前画布视角输入，图片中心保持固定。</p>
      <label htmlFor="image-length">长度（mm，水平方向）</label>
      <input id="image-length" type="number" min="1" max="100000" step="any" required autoFocus value={length}
        disabled={locked} onChange={event => setLength(event.target.value)} />
      <label htmlFor="image-width">宽度（mm，垂直方向）</label>
      <input id="image-width" type="number" min="1" max="100000" step="any" required value={proportional ? computedWidth : width}
        readOnly={proportional} aria-readonly={proportional} disabled={locked} onChange={event => setWidth(event.target.value)} />
      <label className="size-proportion"><input type="checkbox" id="image-proportional" checked={proportional} disabled={locked}
        onChange={event => { if (!event.target.checked) setWidth(computedWidth); setProportional(event.target.checked); }} />等比例缩放</label>
      {proportional && <p className="size-proportion-hint">只需输入长度，宽度按打开时的图片比例自动计算。</p>}
      {error && <p className="size-input-error" role="alert">{error}</p>}
      <div className="dialog-actions"><button type="button" disabled={locked} onClick={onClose}>取消</button>
        <button type="submit" className="primary-button" disabled={locked}>确定</button></div>
    </form>
  </dialog>;
}
