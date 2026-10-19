/** 文件用途：管理画布页序、对象图层拖动排序及图片/文字右键编辑。 */
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { AlbumPageReference, AlbumState } from '../../../shared/album';
import type { Orientation } from '../../../shared/framework';
import type { CanvasObject, ImageGeometry, TextObject } from '../../../shared/canvas';
import { defaultObjectLabel, objectLabel, objectNameError } from '../../../shared/canvas';
import { ImageSizeDialog } from './ImageSizeDialog';

/** 新建与改名共用表单，名称仅用于显示，不作为目录路径。 */
function PageDialog({ mode, name: initial, busy, onSubmit, onClose }: {
  mode: 'create' | 'rename'; name: string; busy: boolean;
  onSubmit: (name: string, orientation: Orientation) => Promise<boolean>; onClose: () => void;
}): React.JSX.Element {
  const ref = useRef<HTMLDialogElement>(null);
  const [name, setName] = useState(initial);
  const [orientation, setOrientation] = useState<Orientation>('portrait');
  useEffect(() => { const dialog = ref.current; dialog?.showModal(); return () => dialog?.close(); }, []);
  return <dialog ref={ref} className="group-dialog page-dialog" aria-labelledby="page-dialog-title"
    onCancel={event => { event.preventDefault(); if (!busy) onClose(); }}>
    <form onSubmit={event => {
      event.preventDefault();
      if (!busy) void onSubmit(name, orientation).then(ok => { if (ok) onClose(); });
    }}>
      <h2 id="page-dialog-title">{mode === 'create' ? '新建画布' : '重命名画布'}</h2>
      <label htmlFor="page-name">画布名称</label>
      <input id="page-name" autoFocus required maxLength={120} value={name} disabled={busy} onChange={event => setName(event.target.value)} />
      {mode === 'create' && <><label htmlFor="page-orientation">编辑方向 · A4</label><select id="page-orientation" value={orientation}
        disabled={busy} onChange={event => setOrientation(event.target.value as Orientation)}><option value="portrait">竖版 · 210 × 297 mm</option>
        <option value="landscape">横版 · 297 × 210 mm</option></select></>}
      <div className="dialog-actions"><button type="button" disabled={busy} onClick={onClose}>取消</button>
        <button className="primary-button" disabled={busy || !name.trim()} type="submit">{mode === 'create' ? '创建' : '确定'}</button></div>
    </form>
  </dialog>;
}

/** 对象名称独立于图片文件与文字正文；确认或恢复默认才修改草稿，失败时保留输入。 */
function ObjectNameDialog({ object, busy, onSubmit, onClose }: {
  object: CanvasObject; busy: boolean;
  onSubmit: (name: string | null) => Promise<boolean>; onClose: () => void;
}): React.JSX.Element {
  const ref = useRef<HTMLDialogElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [name, setName] = useState(objectLabel(object));
  const error = objectNameError(name);
  useEffect(() => {
    const dialog = ref.current; dialog?.showModal(); inputRef.current?.select();
    return () => dialog?.close();
  }, []);
  /** 两个确认入口共用成功关闭规则；取消和输入中的文字不写入页面。 */
  async function submit(value: string | null): Promise<void> {
    if (!busy && await onSubmit(value)) onClose();
  }
  return <dialog ref={ref} className="group-dialog object-name-dialog" aria-labelledby="object-name-title"
    onCancel={event => { event.preventDefault(); if (!busy) onClose(); }}>
    <form onSubmit={event => { event.preventDefault(); if (!error) void submit(name); }}
      onKeyDown={event => { if (event.key === 'Enter' && event.nativeEvent.isComposing) event.preventDefault(); }}>
      <h2 id="object-name-title">{object.kind === 'image' ? '重命名图片' : '重命名文字'}</h2>
      <label htmlFor="object-name">对象名称</label>
      <input ref={inputRef} id="object-name" autoFocus required maxLength={120} value={name} disabled={busy}
        aria-invalid={!!error} aria-describedby={error ? 'object-name-error' : 'object-name-help'}
        onChange={event => setName(event.target.value)} />
      <p id="object-name-help">名称随当前画布保存，最多 120 字。</p>
      {error && <p id="object-name-error" className="object-name-error" role="alert">{error}</p>}
      <p>默认名称：{defaultObjectLabel(object)}</p>
      <button type="button" className="restore-object-name" disabled={busy || object.displayName === undefined}
        onClick={() => { void submit(null); }}>恢复默认名称</button>
      <div className="dialog-actions"><button type="button" disabled={busy} onClick={onClose}>取消</button>
        <button className="primary-button" type="submit" disabled={busy || !!error}>确定</button></div>
    </form>
  </dialog>;
}

