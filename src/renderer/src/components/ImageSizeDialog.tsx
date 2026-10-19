/** 文件用途：按对象自身尺寸调整图片或文字，文字始终只允许等比例缩放。 */
import { useEffect, useRef, useState } from 'react';
import { centeredGeometry, objectLabel } from '../../../shared/canvas';
import type { CanvasObject, ImageGeometry } from '../../../shared/canvas';

/** 长宽为对象自身尺寸，独立于自由旋转；确认时保持中心，文字的比例始终锁定。 */
export function ImageSizeDialog({ object, busy, onSubmit, onClose }: {
  object: CanvasObject; busy: boolean;
  onSubmit: (geometry: ImageGeometry) => Promise<boolean>; onClose: () => void;
}): React.JSX.Element {
  const dialog = useRef<HTMLDialogElement>(null);
  const box = { width: object.widthMm, height: object.heightMm };
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
      const geometry = centeredGeometry(object, actualLength, actualWidth);
      if (await onSubmit(geometry)) onClose();
    } finally { setPending(false); }
  }

  return <dialog ref={dialog} className="group-dialog image-size-dialog" aria-labelledby="image-size-title"
    onCancel={event => { event.preventDefault(); if (!locked) onClose(); }}>
    <form onSubmit={event => { event.preventDefault(); void submit(); }}>
      <h2 id="image-size-title">调整{object.kind === 'image' ? '图片' : '文字'}大小</h2><p className="size-image-name" title={objectLabel(object)}>{objectLabel(object)}</p>
      <p>按对象自身长宽输入，中心保持固定，旋转不改变尺寸读数。</p>
      <label htmlFor="image-length">对象长度（mm）</label>
      <input id="image-length" type="number" min="1" max="100000" step="any" required autoFocus value={length}
        disabled={locked} onChange={event => setLength(event.target.value)} />
      <label htmlFor="image-width">对象宽度（mm）</label>
      <input id="image-width" type="number" min="1" max="100000" step="any" required value={proportional ? computedWidth : width}
        readOnly={proportional} aria-readonly={proportional} disabled={locked} onChange={event => setWidth(event.target.value)} />
      <label className="size-proportion"><input type="checkbox" id="image-proportional" checked={proportional} disabled={locked || object.kind === 'text'}
        onChange={event => { if (!event.target.checked) setWidth(computedWidth); setProportional(event.target.checked); }} />等比例缩放</label>
      {proportional && <p className="size-proportion-hint">只需输入长度，宽度按打开时的图片比例自动计算。</p>}
      {error && <p className="size-input-error" role="alert">{error}</p>}
      <div className="dialog-actions"><button type="button" disabled={locked} onClick={onClose}>取消</button>
        <button type="submit" className="primary-button" disabled={locked}>确定</button></div>
    </form>
  </dialog>;
}
