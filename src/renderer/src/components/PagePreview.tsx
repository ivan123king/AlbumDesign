/** 文件用途：编辑与打印共用的 A4 样例页面；所有对象采用 HTML/CSS 排版。 */
import { getPageSize, previewPages } from '../../../shared/framework';
import type { PreviewPage } from '../../../shared/framework';

/** 尺寸按毫米定义；视图缩放由外层负责，内部不跟随查看比例重排。 */
export function PagePreview({ page }: { page: PreviewPage }): React.JSX.Element {
  const size = getPageSize(page.orientation);
  return (
    <section className={`paper ${page.orientation}`} data-paper data-orientation={page.orientation}
      style={{ width: `${size.width}mm`, height: `${size.height}mm` }} aria-label={`${page.name}，${size.width} × ${size.height} 毫米`}>
      <div className="paper-kicker">生活拾光 · 画册预览</div>
      <div className="paper-heading">把日子，<br />慢慢收藏。</div>
      <div className="paper-caption">一张照片，一段故事。<br />让值得记住的瞬间，在纸上相遇。</div>
      <div className="paper-photo" aria-label="图片位置示意">
        <svg width="42" height="42" viewBox="0 0 40 40" fill="none" aria-hidden="true">
          <rect x="4" y="5" width="32" height="30" rx="3" stroke="currentColor" strokeWidth="1.4" />
          <circle cx="14" cy="14" r="3" stroke="currentColor" strokeWidth="1.4" />
          <path d="m5 30 10-10 7 6 6-8 7 10" stroke="currentColor" strokeWidth="1.4" />
        </svg>
        <span>为珍贵的照片，留一个位置</span>
      </div>
      <div className="paper-vertical">每一页，都是时光的来信。</div>
      <div className="paper-footer"><span>框架样例 · 非真实画册内容</span><span>{page.orientation === 'portrait' ? '01' : '02'}</span></div>
    </section>
  );
}

/** PDF 纸张统一竖向 A4；横版逻辑画布由打印外层整体顺时针旋转 90°。 */
export function PrintView(): React.JSX.Element {
  return <main data-print-ready>{previewPages.map(page => (
    <div className="print-sheet" key={page.id} data-source-orientation={page.orientation}>
      <PagePreview page={page} />
    </div>
  ))}</main>;
}