/** 只展开当前页的对象，按叠层从高到低列出，选中被遮盖对象也能删除或移动。 */
export function PagesPanel({ state, selectedId, onSelectPage, onSelectObject, onResize, onRotate, onEditText, onReorderObject, onRenameObject, onCreate, onRename, onReorder, onDelete }: {
  state: AlbumState; selectedId: string | null;
  onSelectPage: (id: string) => void; onSelectObject: (id: string) => void;
  onResize: (id: string, geometry: ImageGeometry) => Promise<boolean>;
  onRotate: (id: string, angle: number) => Promise<boolean>; onEditText: (object: TextObject) => void;
  onReorderObject: (id: string, targetIndex: number) => Promise<boolean>;
  onRenameObject: (id: string, name: string | null) => Promise<boolean>;
  onCreate: (name: string, orientation: Orientation) => Promise<boolean>;
  onRename: (pageId: string, name: string) => Promise<boolean>;
  onReorder: (pageId: string, direction: -1 | 1) => void;
  onDelete: (pageId: string) => void;
}): React.JSX.Element {
  const { album, canvas, busy } = state;
  const [dialog, setDialog] = useState<{ mode: 'create' | 'rename'; pageId: string; name: string } | null>(null);
  const [menu, setMenu] = useState<{ object: CanvasObject; x: number; y: number } | null>(null);
  const [pageMenu, setPageMenu] = useState<{ page: AlbumPageReference; x: number; y: number } | null>(null);
  const [sizeObject, setSizeObject] = useState<CanvasObject | null>(null);
  const [nameDialog, setNameDialog] = useState<{ albumId: string; pageId: string; object: CanvasObject } | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const layerDrag = useRef<{ id: string; albumId: string; pageId: string } | null>(null);
  const [draggedId, setDraggedId] = useState<string | null>(null);
  const [insertion, setInsertion] = useState<{ id: string; side: 'before' | 'after' } | null>(null);
  const layers = [...(canvas?.document.objects ?? [])].sort((a, b) => b.zIndex - a.zIndex);
  const menuIndex = layers.findIndex(item => item.id === menu?.object.id);

  /** 拖动只在本列表预览插入线；取消、失焦或切页均清理，不提交半途顺序。 */
  function cancelLayerDrag(): void {
    layerDrag.current = null; setDraggedId(null); setInsertion(null);
  }
  useEffect(() => { cancelLayerDrag(); }, [album?.id, canvas?.pageId, busy]);
  useEffect(() => {
    const cancel = (): void => cancelLayerDrag();
    const key = (event: KeyboardEvent): void => { if (event.key === 'Escape') cancel(); };
    window.addEventListener('blur', cancel); document.addEventListener('keydown', key, true);
    return () => { window.removeEventListener('blur', cancel); document.removeEventListener('keydown', key, true); };
  }, []);
  // 菜单高度随对象类型和操作变化，按真实高度限制到窗口内，小窗口允许滚动。
  useLayoutEffect(() => {
    const element = menuRef.current;
    const activeMenu = menu ?? pageMenu;
    if (activeMenu && element) element.style.top = `${Math.max(8, Math.min(activeMenu.y, window.innerHeight - element.getBoundingClientRect().height - 8))}px`;
  }, [menu, pageMenu]);
  useEffect(() => { setDialog(null); }, [album?.id]);
  useEffect(() => { setMenu(null); setPageMenu(null); setSizeObject(null); setNameDialog(null); }, [album?.id, canvas?.pageId]);
  useEffect(() => {
    if (!menu && !pageMenu) return;
    menuRef.current?.querySelector('button')?.focus({ preventScroll: true });
    /** 菜单浮在窗口上，外部点击、Escape、滚动或失焦都关闭，不误改对象。 */
    const dismiss = (): void => { setMenu(null); setPageMenu(null); };
    const pointer = (event: globalThis.PointerEvent): void => { if (!menuRef.current?.contains(event.target as Node)) dismiss(); };
    const keydown = (event: KeyboardEvent): void => { if (event.key === 'Escape') { event.preventDefault(); dismiss(); } };
    document.addEventListener('pointerdown', pointer, true); document.addEventListener('keydown', keydown);
    window.addEventListener('blur', dismiss); window.addEventListener('scroll', dismiss, true);
    return () => {
      document.removeEventListener('pointerdown', pointer, true); document.removeEventListener('keydown', keydown);
      window.removeEventListener('blur', dismiss); window.removeEventListener('scroll', dismiss, true);
    };
  }, [menu, pageMenu]);
  const current = album?.pages.find(page => page.id === canvas?.pageId);
  const index = album?.pages.findIndex(page => page.id === current?.id) ?? -1;
  const pageMenuIndex = album?.pages.findIndex(page => page.id === pageMenu?.page.id) ?? -1;
  return <aside className="side-panel pages-panel" aria-label="画布与对象">
    <div className="panel-heading"><h2>画布与对象</h2><span className="count-badge">{album?.pages.length ?? 0}</span></div>
    <div className="panel-subtitle">右击画布管理 · 对象上方为顶层</div>
    <button className="add-page" disabled={!album || busy} onClick={() => setDialog({ mode: 'create', pageId: '', name: `画布 ${(album?.pages.length ?? 0) + 1}` })}>＋ 新建画布</button>
    <div className="page-list">{album?.pages.map((page, number) => <div key={page.id}>
      <button className={`page-row ${page.id === current?.id ? 'selected' : ''}`} data-page-button={page.id}
        aria-current={page.id === current?.id ? 'page' : undefined} disabled={busy} onClick={() => onSelectPage(page.id)}
        onContextMenu={event => {
          event.preventDefault(); if (busy) return;
          // 操作始终指向右击的画布，不必先切页，避免误操作当前画布或触发无关保存提示。
          const bounds = event.currentTarget.getBoundingClientRect(); setMenu(null);
          setPageMenu({ page, x: Math.max(8, Math.min(event.clientX || bounds.left, window.innerWidth - 200)),
            y: event.clientY || bounds.bottom });
        }}
        title={`${page.name}${canvas?.pageId === page.id && canvas.dirty ? '（未保存修改）' : ''}`}>
        <span className="page-icon" aria-hidden="true" /><span className="page-row-label"><span className="page-title-line">
          <strong>{page.name}</strong>
          {/* 复用当前页真实草稿状态；标记独立于名称，长名称省略时仍然可见。 */}
          {canvas?.pageId === page.id && canvas.dirty && <span className="page-unsaved-marker" role="img" aria-label="未保存修改" title="未保存修改">*</span>}
        </span><small>第 {number + 1} 页 · A4</small></span>
        <span className="page-number">{String(number + 1).padStart(2, '0')}</span>
      </button>
      {canvas?.pageId === page.id && <div className="object-list" onDragLeave={event => {
        if (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget)) setInsertion(null);
      }}>{layers.map((object, layerIndex) =>
        <button key={object.id} data-object-button={object.id}
          className={`${selectedId === object.id ? 'selected' : ''} ${draggedId === object.id ? 'layer-dragging' : ''} ${insertion?.id === object.id ? `layer-insert-${insertion.side}` : ''}`}
          draggable={!busy} onDragStart={event => {
            if (busy || !album) { event.preventDefault(); return; }
            layerDrag.current = { id: object.id, albumId: album.id, pageId: page.id };
            event.dataTransfer.setData('application/x-album-layer', object.id); event.dataTransfer.effectAllowed = 'move';
            setDraggedId(object.id); setMenu(null); onSelectObject(object.id);
          }} onDragEnd={cancelLayerDrag}
          onDragOver={event => {
            const source = layerDrag.current;
            if (busy || !source || source.albumId !== album?.id || source.pageId !== page.id) return;
            event.preventDefault(); event.dataTransfer.dropEffect = 'move';
            const bounds = event.currentTarget.getBoundingClientRect();
            const side = event.clientY < bounds.top + bounds.height / 2 ? 'before' : 'after';
            setInsertion(previous => previous?.id === object.id && previous.side === side ? previous : { id: object.id, side });
          }} onDrop={event => {
            const source = layerDrag.current;
            if (busy || !source || source.albumId !== album?.id || source.pageId !== page.id) return;
            event.preventDefault();
            const bounds = event.currentTarget.getBoundingClientRect();
            const slot = layerIndex + (event.clientY < bounds.top + bounds.height / 2 ? 0 : 1);
            const sourceIndex = layers.findIndex(item => item.id === source.id);
            // 插入点先以原列表计算，再扣除移走源行占用的位置；只在松手时提交一次。
            const targetIndex = slot - (sourceIndex < slot ? 1 : 0);
            cancelLayerDrag();
            if (sourceIndex >= 0 && sourceIndex !== targetIndex) void onReorderObject(source.id, targetIndex);
          }}
          disabled={busy} aria-pressed={selectedId === object.id} onClick={() => onSelectObject(object.id)}
          title={object.kind === 'image' ? `${objectLabel(object)}\n来源文件：${object.sourceName}` : objectLabel(object)}
          onContextMenu={event => {
            event.preventDefault(); if (busy) return;
            setPageMenu(null); onSelectObject(object.id);
            const bounds = event.currentTarget.getBoundingClientRect();
            setMenu({ object, x: Math.max(8, Math.min(event.clientX || bounds.left, window.innerWidth - 200)),
              y: Math.max(8, Math.min(event.clientY || bounds.bottom, window.innerHeight - 190)) });
          }}>
          <span className="layer-grip" aria-hidden="true">⠿</span><span aria-hidden="true">{object.kind === 'image' ? '▧' : '文'}</span><span>{objectLabel(object)}</span></button>)}
        {!canvas.document.objects.length && <small>尚无对象</small>}</div>}
    </div>)}</div>
    {current && <>
      <div className="page-details"><h3>当前画布</h3><dl><div><dt>纸张</dt><dd>A4</dd></div><div><dt>编辑方向</dt><dd>{canvas?.document.orientation === 'landscape' ? '横版' : '竖版'}</dd></div>
        <div><dt>页码</dt><dd>{index + 1}</dd></div><div><dt>对象</dt><dd>{canvas?.document.objects.length ?? 0} 个</dd></div></dl></div></>}
    {!!canvas?.warnings.length && <div className="page-warning" role="status">{canvas.warnings.join('\n')}</div>}
    <div className="panel-footer">{canvas?.dirty ? '当前画布有未保存修改' : current ? '拖动对象调整图层 · 右击查看更多操作' : '尚未创建画布'}</div>
    {dialog && <PageDialog mode={dialog.mode} name={dialog.name} busy={busy} onClose={() => setDialog(null)}
      onSubmit={(name, orientation) => dialog.mode === 'create' ? onCreate(name, orientation) : onRename(dialog.pageId, name)} />}
    {pageMenu && createPortal(<div className="image-context-menu" ref={menuRef} role="menu" aria-label="画布操作" style={{ left: pageMenu.x, top: pageMenu.y }}>
      <button type="button" role="menuitem" disabled={busy} onClick={() => {
        setDialog({ mode: 'rename', pageId: pageMenu.page.id, name: pageMenu.page.name }); setPageMenu(null);
      }}>改名</button>
      <button type="button" role="menuitem" disabled={busy || pageMenuIndex <= 0} onClick={() => { onReorder(pageMenu.page.id, -1); setPageMenu(null); }}>画布上移</button>
      <button type="button" role="menuitem" disabled={busy || pageMenuIndex < 0 || pageMenuIndex >= (album?.pages.length ?? 0) - 1}
        onClick={() => { onReorder(pageMenu.page.id, 1); setPageMenu(null); }}>画布下移</button>
      <button type="button" role="menuitem" disabled={busy} onClick={() => { onDelete(pageMenu.page.id); setPageMenu(null); }}>删除画布</button>
    </div>, document.body)}
    {menu && createPortal(<div className="image-context-menu" ref={menuRef} role="menu" aria-label="对象操作" style={{ left: menu.x, top: menu.y }}>
      <button type="button" role="menuitem" disabled={busy || !album || !canvas} data-rename-object onClick={() => {
        if (album && canvas) setNameDialog({ albumId: album.id, pageId: canvas.pageId, object: menu.object });
        setMenu(null);
      }}>改名</button>
      <button type="button" role="menuitem" disabled={busy} onClick={() => { setSizeObject(menu.object); setMenu(null); }}>调整{menu.object.kind === 'image' ? '图片' : '文字'}大小</button>
      {menu.object.kind === 'text' && <button type="button" role="menuitem" disabled={busy} onClick={() => { if (menu.object.kind === 'text') onEditText(menu.object); setMenu(null); }}>编辑文字</button>}
      <button type="button" role="menuitem" disabled={busy} onClick={() => { void onRotate(menu.object.id, menu.object.rotation + 90); setMenu(null); }}>顺时针旋转 90°</button>
      <button type="button" role="menuitem" disabled={busy} onClick={() => { void onRotate(menu.object.id, menu.object.rotation - 90); setMenu(null); }}>逆时针旋转 90°</button>
      <div className="context-menu-separator" role="separator" />
      {([{ action: 'up', label: '上移一层', target: menuIndex - 1 },
        { action: 'down', label: '下移一层', target: menuIndex + 1 },
        { action: 'top', label: '置顶', target: 0 },
        { action: 'bottom', label: '置底', target: layers.length - 1 }] as const).map(item =>
        <button key={item.action} type="button" role="menuitem" data-layer-action={item.action}
          disabled={busy || menuIndex < 0 || item.target < 0 || item.target >= layers.length || item.target === menuIndex}
          onClick={() => { void onReorderObject(menu.object.id, item.target); setMenu(null); }}>{item.label}</button>)}
    </div>, document.body)}
    {sizeObject && canvas && <ImageSizeDialog object={sizeObject} busy={busy}
      onClose={() => setSizeObject(null)} onSubmit={geometry => onResize(sizeObject.id, geometry)} />}
    {nameDialog && nameDialog.albumId === album?.id && nameDialog.pageId === canvas?.pageId
      && canvas.document.objects.some(object => object.id === nameDialog.object.id)
      && <ObjectNameDialog object={nameDialog.object} busy={busy} onClose={() => setNameDialog(null)}
        onSubmit={name => onRenameObject(nameDialog.object.id, name)} />}
  </aside>;
}
