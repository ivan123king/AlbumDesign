/** 文件用途：按浏览租约加载单张素材，提供原图模态预览与共用的请求释放逻辑。 */
import { useEffect, useRef, useState } from 'react';

/** React 只保存资源地址；卸载、重试时释放旧租约，晚到的响应不再更新界面。 */
export function useAssetImage(albumId: string, path: string, kind: 'preview' | 'thumbnail') {
  const [attempt, setAttempt] = useState(0);
  const [source, setSource] = useState('');
  const [error, setError] = useState('');
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    const id = crypto.randomUUID();
    let active = true;
    setSource(''); setError(''); setLoaded(false);
    void window.desktop.requestAssetImage(albumId, path, kind, id, attempt > 0).then(result => {
      if (!active) return;
      if (result.status === 'success') setSource(result.value);
      else if (result.status === 'error') setError(result.message);
    }).catch(() => { if (active) setError('图片读取失败，请重试。'); });
    return () => {
      active = false;
      void window.desktop.releaseAssetImage(id).catch(() => { /* 关闭窗口时通信可能已断开。 */ });
    };
  }, [albumId, path, kind, attempt]);
  return { source, error, loaded, onLoad: () => setLoaded(true),
    onError: () => setError('图片无法显示，文件可能已被移除或损坏。'), retry: () => setAttempt(value => value + 1) };
}

/** 原生模态框管理焦点与 Esc；仅持有当前一张原图，关闭后卸载并释放。 */
export function AssetPreview({ albumId, path, onClose }: {
  albumId: string; path: string; onClose: () => void;
}): React.JSX.Element {
  const dialog = useRef<HTMLDialogElement>(null);
  const image = useAssetImage(albumId, path, 'preview');
  const name = path.split('/').at(-1) ?? path;
  useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    return () => { element?.close(); };
  }, []);
  return <dialog ref={dialog} className="group-dialog asset-preview-dialog" aria-labelledby="asset-preview-title"
    data-asset-preview onCancel={event => { event.preventDefault(); onClose(); }}>
    <div className="asset-preview-heading"><h2 id="asset-preview-title" title={name}>{name}</h2>
      <button type="button" onClick={onClose} autoFocus aria-label="关闭图片预览">关闭</button></div>
    <p className="asset-preview-path">素材库 / {path}</p>
    <div className="asset-preview-body" aria-busy={!image.loaded && !image.error}>
      {image.source && !image.error && <img src={image.source} alt={name} decoding="async" draggable={false}
        onLoad={image.onLoad} onError={image.onError} />}
      {!image.loaded && !image.error && <span className="asset-image-status" role="status">正在加载图片…</span>}
      {image.error && <div className="asset-image-status" role="alert"><p>{image.error}</p>
        <button type="button" onClick={image.retry}>重试</button></div>}
    </div>
    <p className="asset-preview-hint">按 Esc 关闭预览</p>
  </dialog>;
}
