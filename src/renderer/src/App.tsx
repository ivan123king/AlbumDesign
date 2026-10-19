/** 文件用途：组装素材、当前页编辑和页面对象列表，协调受限操作及手动保存。 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import { getPageSize } from '../../shared/framework';
import type { AppInfo, Orientation } from '../../shared/framework';
import type { AlbumResult, AlbumState } from '../../shared/album';
import { mmToPixels, textDragType } from '../../shared/canvas';
import type { ImageGeometry, TextDraft, TextFont, TextObject, WritingMode } from '../../shared/canvas';
import { PanelDivider } from './components/PanelDivider';
import { AssetsPanel } from './components/AssetsPanel';
import { CanvasEditor } from './components/CanvasEditor';
import { PagesPanel } from './components/PagesPanel';
import { TextDialog } from './components/TextDialog';

/** 主进程保存当前页草稿；局部拖动帧由图片组件处理，主界面接收结束后的坐标。 */
export function App(): React.JSX.Element {
  const [zoom, setZoom] = useState(0.65);
  const [leftWidth, setLeftWidth] = useState(232);
  const [rightWidth, setRightWidth] = useState(232);
  const [info, setInfo] = useState<AppInfo | null>(null);
  const [message, setMessage] = useState('请新建或打开画册，再创建画布。');
  const [state, setState] = useState<AlbumState>({ revision: -1, album: null, busy: false, progress: null, canvas: null });
  const [ready, setReady] = useState(false);
  const [pending, setPending] = useState(false);
  const [interacting, setInteracting] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [selection, setSelection] = useState<{ kind: 'page' | 'image'; id: string } | null>(null);
  const [fonts, setFonts] = useState<TextFont[]>([]);
  const [textEditor, setTextEditor] = useState<{ object: TextObject | null; mode: WritingMode; position?: { xMm: number; yMm: number } } | null>(null);
  const workspace = useRef<HTMLDivElement>(null);
  const localLock = useRef(false);
  const albumId = state.album?.id;
  const pageId = state.canvas?.pageId;
  const busy = state.busy || pending || interacting;
  const orientation = state.canvas?.document.orientation ?? 'portrait';
  const size = getPageSize(orientation);
  const current = state.album?.pages.find(page => page.id === pageId);
  const selectedId = selection?.kind === 'image' ? selection.id : null;
  const layoutStyle = { '--left-width': `${leftWidth}px`, '--right-width': `${rightWidth}px` } as CSSProperties;

  useEffect(() => {
    let disposed = false;
    void window.desktop.getAppInfo().then(value => { if (!disposed) setInfo(value); }).catch(() => {
      if (!disposed) setMessage('桌面接口连接失败，请通过桌面程序启动。');
    });
    /** 初始查询与事件可能交错，版本号防止旧状态覆盖最新编辑。 */
    const receive = (value: AlbumState): void => {
      if (!disposed) { setState(previous => value.revision >= previous.revision ? value : previous); setReady(true); }
    };
    const unsubscribe = window.desktop.onAlbumState(receive);
    void window.desktop.getAlbumState().then(receive).catch(() => { if (!disposed) setMessage('画册接口连接失败。'); });
    void window.desktop.getTextFonts().then(value => { if (!disposed) setFonts(value); }).catch(() => { if (!disposed) setMessage('无法读取可用字体。'); });
    return () => { disposed = true; unsubscribe(); };
  }, []);
  useEffect(() => { setSelection(pageId ? { kind: 'page', id: pageId } : null); setTextEditor(null); }, [albumId, pageId]);
  useEffect(() => {
    if (selectedId && !state.canvas?.document.objects.some(object => object.id === selectedId)) setSelection(pageId ? { kind: 'page', id: pageId } : null);
  }, [state.canvas, selectedId, pageId]);
  useEffect(() => {
    const element = workspace.current;
    if (!element) return;
    /** 滚轮只改变查看比例，原始毫米尺寸保持不变。 */
    const onWheel = (event: WheelEvent): void => {
      if (!event.deltaY) return;
      event.preventDefault();
      if (interacting) return;
      setZoom(value => Math.max(0.1, Math.min(2, value * (event.deltaY < 0 ? 1.08 : 1 / 1.08))));
    };
    element.addEventListener('wheel', onWheel, { passive: false });
    return () => element.removeEventListener('wheel', onWheel);
  }, [interacting]);

  /** 串行提交界面命令；主进程另有互斥，失败与取消均不显示成功。 */
  const execute = useCallback(async (operation: () => Promise<AlbumResult<unknown>>, success: string): Promise<boolean> => {
    if (localLock.current) return false;
    localLock.current = true; setPending(true);
    try {
      const result = await operation();
      setMessage(result.status === 'success' ? success : result.status === 'error' ? result.message : '已取消操作');
      return result.status === 'success';
    } catch (error) { setMessage(`操作失败：${error instanceof Error ? error.message : String(error)}`); return false; }
    finally { localLock.current = false; setPending(false); }
  }, []);
  /** 选择属于编辑状态，位置和尺寸始终来自正式页面模型。 */
  const selectObject = useCallback((id: string | null): void => { setSelection(id ? { kind: 'image', id } : null); }, []);
  const moveObject = useCallback((id: string, xMm: number, yMm: number): void => {
    if (albumId && pageId) void execute(() => window.desktop.movePageObject(albumId, pageId, id, xMm, yMm), '对象位置已修改，请保存。');
  }, [albumId, pageId, execute]);
  /** 控制点和尺寸表单共用一次几何提交；尺寸修改与移动一样进入手动保存草稿。 */
  const resizeObject = useCallback((id: string, geometry: ImageGeometry): Promise<boolean> => {
    return albumId && pageId ? execute(() => window.desktop.resizePageObject(albumId, pageId, id, geometry), '对象大小已修改，请保存。') : Promise.resolve(false);
  }, [albumId, pageId, execute]);
  const rotateObject = useCallback((id: string, angle: number): Promise<boolean> => {
    return albumId && pageId ? execute(() => window.desktop.rotatePageObject(albumId, pageId, id, angle), '对象角度已修改，请保存。') : Promise.resolve(false);
  }, [albumId, pageId, execute]);
  const editText = useCallback((object: TextObject): void => { setTextEditor({ object, mode: object.writingMode }); }, []);

  /** 名称随对象排版进入当前页草稿，恢复默认同样由主进程校验并更新。 */
  const renameObject = useCallback((id: string, name: string | null): Promise<boolean> => {
    return albumId && pageId ? execute(() => window.desktop.renamePageObject(albumId, pageId, id, name),
      name === null ? '已恢复默认名称，请保存。' : '对象已改名，请保存。') : Promise.resolve(false);
  }, [albumId, pageId, execute]);

  /** 列表拖动和四种菜单操作共用叠层接口，结果保留在当前页手动保存草稿中。 */
  const reorderObject = useCallback((id: string, targetIndex: number): Promise<boolean> => {
    return albumId && pageId ? execute(() => window.desktop.reorderPageObject(albumId, pageId, id, targetIndex), '图层顺序已修改，请保存。') : Promise.resolve(false);
  }, [albumId, pageId, execute]);

  /** 确认表单才创建/更新文字，选中真实返回 ID，文本内容从不写入图片目录。 */
  function submitText(draft: TextDraft): Promise<boolean> {
    if (!albumId || !pageId || !textEditor) return Promise.resolve(false);
    return execute(async () => {
      const result = await window.desktop.putPageText(albumId, pageId, textEditor.object?.id ?? null, draft, textEditor.position);
      if (result.status === 'success') setSelection({ kind: 'image', id: result.value });
      return result;
    }, '文字已更新，请保存。');
  }
  useEffect(() => {
    /** Delete 仅在画布或页面对象区域生效，输入框和素材树不触发真实文件删除。 */
    const onKey = (event: KeyboardEvent): void => {
      const target = event.target instanceof Element ? event.target : null;
      if (event.key !== 'Delete' || busy || !albumId || !pageId || !selection || document.querySelector('dialog[open]')
        || target?.closest('input, textarea, select, [contenteditable=true]') || !target?.closest('.canvas-panel, .pages-panel')) return;
      event.preventDefault();
      if (selection.kind === 'image') void execute(() => window.desktop.deletePageObject(albumId, pageId, selection.id), '选中对象已删除。');
      else void execute(() => window.desktop.deletePage(albumId, selection.id), '画布已删除，页码已更新。');
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [busy, albumId, pageId, selection, execute]);

  /** 根据可见区域调整缩放，不更改物理尺寸。 */
  function fitPage(): void {
    if (workspace.current) setZoom(Math.max(0.1, Math.min(2, (workspace.current.clientWidth - 96) / (size.width * mmToPixels),
      (workspace.current.clientHeight - 128) / (size.height * mmToPixels))));
  }
  /** 独立样例导出明确保留名称，真实画册 PDF 在后续阶段实现。 */
  async function exportSample(): Promise<void> {
    setExporting(true);
    try {
      const result = await window.desktop.exportSamplePdf();
      setMessage(result.canceled ? '已取消样例导出' : `样例已导出：${result.filePath}`);
    } catch (error) { setMessage(`样例导出失败：${String(error)}`); }
    finally { setExporting(false); }
  }
  /** 当前页 ID 显式传入，避免延迟事件写入刚切换的新页。 */
  function changeOrientation(value: Orientation): void {
    if (albumId && pageId && !busy) void execute(() => window.desktop.setPageOrientation(albumId, pageId, value), '编辑视角已修改，请保存。');
  }

  return <div className="app-shell" style={layoutStyle} data-app-ready={info && ready ? 'true' : undefined}>
    <header className="app-header"><div className="brand"><span className="brand-mark">册</span><div><strong>画册工坊</strong><span>留住每一页记忆</span></div></div>
      <div className="document-title">{state.album?.name ?? '尚未打开画册'}{state.canvas?.dirty && <span className="unsaved-mark"> · 未保存</span>}</div>
      <button className="primary-button" disabled={exporting || busy} onClick={() => { void exportSample(); }}>↗ {exporting ? '正在导出…' : '导出样例 PDF'}</button></header>
    <nav className="toolbar" aria-label="画册工具"><div className="toolbar-group">
      <button disabled={!ready || busy} data-new-project onClick={() => { void execute(() => window.desktop.createAlbum(), '画册已创建，请在右侧新建画布。'); }}>＋ 新建画册</button>
      <button disabled={!ready || busy} onClick={() => { void execute(() => window.desktop.openAlbum(), '画册已打开。'); }}>打开画册</button>
      <button disabled={busy || !state.canvas?.dirty} data-save-page onClick={() => { void execute(() => window.desktop.savePage(), '当前画布已保存。'); }}>保存</button></div>
      <span className="toolbar-divider" /><div className="toolbar-group"><span className="toolbar-instruction">从左侧拖入图片</span>
        {(['horizontal', 'vertical'] as const).map(mode => <button key={mode} data-add-text={mode} draggable={!!pageId && !busy}
          disabled={!pageId || busy} onClick={() => setTextEditor({ object: null, mode })} title="点击添加，或拖到画布指定位置"
          onDragStart={event => { event.dataTransfer.effectAllowed = 'copy'; event.dataTransfer.setData(textDragType, mode); }}>
          {mode === 'horizontal' ? '横排文字' : '竖排文字'}</button>)}</div>
      <div className="toolbar-note">手工排版 · 自由记录</div></nav>
    <main className="editor-layout"><AssetsPanel state={{ ...state, busy }} onMessage={setMessage} />
      <PanelDivider side="left" width={leftWidth} onChange={setLeftWidth} />
      <section className="canvas-panel" aria-label="画布编辑" tabIndex={-1} data-resizing={interacting}>
        <div className="canvas-toolbar"><div><strong>{current?.name ?? 'A4 画布'}</strong><span>{size.width} × {size.height} mm</span></div>
          <div className="segmented" aria-label="页面方向"><button disabled={!pageId || busy} data-orientation-button="portrait" aria-pressed={orientation === 'portrait'} onClick={() => changeOrientation('portrait')}>竖版</button>
            <button disabled={!pageId || busy} data-orientation-button="landscape" aria-pressed={orientation === 'landscape'} onClick={() => changeOrientation('landscape')}>横版</button></div></div>
        <div className="workspace" ref={workspace} data-workspace><div className="canvas-stage">
          {state.canvas && albumId ? <><div className="page-label">{current?.name}<span>A4 / {orientation === 'portrait' ? 'PORTRAIT' : 'LANDSCAPE'}</span></div>
            <div className="scaled-page" style={{ width: size.width * mmToPixels * zoom, height: size.height * mmToPixels * zoom }}>
              <div className="canvas-view" style={{ width: `${size.width}mm`, height: `${size.height}mm`, transform: `scale(${zoom})`, transformOrigin: 'top left' }}>
                <CanvasEditor key={`${albumId}/${pageId}`} canvas={state.canvas} albumId={albumId} zoom={zoom} busy={busy} selectedId={selectedId}
                  onSelect={selectObject} onMove={moveObject} onResize={resizeObject} onRotate={rotateObject} onEditText={editText}
                  onDropText={(mode, position) => setTextEditor({ object: null, mode, position })}
                  onInteraction={setInteracting} onMessage={setMessage} onDropAsset={path => {
                    if (pageId) void execute(() => window.desktop.addPageImage(albumId, pageId, path), '图片已加入当前画布并保存，可选中后拖动位置。');
                  }} /></div></div>
            <div className="canvas-hint">四角等比例 · 按住顶部图标旋转 · 双击文字编辑</div></>
            : <div className="no-page" data-no-page><span aria-hidden="true">▱</span><h2>{state.album ? '创建第一张画布' : '开始制作你的画册'}</h2>
              <p>{state.album ? '点击右侧“新建画布”，再从左侧拖入图片。' : '先新建或打开画册，再创建 A4 画布。'}</p></div>}
        </div></div>
        <div className="canvas-bottom"><span>{state.canvas?.dirty ? '当前画布有未保存修改' : pageId ? '画布已保存' : '尚无画布'}</span><div className="zoom-controls">
          <button aria-label="缩小画布" disabled={interacting} onClick={() => setZoom(value => Math.max(0.1, value - 0.1))}>−</button><output data-zoom-value={zoom}>{Math.round(zoom * 100)}%</output>
          <button aria-label="放大画布" data-zoom-in disabled={interacting} onClick={() => setZoom(value => Math.min(2, value + 0.1))}>＋</button>
          <span className="toolbar-divider" /><button data-fit-page disabled={!pageId || interacting} onClick={fitPage}>适应窗口</button></div></div>
      </section><PanelDivider side="right" width={rightWidth} onChange={setRightWidth} />
      <PagesPanel state={{ ...state, busy }} selectedId={selectedId} onResize={resizeObject} onRotate={rotateObject} onEditText={editText} onReorderObject={reorderObject} onRenameObject={renameObject}
        onSelectObject={id => setSelection({ kind: 'image', id })}
        onSelectPage={id => {
          if (id === pageId) setSelection({ kind: 'page', id });
          else if (albumId) void execute(() => window.desktop.selectPage(albumId, id), '画布已切换。');
        }} onCreate={(name, direction) => albumId ? execute(() => window.desktop.createPage(albumId, name, direction), '画布已创建。') : Promise.resolve(false)}
        onRename={(id, name) => albumId ? execute(() => window.desktop.renamePage(albumId, id, name), '画布已改名。') : Promise.resolve(false)}
        onReorder={(id, direction) => { if (albumId) void execute(() => window.desktop.reorderPage(albumId, id, direction), '页序已更新，固定目录编号保持。'); }}
        onDelete={id => { if (albumId) void execute(() => window.desktop.deletePage(albumId, id), '画布已删除，页码已更新。'); }} />
    </main><footer className="status-bar"><span className="status-message" role="status">{message}</span><span>本地画册 · A4</span><span>v{info?.version ?? '—'}</span></footer>
    {textEditor && <TextDialog object={textEditor.object} mode={textEditor.mode} fonts={fonts} busy={busy} onSubmit={submitText} onClose={() => setTextEditor(null)} />}
  </div>;
}
