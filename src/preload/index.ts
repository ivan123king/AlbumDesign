/** 文件用途：在隔离上下文中向界面提供有限的桌面业务接口。 */
import { contextBridge, ipcRenderer } from 'electron';
import type { DesktopApi } from '../shared/framework';

const desktopApi: DesktopApi = {
  getAppInfo: () => ipcRenderer.invoke('framework:app-info'),
  exportSamplePdf: () => ipcRenderer.invoke('framework:sample-pdf')
};

contextBridge.exposeInMainWorld('desktop', desktopApi);
