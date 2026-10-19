/** 文件用途：定义画册存储、素材目录及受限进程通信的数据契约。 */
import type { Orientation } from './framework';
import type { CanvasSnapshot, ImageGeometry } from './canvas';

/** 页面目录编号与数组中的页序分开保存，后续页面管理沿用此约定。 */
export interface AlbumPageReference {
  id: string;
  name: string;
  directoryName: string;
}

/** 格式版本不兼容时拒绝打开；新画册页面列表为空，由用户创建画布。 */
export interface AlbumManifest {
  formatVersion: 1;
  name: string;
  defaultOrientation: Orientation;
  pages: AlbumPageReference[];
  nextPageNumber: number;
}

export type AssetEntry =
  | { kind: 'directory'; name: string; path: string; children: AssetEntry[] }
  | { kind: 'image'; name: string; path: string };

/** path 均相对于 assets，使用 / 分隔；会话 ID 不写入画册文件。 */
export interface AlbumSnapshot {
  id: string;
  name: string;
  assets: AssetEntry[];
  imageCount: number;
  warnings: string[];
  pages: AlbumPageReference[];
}

export interface ImportProgress {
  completed: number;
  total: number;
  fileName: string;
  succeeded: number;
  failed: number;
}

export interface ImportReport {
  succeeded: { sourceName: string; savedPath: string }[];
  failed: { sourceName: string; reason: string }[];
  warnings: string[];
}

/** revision 用于丢弃晚到的旧状态，菜单与界面共享同一忙碌状态。 */
export interface AlbumState {
  revision: number;
  album: AlbumSnapshot | null;
  busy: boolean;
  progress: ImportProgress | null;
  canvas: CanvasSnapshot | null;
}

export type AlbumResult<T> =
  | { status: 'success'; value: T }
  | { status: 'canceled' }
  | { status: 'error'; message: string };

/** 只接受当前会话和素材相对路径，外部路径由原生对话框提供。
 * 操作分别返回 success、canceled 或带中文原因的 error；连接中断仍可能拒绝 Promise。
 */
export interface AlbumApi {
  getAlbumState(): Promise<AlbumState>;
  createAlbum(): Promise<AlbumResult<null>>;
  openAlbum(): Promise<AlbumResult<null>>;
  refreshAssets(albumId: string): Promise<AlbumResult<null>>;
  createAssetGroup(albumId: string, parentPath: string, name: string): Promise<AlbumResult<null>>;
  importAssets(albumId: string, targetPath: string): Promise<AlbumResult<ImportReport>>;
  createPage(albumId: string, name: string, orientation: Orientation): Promise<AlbumResult<null>>;
  selectPage(albumId: string, pageId: string): Promise<AlbumResult<null>>;
  renamePage(albumId: string, pageId: string, name: string): Promise<AlbumResult<null>>;
  reorderPage(albumId: string, pageId: string, direction: -1 | 1): Promise<AlbumResult<null>>;
  deletePage(albumId: string, pageId: string): Promise<AlbumResult<null>>;
  addPageImage(albumId: string, pageId: string, assetPath: string): Promise<AlbumResult<null>>;
  movePageImage(albumId: string, pageId: string, objectId: string, xMm: number, yMm: number): Promise<AlbumResult<null>>;
  resizePageImage(albumId: string, pageId: string, objectId: string, geometry: ImageGeometry): Promise<AlbumResult<null>>;
  deletePageImage(albumId: string, pageId: string, objectId: string): Promise<AlbumResult<null>>;
  setPageOrientation(albumId: string, pageId: string, orientation: Orientation): Promise<AlbumResult<null>>;
  savePage(): Promise<AlbumResult<null>>;
  onAlbumState(listener: (state: AlbumState) => void): () => void;
}
