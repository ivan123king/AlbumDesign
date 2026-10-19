/** 文件用途：在隔离上下文中向界面提供有限的桌面业务接口。 */
import { contextBridge, ipcRenderer } from 'electron';
import type { DesktopApi } from '../shared/framework';
import type { AlbumState } from '../shared/album';

const desktopApi: DesktopApi = {
  getAppInfo: () => ipcRenderer.invoke('framework:app-info'),
  exportSamplePdf: () => ipcRenderer.invoke('framework:sample-pdf'),
  getAlbumState: () => ipcRenderer.invoke('album:get-state'),
  createAlbum: () => ipcRenderer.invoke('album:create'),
  openAlbum: () => ipcRenderer.invoke('album:open'),
  refreshAssets: id => ipcRenderer.invoke('album:refresh', id),
  createAssetGroup: (id, parent, name) => ipcRenderer.invoke('album:create-group', id, parent, name),
  importAssets: (id, target) => ipcRenderer.invoke('album:import', id, target),
  createPage: (id, name, orientation) => ipcRenderer.invoke('page:command', id, 'create', '', { name, orientation }),
  selectPage: (id, page) => ipcRenderer.invoke('page:command', id, 'select', page),
  renamePage: (id, page, name) => ipcRenderer.invoke('page:command', id, 'rename', page, name),
  reorderPage: (id, page, direction) => ipcRenderer.invoke('page:command', id, 'reorder', page, direction),
  deletePage: (id, page) => ipcRenderer.invoke('page:command', id, 'delete-page', page),
  addPageImage: (id, page, asset) => ipcRenderer.invoke('page:command', id, 'add-image', page, asset),
  movePageImage: (id, page, objectId, xMm, yMm) => ipcRenderer.invoke('page:command', id, 'move', page, { objectId, xMm, yMm }),
  resizePageImage: (id, page, objectId, geometry) => ipcRenderer.invoke('page:command', id, 'resize', page, { objectId, geometry }),
  deletePageImage: (id, page, objectId) => ipcRenderer.invoke('page:command', id, 'delete-image', page, objectId),
  setPageOrientation: (id, page, orientation) => ipcRenderer.invoke('page:command', id, 'orientation', page, orientation),
  savePage: () => ipcRenderer.invoke('page:save'),
  /** 包装并移除同一监听函数，避免泄露 Electron 事件对象及重复订阅。 */
  onAlbumState: listener => {
    const handler = (_event: Electron.IpcRendererEvent, state: AlbumState): void => listener(state);
    ipcRenderer.on('album:state', handler);
    return () => { ipcRenderer.removeListener('album:state', handler); };
  }
};

contextBridge.exposeInMainWorld('desktop', desktopApi);
