/** 文件用途：显示真实素材目录树，处理分组、批量导入及逐项结果反馈。 */
import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import type { AlbumState, AssetEntry, ImportReport } from '../../../shared/album';
import { assetDragType } from '../../../shared/canvas';

interface AssetsPanelProps {
  state: AlbumState;
  onMessage: (message: string) => void;
}

/** 使用原生模态对话框约束焦点；提交期间禁止重复操作和关闭。 */
function GroupDialog({ busy, target, onCreate, onClose }: {
  busy: boolean; target: string; onCreate: (name: string) => Promise<boolean>; onClose: () => void;
}): React.JSX.Element {
  const dialog = useRef<HTMLDialogElement>(null);
  const [name, setName] = useState('');
  useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    return () => { element?.close(); };
  }, []);

  /** 名称原样交给主进程验证，避免悄悄更改用户输入或绕过 Windows 名称约定。 */
  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (!busy && await onCreate(name)) onClose();
  }

  return <dialog className="group-dialog" ref={dialog} aria-labelledby="group-dialog-title"
    onCancel={event => { event.preventDefault(); if (!busy) onClose(); }}>
    <form onSubmit={event => { void submit(event); }}>
      <h2 id="group-dialog-title">新建素材分组</h2>
      <p>创建位置：{target || '素材库'}</p>
      <label htmlFor="group-name">分组名称</label>
      <input id="group-name" value={name} onChange={event => setName(event.target.value)}
        autoFocus required maxLength={120} disabled={busy} autoComplete="off" />
      <div className="dialog-actions"><button type="button" onClick={onClose} disabled={busy}>取消</button>
        <button className="primary-button" type="submit" disabled={busy || !name}>创建</button></div>
    </form>
  </dialog>;
}

