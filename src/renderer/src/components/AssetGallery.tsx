/** 文件用途：按分组浏览素材缩略图，只挂载可见区域附近的小图并在离开时释放租约。 */
import { useEffect, useMemo, useRef, useState } from 'react';
import type { DragEvent, RefObject } from 'react';
import type { AssetEntry } from '../../../shared/album';
import { useAssetImage } from './AssetPreview';

type ImageEntry = Extract<AssetEntry, { kind: 'image' }>;

/** 缩略图失败仅影响当前卡片，重试要求后台重建此缓存。 */
function ThumbnailImage({ albumId, entry }: { albumId: string; entry: ImageEntry }): React.JSX.Element {
  const image = useAssetImage(albumId, entry.path, 'thumbnail');
  return <>
    {image.source && !image.error && <img src={image.source} alt={entry.name} decoding="async" draggable={false}
      data-asset-thumbnail onLoad={image.onLoad} onError={image.onError} />}
    {!image.loaded && !image.error && <span className="asset-image-status" role="status">加载中…</span>}
    {image.error && <div className="asset-image-status asset-thumbnail-error" title={image.error}>
      <span>预览失败</span><button type="button" onClick={event => { event.stopPropagation(); image.retry(); }}
        onDoubleClick={event => event.stopPropagation()}>重试</button></div>}
  </>;
}

/** 每张卡片独立观察滚动容器，避免滚动时刷新整棵素材树；远处图片卸载后取消待生成任务。 */
function ThumbnailCard({ albumId, entry, scrollRoot, locked, onPreview, onDragAsset }: {
  albumId: string; entry: ImageEntry; scrollRoot: RefObject<HTMLDivElement | null>; locked: boolean;
  onPreview: (path: string) => void; onDragAsset: (event: DragEvent<HTMLDivElement>, path: string) => void;
}): React.JSX.Element {
  const card = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const observer = new IntersectionObserver(entries => {
      const entry = entries[0];
      if (entry) setVisible(entry.isIntersecting);
    }, { root: scrollRoot.current, rootMargin: '160px 0px' });
    if (card.current) observer.observe(card.current);
    return () => observer.disconnect();
  }, [scrollRoot]);
  return <div ref={card} className="asset-thumbnail-card" data-thumbnail-card={entry.path}
    role="button" tabIndex={locked ? -1 : 0} aria-disabled={locked} aria-label={`预览 ${entry.path}`}
    title={`双击预览，或拖入当前画布：${entry.path}`} draggable={!locked}
    onDragStart={event => onDragAsset(event, entry.path)}
    onDoubleClick={() => { if (!locked) onPreview(entry.path); }}
    onKeyDown={event => {
      if (event.target !== event.currentTarget) return;
      if (!locked && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); onPreview(entry.path); }
    }}>
    <div className="asset-thumbnail-picture">{visible ? <ThumbnailImage albumId={albumId} entry={entry} /> : <span aria-hidden="true">▧</span>}</div>
    <span className="asset-thumbnail-name">{entry.name}</span>
    <span className="asset-thumbnail-path">{entry.path.includes('/') ? entry.path.slice(0, entry.path.lastIndexOf('/')) : '素材库'}</span>
  </div>;
}

/** 根目录查看所有素材，分组查看自身与子分组；只遍历名称元数据，不提前读取图片文件。 */
export function AssetGallery({ albumId, entries, selectedPath, scrollRoot, locked, onSelectDirectory, onPreview, onDragAsset }: {
  albumId: string; entries: AssetEntry[]; selectedPath: string; scrollRoot: RefObject<HTMLDivElement | null>; locked: boolean;
  onSelectDirectory: (path: string) => void; onPreview: (path: string) => void;
  onDragAsset: (event: DragEvent<HTMLDivElement>, path: string) => void;
}): React.JSX.Element {
  const { images, directories } = useMemo(() => {
    const images: ImageEntry[] = [];
    const directories: string[] = [];
    /** 保持目录树的排序，递归只处理轻量列表数据。 */
    function collect(items: AssetEntry[]): void {
      for (const item of items) {
        if (item.kind === 'directory') { directories.push(item.path); collect(item.children); }
        else if (!selectedPath || item.path.startsWith(`${selectedPath}/`)) images.push(item);
      }
    }
    collect(entries);
    return { images, directories };
  }, [entries, selectedPath]);
  return <div className="asset-gallery">
    <label className="asset-gallery-filter">浏览分组<select aria-label="浏览素材分组" value={selectedPath} disabled={locked}
      onChange={event => onSelectDirectory(event.target.value)}>
      <option value="">全部素材</option>{directories.map(path => <option key={path} value={path}>{path}</option>)}
    </select><span>{images.length} 张 · 包含子分组</span></label>
    {images.length ? <div className="asset-thumbnail-grid">{images.map(entry => <ThumbnailCard key={entry.path}
      albumId={albumId} entry={entry} scrollRoot={scrollRoot} locked={locked} onPreview={onPreview} onDragAsset={onDragAsset} />)}</div>
      : <p className="asset-gallery-empty">此分组还没有图片</p>}
  </div>;
}
