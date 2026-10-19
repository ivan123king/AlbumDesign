/** 文件用途：用相同的 HTML/CSS 排版编辑预览和打印文字，缩放固定排版区域以保留换行。 */
import { useEffect, useRef, useState } from 'react';
import type { TextObject } from '../../../shared/canvas';

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
  return <><div className="text-layout" data-text-layout style={{ width: `${object.layoutWidthMm}mm`, height: `${object.layoutHeightMm}mm`,
    fontFamily: `"${object.fontFamily}"`, fontSize: `${object.fontSizePt}pt`, color: object.color,
    letterSpacing: `${object.letterSpacingPt}pt`, lineHeight: object.lineSpacing }}>
    <div className="text-flow" ref={flow} data-writing-mode={object.writingMode} style={{
      writingMode: object.writingMode === 'vertical' ? 'vertical-rl' : 'horizontal-tb', textOrientation: 'mixed',
      columnCount: object.writingMode === 'horizontal' ? object.columns : 1, columnGap: `${object.columnGapMm}mm`
    }}>{object.text}</div>
  </div>{showOverflow && overflow && <span className="text-overflow-hint" role="status">文字超出排版区域</span>}</>;
}