/** 只把展开目录挂载到界面；叶子显示文件名，不加载整批原图。 */
export function AssetsPanel({ state, onMessage }: AssetsPanelProps): React.JSX.Element {
  const { album, busy, progress } = state;
  const [selectedPath, setSelectedPath] = useState('');
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [creatingGroup, setCreatingGroup] = useState(false);
  const [report, setReport] = useState<ImportReport | null>(null);
  const [localPending, setLocalPending] = useState(false);
  const locked = busy || localPending;

  useEffect(() => {
    setSelectedPath('');
    setExpanded(new Set());
    setCreatingGroup(false);
    setReport(null);
  }, [album?.id]);

  useEffect(() => {
    if (!album || !selectedPath) return;
    /** 刷新时目录可能已被外部移除，选中位置回到根目录。 */
    function exists(entries: AssetEntry[]): boolean {
      return entries.some(entry => entry.kind === 'directory' && (entry.path === selectedPath || exists(entry.children)));
    }
    if (!exists(album.assets)) setSelectedPath('');
  }, [album, selectedPath]);

  /** 展开只影响浏览，不改变导入位置；点击目录名称才选择目标。 */
  function toggle(path: string): void {
    setExpanded(previous => {
      const next = new Set(previous);
      if (next.has(path)) next.delete(path); else next.add(path);
      return next;
    });
  }

  /** 原生多选框提供源文件，取消保留已有结果，失败逐项展示。 */
  async function importImages(): Promise<void> {
    if (!album || locked) return;
    setLocalPending(true);
    try {
      const result = await window.desktop.importAssets(album.id, selectedPath);
      if (result.status === 'success') {
        setReport(result.value);
        onMessage(`导入完成：成功 ${result.value.succeeded.length} 张，失败 ${result.value.failed.length} 项。`);
        if (selectedPath) setExpanded(previous => new Set([...previous, selectedPath]));
      } else if (result.status === 'error') onMessage(`导入失败：${result.message}`);
      else onMessage('已取消导入图片');
    } catch { onMessage('桌面接口连接失败，请重试。'); }
    finally { setLocalPending(false); }
  }

  /** 在当前选中目录创建分组，成功后展开父目录并选中新分组。 */
  async function createGroup(name: string): Promise<boolean> {
    if (!album || locked) return false;
    setLocalPending(true);
    try {
      const result = await window.desktop.createAssetGroup(album.id, selectedPath, name);
      if (result.status === 'success') {
        const path = selectedPath ? `${selectedPath}/${name}` : name;
        setExpanded(previous => new Set([...previous, selectedPath]));
        setSelectedPath(path);
        onMessage(`已创建素材分组：${path}`);
        return true;
      }
      if (result.status === 'error') onMessage(result.message);
      return false;
    } catch { onMessage('桌面接口连接失败，请重试。'); return false; }
    finally { setLocalPending(false); }
  }

  /** 重新扫描真实目录，保留仍存在的分组选择。 */
  async function refresh(): Promise<void> {
    if (!album || locked) return;
    setLocalPending(true);
    try {
      const result = await window.desktop.refreshAssets(album.id);
      onMessage(result.status === 'error' ? result.message : '素材列表已刷新');
    } catch { onMessage('桌面接口连接失败，请重试。'); }
    finally { setLocalPending(false); }
  }

  /** 使用原生按钮支持 Tab、Enter、空格，不把文件名当作 HTML 渲染。 */
  function renderEntries(entries: AssetEntry[]): React.JSX.Element {
    return <ul className="asset-tree">{entries.map(entry => <li key={entry.path}>
      {entry.kind === 'directory' ? <>
        <div className={`asset-directory ${selectedPath === entry.path ? 'selected' : ''}`}>
          <button className="asset-toggle" aria-label={`${expanded.has(entry.path) ? '折叠' : '展开'} ${entry.name}`}
            aria-expanded={expanded.has(entry.path)} disabled={locked} onClick={() => toggle(entry.path)}>
            {expanded.has(entry.path) ? '▾' : '▸'}</button>
          <button className="asset-name" title={entry.path} aria-pressed={selectedPath === entry.path}
            data-asset-directory={entry.path} disabled={locked} onClick={() => {
              setSelectedPath(entry.path); setExpanded(previous => new Set([...previous, entry.path]));
            }}><span className="asset-folder" aria-hidden="true">▱</span><span>{entry.name}</span></button>
        </div>
        {expanded.has(entry.path) && (entry.children.length ? renderEntries(entry.children) : <p className="asset-folder-empty">空分组</p>)}
      </> : <div className="asset-file" title={`拖入当前画布：${entry.path}`} data-asset-file={entry.path} draggable={!locked}
        onDragStart={event => {
          if (!album || locked) { event.preventDefault(); return; }
          event.dataTransfer.effectAllowed = 'copy';
          event.dataTransfer.setData(assetDragType, JSON.stringify({ albumId: album.id, assetPath: entry.path }));
          if (!state.canvas) onMessage('请先在右侧新建画布，再拖入图片。');
        }}>
        <span aria-hidden="true">▧</span><span>{entry.name}</span></div>}
    </li>)}</ul>;
  }

  return <aside className="side-panel assets-panel" data-left-panel aria-label="图片素材" aria-busy={locked}>
    <div className="panel-heading"><h2>图片素材</h2><span className="count-badge" data-asset-count>{album?.imageCount ?? 0}</span></div>
    <div className="panel-subtitle">{album ? '选择分组，收集这一册的照片' : '让故事从一张照片开始'}</div>
    <button className="import-button" disabled={!album || locked} onClick={() => { void importImages(); }}
      title={!album ? '请先新建或打开画册' : `导入到：${selectedPath || '素材库'}`}>＋ {progress ? '正在导入…' : '导入图片'}</button>
    <div className="asset-actions"><button disabled={!album || locked} onClick={() => setCreatingGroup(true)}>＋ 新建分组</button>
      <button disabled={!album || locked} onClick={() => { void refresh(); }}>刷新</button></div>
    <button className={`assets-root ${selectedPath === '' && album ? 'selected' : ''}`} disabled={!album || locked}
      aria-pressed={selectedPath === ''} onClick={() => setSelectedPath('')} data-asset-root>
      <span className="folder-symbol" aria-hidden="true">▱</span>素材库</button>
    {album && <div className="asset-target" title={selectedPath || '素材库'}>导入位置：{selectedPath || '素材库'}</div>}
    {progress && <div className="import-progress" role="status"><progress max={progress.total} value={progress.completed} />
      <span>{progress.completed} / {progress.total} · {progress.fileName}</span></div>}
    <div className="asset-scroll">
      {album?.assets.length ? renderEntries(album.assets) : <div className="asset-empty"><div className="empty-symbol" aria-hidden="true">▧</div>
        <strong>这里还没有图片</strong><p>{album ? '导入 JPEG、PNG 图片，或新建分组。' : <>新建或打开画册后，<br />在这里管理你的素材。</>}</p></div>}
    </div>
    {!!album?.warnings.length && <details className="asset-notice"><summary>目录提示（{album.warnings.length}）</summary>
      <ul>{album.warnings.map(warning => <li key={warning}>{warning}</li>)}</ul></details>}
    {report && <details className="import-report" open={report.failed.length > 0 || report.warnings.length > 0}>
      <summary>导入结果：成功 {report.succeeded.length}，失败 {report.failed.length}</summary>
      <ul>{report.failed.map((item, index) => <li key={`failure-${index}`} className="import-failure">{item.sourceName}：{item.reason}</li>)}
        {report.succeeded.map(item => <li key={item.savedPath}>{item.sourceName} → {item.savedPath}</li>)}
        {report.warnings.map((warning, index) => <li key={`warning-${index}`} className="import-failure">{warning}</li>)}</ul>
    </details>}
    <div className="panel-footer">{album ? '素材已直接保存到画册目录' : '素材将保存在画册的 assets 目录'}</div>
    {creatingGroup && <GroupDialog busy={locked} target={selectedPath} onCreate={createGroup} onClose={() => setCreatingGroup(false)} />}
  </aside>;
}
