/** 文件用途：管理画布页序、对象选择、画布命名和图片右键尺寸编辑。 */
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { AlbumState } from '../../../shared/album';
import type { Orientation } from '../../../shared/framework';
import type { CanvasObject, ImageGeometry, TextObject } from '../../../shared/canvas';
import { objectLabel } from '../../../shared/canvas';
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

/** 只展开当前页的对象，按叠层从高到低列出，选中被遮盖对象也能删除或移动。 */
export function PagesPanel({ state, selectedId, onSelectPage, onSelectObject, onResize, onRotate, onEditText, onCreate, onRename, onReorder, onDelete }: {
  state: AlbumState; selectedId: string | null;
  onSelectPage: (id: string) => void; onSelectObject: (id: string) => void;
  onResize: (id: string, geometry: ImageGeometry) => Promise<boolean>;
  onRotate: (id: string, angle: number) => Promise<boolean>; onEditText: (object: TextObject) => void;
  onCreate: (name: string, orientation: Orientation) => Promise<boolean>;
  onRename: (pageId: string, name: string) => Promise<boolean>;
  onReorder: (pageId: string, direction: -1 | 1) => void;
  onDelete: (pageId: string) => void;
}): React.JSX.Element {
  const { album, canvas, busy } = state;
  const [dialog, setDialog] = useState<{ mode: 'create' | 'rename'; pageId: string; name: string } | null>(null);
  const [menu, setMenu] = useState<{ object: CanvasObject; x: number; y: number } | null>(null);
  const [sizeObject, setSizeObject] = useState<CanvasObject | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  useEffect(() => { setDialog(null); }, [album?.id]);
  useEffect(() => { setMenu(null); setSizeObject(null); }, [album?.id, canvas?.pageId]);
  useEffect(() => {
    if (!menu) return;
    menuRef.current?.querySelector('button')?.focus();
    /** 菜单浮在窗口上，外部点击、Escape、滚动或失焦都关闭，不误改对象。 */
    const dismiss = (): void => setMenu(null);
    const pointer = (event: globalThis.PointerEvent): void => { if (!menuRef.current?.contains(event.target as Node)) dismiss(); };
    const keydown = (event: KeyboardEvent): void => { if (event.key === 'Escape') { event.preventDefault(); dismiss(); } };
    document.addEventListener('pointerdown', pointer, true); document.addEventListener('keydown', keydown);
    window.addEventListener('blur', dismiss); window.addEventListener('scroll', dismiss, true);
    return () => {
      document.removeEventListener('pointerdown', pointer, true); document.removeEventListener('keydown', keydown);
      window.removeEventListener('blur', dismiss); window.removeEventListener('scroll', dismiss, true);
    };
  }, [menu]);
  const current = album?.pages.find(page => page.id === canvas?.pageId);
  const index = album?.pages.findIndex(page => page.id === current?.id) ?? -1;
  return <aside className="side-panel pages-panel" aria-label="画布与对象">
    <div className="panel-heading"><h2>画布与对象</h2><span className="count-badge">{album?.pages.length ?? 0}</span></div>
    <div className="panel-subtitle">按页序排列 · 图片与文字对象</div>
    <button className="add-page" disabled={!album || busy} onClick={() => setDialog({ mode: 'create', pageId: '', name: `画布 ${(album?.pages.length ?? 0) + 1}` })}>＋ 新建画布</button>
    <div className="page-list">{album?.pages.map((page, number) => <div key={page.id}>
      <button className={`page-row ${page.id === current?.id ? 'selected' : ''}`} data-page-button={page.id}
        aria-current={page.id === current?.id ? 'page' : undefined} disabled={busy} onClick={() => onSelectPage(page.id)}
        title={`${page.name}${canvas?.pageId === page.id && canvas.dirty ? '（未保存修改）' : ''}`}>
        <span className="page-icon" aria-hidden="true" /><span className="page-row-label"><span className="page-title-line">
          <strong>{page.name}</strong>
          {/* 复用当前页真实草稿状态；标记独立于名称，长名称省略时仍然可见。 */}
          {canvas?.pageId === page.id && canvas.dirty && <span className="page-unsaved-marker" role="img" aria-label="未保存修改" title="未保存修改">*</span>}
        </span><small>第 {number + 1} 页 · A4</small></span>
        <span className="page-number">{String(number + 1).padStart(2, '0')}</span>
      </button>
      {canvas?.pageId === page.id && <div className="object-list">{[...canvas.document.objects].sort((a, b) => b.zIndex - a.zIndex).map(object =>
        <button key={object.id} data-object-button={object.id} className={selectedId === object.id ? 'selected' : ''}
          disabled={busy} aria-pressed={selectedId === object.id} onClick={() => onSelectObject(object.id)} title={objectLabel(object)}
          onContextMenu={event => {
            event.preventDefault(); if (busy) return;
            onSelectObject(object.id);
            const bounds = event.currentTarget.getBoundingClientRect();
            setMenu({ object, x: Math.max(8, Math.min(event.clientX || bounds.left, window.innerWidth - 200)),
              y: Math.max(8, Math.min(event.clientY || bounds.bottom, window.innerHeight - 190)) });
          }}>
          <span aria-hidden="true">{object.kind === 'image' ? '▧' : '文'}</span><span>{objectLabel(object)}</span></button>)}
        {!canvas.document.objects.length && <small>尚无对象</small>}</div>}
    </div>)}</div>
    {current && <><div className="page-actions"><button disabled={busy} onClick={() => setDialog({ mode: 'rename', pageId: current.id, name: current.name })}>改名</button>
      <button disabled={busy || index <= 0} onClick={() => onReorder(current.id, -1)}>上移</button>
      <button disabled={busy || index >= (album?.pages.length ?? 0) - 1} onClick={() => onReorder(current.id, 1)}>下移</button>
      <button disabled={busy} onClick={() => onDelete(current.id)}>删除画布</button></div>
      <div className="page-details"><h3>当前画布</h3><dl><div><dt>纸张</dt><dd>A4</dd></div><div><dt>编辑方向</dt><dd>{canvas?.document.orientation === 'landscape' ? '横版' : '竖版'}</dd></div>
        <div><dt>页码</dt><dd>{index + 1}</dd></div><div><dt>对象</dt><dd>{canvas?.document.objects.length ?? 0} 个</dd></div></dl></div></>}
    {!!canvas?.warnings.length && <div className="page-warning" role="status">{canvas.warnings.join('\n')}</div>}
    <div className="panel-footer">{canvas?.dirty ? '当前画布有未保存修改' : current ? '右击对象可编辑或调整大小' : '尚未创建画布'}</div>
    {dialog && <PageDialog mode={dialog.mode} name={dialog.name} busy={busy} onClose={() => setDialog(null)}
      onSubmit={(name, orientation) => dialog.mode === 'create' ? onCreate(name, orientation) : onRename(dialog.pageId, name)} />}
    {menu && createPortal(<div className="image-context-menu" ref={menuRef} role="menu" aria-label="图片操作" style={{ left: menu.x, top: menu.y }}>
      <button type="button" role="menuitem" disabled={busy} onClick={() => { setSizeObject(menu.object); setMenu(null); }}>调整{menu.object.kind === 'image' ? '图片' : '文字'}大小…</button>
      {menu.object.kind === 'text' && <button type="button" role="menuitem" disabled={busy} onClick={() => { if (menu.object.kind === 'text') onEditText(menu.object); setMenu(null); }}>编辑文字…</button>}
      <button type="button" role="menuitem" disabled={busy} onClick={() => { void onRotate(menu.object.id, menu.object.rotation + 90); setMenu(null); }}>顺时针旋转 90°</button>
      <button type="button" role="menuitem" disabled={busy} onClick={() => { void onRotate(menu.object.id, menu.object.rotation - 90); setMenu(null); }}>逆时针旋转 90°</button>
    </div>, document.body)}
    {sizeObject && canvas && <ImageSizeDialog object={sizeObject} busy={busy}
      onClose={() => setSizeObject(null)} onSubmit={geometry => onResize(sizeObject.id, geometry)} />}
  </aside>;
}
