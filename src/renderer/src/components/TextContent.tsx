/** 文件用途：用相同的 HTML/CSS 排版编辑预览和打印文字，缩放固定排版区域以保留换行。 */
import { useEffect, useRef, useState } from 'react';
import type { TextContentBounds, TextObject } from '../../../shared/canvas';

/** 从同一排版 DOM 读取字形行列边界，撤销预览缩放；保留半毫米边距和最小一毫米选框。 */
export async function measureTextBounds(root: HTMLElement, object: TextObject): Promise<TextContentBounds> {
  await document.fonts.load(`${object.fontSizePt}pt "${object.fontFamily}"`, object.text);
  await document.fonts.ready;
  const layout = root.querySelector<HTMLElement>('[data-text-layout]')!;
  const flow = layout.querySelector<HTMLElement>('.text-flow')!;
  const box = layout.getBoundingClientRect();
  const pixelsPerMm = box.width / object.layoutWidthMm;
  const range = document.createRange(); range.selectNodeContents(flow);
  const rects = [...range.getClientRects()].filter(rect => rect.width > 0 && rect.height > 0);
  if (!rects.length) throw new Error('无法测量文字，请输入可见文字后重试。');
  let left = Infinity; let top = Infinity; let right = -Infinity; let bottom = -Infinity;
  for (const rect of rects) {
    left = Math.min(left, rect.left); top = Math.min(top, rect.top);
    right = Math.max(right, rect.right); bottom = Math.max(bottom, rect.bottom);
  }
  return { xMm: (left - box.left) / pixelsPerMm - .5, yMm: (top - box.top) / pixelsPerMm - .5,
    widthMm: Math.max(1, (right - left) / pixelsPerMm + 1), heightMm: Math.max(1, (bottom - top) / pixelsPerMm + 1) };
}

/** 内层按基础字号与排版区布局，外层 --text-scale 统一缩放字号、间距和行列。 */
export function TextContent({ object, showOverflow = false }: { object: TextObject; showOverflow?: boolean }): React.JSX.Element {
  const flow = useRef<HTMLDivElement>(null);
  const [overflow, setOverflow] = useState(false);
  useEffect(() => {
    let disposed = false;
    /** 字体就绪后测量排版溢出，避免文字在边界被截断却没有提示。 */
    const measure = (): void => {
      if (flow.current && !disposed) setOverflow(flow.current.scrollWidth > flow.current.clientWidth + 1 || flow.current.scrollHeight > flow.current.clientHeight + 1);
    };
    const observer = new ResizeObserver(measure);
    if (flow.current) observer.observe(flow.current);
    void document.fonts.ready.then(measure); measure();
    return () => { disposed = true; observer.disconnect(); };
  }, [object.text, object.fontFamily, object.fontSizePt, object.layoutWidthMm, object.layoutHeightMm,
    object.writingMode, object.columns, object.columnGapMm, object.lineSpacing, object.letterSpacingPt]);
  return <><div className="text-viewport"><div className="text-layout" data-text-layout style={{ width: `${object.layoutWidthMm}mm`, height: `${object.layoutHeightMm}mm`,
    transform: `scale(var(--text-scale, 1)) translate(${- (object.contentBounds?.xMm ?? 0)}mm, ${- (object.contentBounds?.yMm ?? 0)}mm)`,
    fontFamily: `"${object.fontFamily}"`, fontSize: `${object.fontSizePt}pt`, color: object.color,
    letterSpacing: `${object.letterSpacingPt}pt`, lineHeight: object.lineSpacing }}>
    <div className="text-flow" ref={flow} data-writing-mode={object.writingMode} style={{
      writingMode: object.writingMode === 'vertical' ? 'vertical-rl' : 'horizontal-tb', textOrientation: 'mixed',
      columnCount: object.writingMode === 'horizontal' ? object.columns : 1, columnGap: `${object.columnGapMm}mm`
    }}>{object.text}</div>
  </div></div>{showOverflow && overflow && <span className="text-overflow-hint" role="status">文字超出排版区域</span>}</>;
}
