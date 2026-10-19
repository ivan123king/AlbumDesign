/** 文件用途：独立后台窗口逐页绘制真实画册，只输出竖向 A4 基础坐标和正式对象。 */
import { useEffect, useState } from 'react';
import type { PdfPrintPage } from '../../../shared/pdf';
import { ObjectContent, pageObjectStyle } from './ObjectContent';

/** 打印数据只能由当前导出窗口查询；每次换页重载以释放上一页的解码原图。 */
export function AlbumPrintView(): React.JSX.Element {
  const [page, setPage] = useState<PdfPrintPage | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    let disposed = false;
    void window.desktop.getPdfPrintPage().then(value => { if (!disposed) setPage(value); })
      .catch(reason => { if (!disposed) setError(String(reason)); });
    return () => { disposed = true; };
  }, []);
  if (error) return <p data-print-error>{error}</p>;
  if (!page) return <p>正在准备打印页面…</p>;
  return <main data-print-ready className="album-print"><section className="print-sheet" data-print-page={page.pageId}>
    {page.document.objects.map(object => <div key={object.id} data-object-id={object.id}
      className={`canvas-object ${object.kind === 'image' ? 'canvas-picture' : 'canvas-text'}`} style={pageObjectStyle(object)}>
      <ObjectContent object={object} albumId={page.albumId} pageId={page.pageId} />
    </div>)}
  </section></main>;
}
