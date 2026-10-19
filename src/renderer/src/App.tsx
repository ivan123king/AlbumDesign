/** 文件用途：组装画册素材管理和三栏框架，保留 A4 样例预览及独立样例导出。 */
import { useEffect, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import { getPageSize, previewPages } from '../../shared/framework';
import type { AppInfo, Orientation } from '../../shared/framework';
import { PagePreview } from './components/PagePreview';
import { PanelDivider } from './components/PanelDivider';
import { AssetsPanel } from './components/AssetsPanel';
import type { AlbumState } from '../../shared/album';

const mmToPixels = 96 / 25.4;
const unavailable = '页面管理与排版保存将在后续阶段接入';

/** 素材使用真实画册状态；中间与右侧仍明确标注为固定方向样例。 */
export function App(): React.JSX.Element {
  const [orientation, setOrientation] = useState<Orientation>('portrait');
  const [zoom, setZoom] = useState(0.65);
  const [leftWidth, setLeftWidth] = useState(232);
  const [rightWidth, setRightWidth] = useState(232);
  const [info, setInfo] = useState<AppInfo | null>(null);
  const [message, setMessage] = useState('框架预览，尚未打开画册');
  const [exporting, setExporting] = useState(false);
  const [albumState, setAlbumState] = useState<AlbumState>({ revision: -1, album: null, busy: false, progress: null });
  const [albumReady, setAlbumReady] = useState(false);
  const [choosingAlbum, setChoosingAlbum] = useState(false);
  const workspace = useRef<HTMLDivElement>(null);
  const page = previewPages.find(item => item.orientation === orientation)!;
  const size = getPageSize(orientation);
  const layoutStyle = { '--left-width': `${leftWidth}px`, '--right-width': `${rightWidth}px` } as CSSProperties;

  useEffect(() => {
    let disposed = false;
    void window.desktop.getAppInfo().then(value => { if (!disposed) setInfo(value); })
      .catch(() => { if (!disposed) setMessage('桌面接口连接失败，请通过桌面程序启动。'); });
    return () => { disposed = true; };
  }, []);

  useEffect(() => {
    let disposed = false;
    /** 状态事件可能先于初始化响应返回，按版本号接收，避免覆盖已打开的画册。 */
    const receive = (state: AlbumState): void => {
      if (!disposed) {
        setAlbumState(previous => state.revision >= previous.revision ? state : previous);
        setAlbumReady(true);
      }
    };
    const unsubscribe = window.desktop.onAlbumState(receive);
    void window.desktop.getAlbumState().then(receive).catch(() => {
      if (!disposed) setMessage('画册接口连接失败，请重新启动桌面程序。');
    });
    return () => { disposed = true; unsubscribe(); };
  }, []);

  /** 新建与打开共用主进程原生目录选择；素材操作即时落盘，无页面保存伪状态。 */
  async function chooseAlbum(create: boolean): Promise<void> {
    if (choosingAlbum || albumState.busy) return;
    setChoosingAlbum(true);
    try {
      const result = await (create ? window.desktop.createAlbum() : window.desktop.openAlbum());
      setMessage(result.status === 'success' ? '画册已就绪，可在左侧导入素材；中央与右侧仍为方向样例。'
        : result.status === 'canceled' ? `已取消${create ? '新建' : '打开'}画册` : result.message);
    } catch { setMessage('桌面接口连接失败，请重试。'); }
    finally { setChoosingAlbum(false); }
  }

  useEffect(() => {
    const element = workspace.current;
    if (!element) return;
    /** 只更新查看比例；拦截滚轮默认行为，页面模型保持毫米尺寸。 */
    const onWheel = (event: WheelEvent): void => {
      if (event.deltaY === 0) return;
      event.preventDefault();
      setZoom(value => Math.max(0.2, Math.min(2, value * (event.deltaY < 0 ? 1.08 : 1 / 1.08))));
    };
    element.addEventListener('wheel', onWheel, { passive: false });
    return () => element.removeEventListener('wheel', onWheel);
  }, []);

  /** 根据可见区域计算查看比例，不改变 A4 页面尺寸或对象排版。 */
  function fitPage(): void {
    const area = workspace.current;
    if (!area) return;
    setZoom(Math.max(0.2, Math.min(2, (area.clientWidth - 96) / (size.width * mmToPixels),
      (area.clientHeight - 128) / (size.height * mmToPixels))));
  }

  /** 调用受限 preload 接口；保存路径只能由原生对话框选择。 */
  async function exportPdf(): Promise<void> {
    setExporting(true);
    setMessage('正在生成双页 A4 样例…');
    try {
      const result = await window.desktop.exportSamplePdf();
      setMessage(result.canceled ? '已取消导出' : `样例已导出：${result.filePath}`);
    } catch (error) {
      setMessage(`导出失败：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setExporting(false);
    }
  }

  return <div className="app-shell" style={layoutStyle} data-app-ready={info ? 'true' : undefined}>
    <header className="app-header">
      <div className="brand"><span className="brand-mark">册</span><div><strong>画册工坊</strong><span>留住每一页记忆</span></div></div>
      <div className="document-title">{albumState.album?.name ?? '尚未打开画册'} <span className="preview-badge">{albumState.album ? '素材管理' : '框架预览'}</span></div>
      <button className="primary-button" onClick={() => { void exportPdf(); }} disabled={exporting}>
        <span aria-hidden="true">↗</span> {exporting ? '正在导出…' : '导出样例 PDF'}
      </button>
    </header>

    <nav className="toolbar" aria-label="画册工具">
      <div className="toolbar-group">
        <button disabled={!albumReady || albumState.busy || choosingAlbum} data-new-project onClick={() => { void chooseAlbum(true); }}>＋ 新建画册</button>
        <button disabled={!albumReady || albumState.busy || choosingAlbum} onClick={() => { void chooseAlbum(false); }}>打开画册</button>
        <button disabled title={unavailable}>保存</button>
      </div>
      <span className="toolbar-divider" />
      <div className="toolbar-group">
        <button disabled title="图片排版将在后续阶段接入">添加图片</button>
        <button disabled title="文字排版将在后续阶段接入">横排文字</button>
        <button disabled title="文字排版将在后续阶段接入">竖排文字</button>
      </div>
      <div className="toolbar-note">手工排版 · 自由记录</div>
    </nav>

    <main className="editor-layout">
      <AssetsPanel state={albumState} onMessage={setMessage} />

      <PanelDivider side="left" width={leftWidth} onChange={setLeftWidth} />

      <section className="canvas-panel" aria-label="画布预览">
        <div className="canvas-toolbar"><div><strong>A4 样例预览</strong><span>{size.width} × {size.height} mm</span></div>
          <div className="segmented" aria-label="页面方向">
            <button aria-pressed={orientation === 'portrait'} onClick={() => setOrientation('portrait')}>竖版</button>
            <button aria-pressed={orientation === 'landscape'} onClick={() => setOrientation('landscape')}>横版</button>
          </div>
        </div>
        <div className="workspace" ref={workspace} data-workspace>
          <div className="canvas-stage">
            <div className="page-label">{page.name}<span>A4 / {orientation === 'portrait' ? 'PORTRAIT' : 'LANDSCAPE'}</span></div>
            <div className="scaled-page" style={{ width: size.width * mmToPixels * zoom, height: size.height * mmToPixels * zoom }}>
              <div style={{ transform: `scale(${zoom})`, transformOrigin: 'top left' }}><PagePreview page={page} /></div>
            </div>
            <div className="canvas-hint">滚轮缩放查看比例，纸张尺寸保持不变</div>
          </div>
        </div>
        <div className="canvas-bottom"><span>固定样例 · 尚未接入画册页面</span><div className="zoom-controls">
          <button aria-label="缩小画布" onClick={() => setZoom(value => Math.max(0.2, value - 0.1))}>−</button>
          <output data-zoom-value={zoom}>{Math.round(zoom * 100)}%</output>
          <button aria-label="放大画布" data-zoom-in onClick={() => setZoom(value => Math.min(2, value + 0.1))}>＋</button>
          <span className="toolbar-divider" /><button data-fit-page onClick={fitPage}>适应窗口</button>
        </div></div>
      </section>

      <PanelDivider side="right" width={rightWidth} onChange={setRightWidth} />

      <aside className="side-panel pages-panel" aria-label="画布与对象">
        <div className="panel-heading"><h2>画布与对象</h2><span className="count-badge">2</span></div>
        <div className="panel-subtitle">当前显示两张方向样例</div>
        <div className="page-list">{previewPages.map((item, index) => <button key={item.id}
          className={`page-row ${item.id === page.id ? 'selected' : ''}`} data-page-button={item.id}
          aria-current={item.id === page.id ? 'page' : undefined} onClick={() => setOrientation(item.orientation)}>
          <span className={`page-icon ${item.orientation}`} aria-hidden="true" />
          <span><strong>{item.name}</strong><small>第 {index + 1} 页 · A4</small></span><span className="page-number">{String(index + 1).padStart(2, '0')}</span>
        </button>)}</div>
        <button className="add-page" disabled title={unavailable}>＋ 新建画布</button>
        <div className="page-details"><h3>当前页面</h3><dl><div><dt>纸张</dt><dd>A4</dd></div><div><dt>方向</dt><dd>{orientation === 'portrait' ? '竖版' : '横版'}</dd></div><div><dt>宽度</dt><dd>{size.width} mm</dd></div><div><dt>高度</dt><dd>{size.height} mm</dd></div></dl></div>
        <div className="panel-tip">后续可展开画布，选择图片和文字对象，调整叠层顺序。</div>
        <div className="panel-footer">样例内容仅用于预览与导出验证</div>
      </aside>
    </main>

    <footer className="status-bar"><span className="status-message" role="status">{message}</span><span>本地画册 · A4</span><span>v{info?.version ?? '—'}</span></footer>
  </div>;
}
