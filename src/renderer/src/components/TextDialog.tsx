/** 文件用途：编辑横竖排文字、字体及区域，支持中文输入，独立于画布拖动与缩放。 */
import { useEffect, useRef, useState } from 'react';
import { mmToPixels } from '../../../shared/canvas';
import type { TextDraft, TextFont, TextObject, WritingMode } from '../../../shared/canvas';
import { TextContent } from './TextContent';

/** 再次编辑时使用实际字号和区域重新排版，保留之前整体缩放后的视觉大小。 */
function initialDraft(object: TextObject | null, mode: WritingMode, fonts: TextFont[]): TextDraft {
  if (object) {
    const scale = object.widthMm / object.layoutWidthMm;
    return { text: object.text, writingMode: object.writingMode, fontFamily: object.fontFamily,
      fontSizePt: object.fontSizePt * scale, color: object.color, letterSpacingPt: object.letterSpacingPt * scale,
      lineSpacing: object.lineSpacing, columns: object.columns, columnGapMm: object.columnGapMm * scale,
      widthMm: object.widthMm, heightMm: object.heightMm };
  }
  return { text: '', writingMode: mode, fontFamily: fonts.find(font => font.available)?.family ?? 'Microsoft YaHei',
    fontSizePt: 16, color: '#30332f', letterSpacingPt: 0, lineSpacing: 1.6, columns: 1, columnGapMm: 3,
    widthMm: mode === 'horizontal' ? 100 : 60, heightMm: mode === 'horizontal' ? 50 : 100 };
}

/** 表单确认才更新模型，取消或中文输入过程不产生对象文件或草稿修改。 */
export function TextDialog({ object, mode, fonts, busy, onSubmit, onClose }: {
  object: TextObject | null; mode: WritingMode; fonts: TextFont[]; busy: boolean;
  onSubmit: (draft: TextDraft) => Promise<boolean>; onClose: () => void;
}): React.JSX.Element {
  const ref = useRef<HTMLDialogElement>(null);
  const [draft, setDraft] = useState<TextDraft>(() => initialDraft(object, mode, fonts));
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const locked = busy || pending;
  const missingFont = !fonts.some(font => font.family === draft.fontFamily && font.available);
  useEffect(() => { const dialog = ref.current; dialog?.showModal(); return () => dialog?.close(); }, []);
  const preview: TextObject = { ...draft, text: draft.text || '在这里预览文字\n横排与竖排均支持中文', kind: 'text', id: 'text-preview',
    xMm: 0, yMm: 0, rotation: 0, zIndex: 0,
    layoutWidthMm: Math.max(1, draft.widthMm || 1), layoutHeightMm: Math.max(1, draft.heightMm || 1) };
  const previewScale = Math.min(1, 300 / (preview.layoutWidthMm * mmToPixels), 150 / (preview.layoutHeightMm * mmToPixels));
  return <dialog ref={ref} className="group-dialog text-dialog" aria-labelledby="text-dialog-title"
    onCancel={event => { event.preventDefault(); if (!locked) onClose(); }}>
    <form onSubmit={event => {
      event.preventDefault();
      if (locked) return;
      if (!draft.text.trim()) { setError('请输入文字内容。'); return; }
      setPending(true); setError('');
      void onSubmit(draft).then(ok => { if (ok) onClose(); }).finally(() => setPending(false));
    }}>
      <h2 id="text-dialog-title">{object ? '编辑' : '新建'}{draft.writingMode === 'horizontal' ? '横排' : '竖排'}文字</h2>
      <label htmlFor="text-content">文字内容</label>
      <textarea id="text-content" value={draft.text} required autoFocus maxLength={100000} disabled={locked}
        onChange={event => setDraft(value => ({ ...value, text: event.target.value }))} />
      <div className="text-settings"><label>字体<select id="text-font" value={draft.fontFamily} disabled={locked}
        onChange={event => setDraft(value => ({ ...value, fontFamily: event.target.value }))}>
        {fonts.map(font => <option key={font.family} value={font.family} disabled={!font.available}>{font.label}{font.available ? '' : '（未安装）'}</option>)}</select></label>
        <label>颜色<input id="text-color" type="color" value={draft.color} disabled={locked} onChange={event => setDraft(value => ({ ...value, color: event.target.value }))} /></label>
        {([
          ['fontSizePt', '字号（pt）', .1, 10000, 'any'], ['letterSpacingPt', '字间距（pt）', -1000, 10000, 'any'],
          ['lineSpacing', '行列间距倍数', .5, 5, 'any'], ['columnGapMm', '分栏间距（mm）', 0, 100000, 'any'],
          ['widthMm', '排版区长度（mm）', 1, 100000, 'any'], ['heightMm', '排版区宽度（mm）', 1, 100000, 'any']
        ] as const).map(([key, label, min, max, step]) => <label key={key}>{label}<input id={`text-${key}`} type="number" min={min} max={max} step={step}
          required value={Number.isNaN(draft[key]) ? '' : draft[key]} disabled={locked}
          onChange={event => setDraft(value => ({ ...value, [key]: event.target.value === '' ? NaN : Number(event.target.value) }))} /></label>)}
        {draft.writingMode === 'horizontal' && <label>分栏数<input id="text-columns" type="number" min="1" max="8" step="1" required value={draft.columns} disabled={locked}
          onChange={event => setDraft(value => ({ ...value, columns: Number(event.target.value) }))} /></label>}
      </div>
      <p>编辑排版区域时重新换行；画布四角缩放会连同文字、间距整体等比缩放。</p>
      {missingFont && <p className="size-input-error" role="alert">所选字体未安装，请选择可用字体。</p>}
      <div className="text-dialog-preview"><div style={{ width: `${preview.layoutWidthMm}mm`, height: `${preview.layoutHeightMm}mm`,
        transform: `translate(-50%, -50%) scale(${previewScale})` }}><TextContent object={preview} showOverflow /></div></div>
      {error && <p className="size-input-error" role="alert">{error}</p>}
      <div className="dialog-actions"><button type="button" disabled={locked} onClick={onClose}>取消</button>
        <button type="submit" className="primary-button" disabled={locked || missingFont}>确定</button></div>
    </form>
  </dialog>;
}
