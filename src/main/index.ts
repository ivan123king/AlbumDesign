/** 文件用途：创建桌面/打印窗口、注册受限通信并管理应用生命周期及开发验收。 */
import { app, BrowserWindow, dialog, ipcMain, Menu } from 'electron';
import type { IpcMainInvokeEvent } from 'electron';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { AppInfo } from '../shared/framework';
import { runFrameworkSmoke } from './smoke';
import { AlbumController } from './album-ipc';
import { declareImageProtocol, installImageProtocol } from './image-validator';
import { runAlbumSmoke } from './album-smoke';
import { runPageSmoke } from './page-smoke';
import { runTextSmoke } from './text-smoke';
import { runLayerSmoke } from './layer-smoke';
import { runAssetPreviewSmoke } from './asset-preview-smoke';
import { AppDataStore } from './app-data';
import { runRecentAlbumSmoke } from './recent-album-smoke';
import { runAssetDeleteSmoke } from './asset-delete-smoke';
import { AppDialogs } from './app-dialogs';
import { runPdfSmoke } from './pdf-smoke';
import { runCropSmoke } from './crop-smoke';

declareImageProtocol();

const textSmoke = !app.isPackaged && process.argv.includes('--text-smoke');
const layerSmoke = !app.isPackaged && process.argv.includes('--layer-smoke');
const assetSmoke = !app.isPackaged && process.argv.includes('--asset-preview-smoke');
const recentSmoke = !app.isPackaged && process.argv.includes('--recent-smoke');
const assetDeleteSmoke = !app.isPackaged && process.argv.includes('--asset-delete-smoke');
const cropSmoke = !app.isPackaged && process.argv.includes('--crop-smoke');
const pdfSmoke = !app.isPackaged && process.argv.includes('--pdf-smoke');
const smokeMode = !app.isPackaged && (process.argv.includes('--framework-smoke') || textSmoke || layerSmoke || assetSmoke || recentSmoke || assetDeleteSmoke || pdfSmoke || cropSmoke);
const projectRoot = join(__dirname, '../..');
const rendererFile = join(__dirname, '../renderer/index.html');
const developmentUrl = !app.isPackaged ? process.env.ELECTRON_RENDERER_URL : undefined;
let mainWindow: BrowserWindow | null = null;

/** 本地打包界面与开发服务器共用入口，打印页只切换查询参数。 */
async function loadRenderer(window: BrowserWindow, printing: boolean | 'album-print' = false): Promise<void> {
  if (developmentUrl) {
    const url = new URL(developmentUrl);
    if (url.hostname !== '127.0.0.1' && url.hostname !== 'localhost') {
      throw new Error('开发服务器必须位于本机。');
    }
    if (printing) url.searchParams.set('view', printing === 'album-print' ? printing : 'print');
    await window.loadURL(url.href);
  } else {
    await window.loadFile(rendererFile, { query: printing ? { view: printing === 'album-print' ? printing : 'print' } : {} });
  }
}

/** 所有窗口禁止任意弹窗与页面跳转；渲染进程不直接访问 Node.js。 */
function createWindow(hidden: boolean): BrowserWindow {
  const window = new BrowserWindow({
    width: 1440,
    height: 960,
    minWidth: 1000,
    minHeight: 680,
    title: '画册工坊',
    backgroundColor: '#f5f4f1',
    show: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: !hidden
    }
  });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', event => event.preventDefault());
  if (!hidden) window.once('ready-to-show', () => window.show());
  return window;
}

/** IPC 仅接受主窗口顶层页面，阻止其他窗口或 frame 调用桌面能力。 */
function assertMainSender(event: IpcMainInvokeEvent): void {
  if (!mainWindow || event.sender !== mainWindow.webContents || event.senderFrame !== event.sender.mainFrame) {
    throw new Error('不允许的调用来源。');
  }
  const actual = new URL(event.senderFrame.url);
  const expected = new URL(developmentUrl ?? pathToFileURL(rendererFile).href);
  if (actual.origin !== expected.origin || actual.pathname !== expected.pathname) {
    throw new Error('页面地址不匹配。');
  }
}

/** 导出两张统一竖向 A4 样例；横版内容的整体旋转由打印组件完成。 */
async function exportSamplePdf(filePath: string): Promise<void> {
  const window = createWindow(true);
  try {
    await loadRenderer(window, true);
    await window.webContents.executeJavaScript(`(async () => {
      const deadline = Date.now() + 10000;
      while (!document.querySelector('[data-print-ready]')) {
        if (Date.now() > deadline) throw new Error('打印页面未就绪');
        await new Promise(resolve => setTimeout(resolve, 30));
      }
      await document.fonts.ready;
      await Promise.all([...document.images].map(image => image.decode()));
    })()`);
    const pdf = await window.webContents.printToPDF({
      pageSize: 'A4',
      landscape: false,
      printBackground: true,
      displayHeaderFooter: false,
      preferCSSPageSize: true,
      margins: { top: 0, bottom: 0, left: 0, right: 0 }
    });
    await writeFile(filePath, pdf, { flag: 'w' });
  } finally {
    window.destroy();
  }
}

/** 安装原生菜单，画册入口及手动保存与界面共用控制器和忙碌状态。 */
function installMenu(albums: AlbumController, dialogs: AppDialogs): void {
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: '文件', submenu: [
      { id: 'create-album', label: '新建画册', click: () => { void albums.chooseAlbum(true); } },
      { id: 'open-album', label: '打开画册', click: () => { void albums.chooseAlbum(false); } },
      { id: 'save-page', label: '保存', accelerator: 'CmdOrCtrl+S', enabled: false, click: () => { void albums.savePage(); } },
      { type: 'separator' },
      { id: 'export-pdf', label: '导出 PDF', enabled: false, click: () => {
        void albums.exportPdf().then(result => {
          if (mainWindow && result.status === 'success') void dialog.showMessageBox(mainWindow,
            { type: 'info', title: 'PDF 导出完成', message: `画册已导出：${result.value}` });
        });
      } },
      { type: 'separator' },
      { role: 'quit', label: '退出' }
    ] },
    { label: '编辑', submenu: [
      { role: 'undo', label: '撤销' }, { role: 'redo', label: '重做' },
      { type: 'separator' },
      { role: 'cut', label: '剪切' }, { role: 'copy', label: '复制' },
      { role: 'paste', label: '粘贴' }, { role: 'selectAll', label: '全选' }
    ] },
    { label: '设置', submenu: [
      { id: 'reopen-last-album', label: '启动时打开上次画册', type: 'checkbox', checked: true,
        click: item => { void albums.setReopenLastAlbum(item.checked); } }
    ] },
    { label: '帮助', submenu: [{ id: 'about-app', label: '关于画册工坊', click: () => dialogs.showAbout() }] }
  ]));
}

/** 注册受限桌面与画册接口，后台图片校验使用独立资源协议。 */
async function bootstrap(): Promise<void> {
  // 正式目录不随产品显示名、EXE 名称或版本改变；ZIP 与安装版共用当前用户数据。
  let profile = app.isPackaged ? join(app.getPath('appData'), 'AlbumDesign')
    : join(projectRoot, '.cache', smokeMode ? 'smoke-profile' : 'dev-profile');
  if (recentSmoke) {
    const run = process.argv.find(value => value.startsWith('--recent-run='))?.slice('--recent-run='.length);
    if (!run || !/^recent-[a-zA-Z0-9-]+$/u.test(run)) throw new Error('最近画册验收目录参数无效。');
    profile = join(projectRoot, '.cache', 'verification', run, 'profile');
  }
  await mkdir(profile, { recursive: true });
  app.setPath('userData', profile);
  if (!smokeMode) {
    if (!app.requestSingleInstanceLock()) { app.quit(); return; }
    app.on('second-instance', () => {
      if (mainWindow) {
        if (mainWindow.isMinimized()) mainWindow.restore();
        mainWindow.show(); mainWindow.focus();
      }
    });
  }
  await app.whenReady();
  installImageProtocol();
  ipcMain.handle('framework:app-info', (event): AppInfo => {
    assertMainSender(event);
    return { version: app.getVersion(), electron: process.versions.electron,
      chromium: process.versions.chrome };
  });
  const appData = new AppDataStore(join(profile, 'data'));
  const dialogs: AppDialogs = new AppDialogs(() => mainWindow, assertMainSender, (): void => albums.updateMenu());
  const albums = new AlbumController(() => {
    if (!mainWindow) throw new Error('主窗口已关闭。');
    return mainWindow;
  }, assertMainSender, appData, dialogs);
  albums.configurePdf(() => createWindow(true), window => loadRenderer(window, 'album-print'));
  albums.register();
  installMenu(albums, dialogs);
  mainWindow = createWindow(smokeMode);
  mainWindow.webContents.on('did-start-loading', () => { albums.cancelPdf(); void albums.releaseCrop(); });
  mainWindow.webContents.on('render-process-gone', () => { albums.cancelPdf(); void albums.releaseCrop(); });
  dialogs.register(mainWindow);
  // 在渲染页面载入前占用操作锁，广播丢失也可通过初始状态查询获取结果。
  const initialization = albums.initialize(!smokeMode || recentSmoke);
  let closeApproved = false;
  mainWindow.on('close', event => {
    if (closeApproved) return;
    event.preventDefault();
    void albums.canClose().then(allowed => {
      if (allowed && mainWindow) { closeApproved = true; mainWindow.close(); }
    });
  });
  mainWindow.on('closed', () => { albums.dispose(); mainWindow = null; });
  await loadRenderer(mainWindow);
  await initialization;
  if (smokeMode) {
    if (cropSmoke) {
      await runCropSmoke(mainWindow, join(projectRoot, '.cache', 'verification'), albums);
      app.quit(); return;
    }
    if (pdfSmoke) {
      await runPdfSmoke(mainWindow, join(projectRoot, '.cache', 'verification'), albums);
      app.quit(); return;
    }
    if (assetDeleteSmoke) {
      await runAssetDeleteSmoke(mainWindow, join(projectRoot, '.cache', 'verification'), albums);
      app.quit(); return;
    }
    if (recentSmoke) {
      await runRecentAlbumSmoke(mainWindow, join(profile, '..'), albums, appData);
      app.quit(); return;
    }
    if (assetSmoke) {
      await runAssetPreviewSmoke(mainWindow, join(projectRoot, '.cache', 'verification'), albums);
      app.quit(); return;
    }
    if (layerSmoke) {
      await runLayerSmoke(mainWindow, join(projectRoot, '.cache', 'verification'), albums);
      app.quit(); return;
    }
    if (textSmoke) {
      await runTextSmoke(mainWindow, join(projectRoot, '.cache', 'verification'), albums);
      app.quit(); return;
    }
    await runFrameworkSmoke(mainWindow, join(projectRoot, '.cache', 'verification'), exportSamplePdf);
    await runAlbumSmoke(mainWindow, join(projectRoot, '.cache', 'verification'), albums);
    await runPageSmoke(mainWindow, join(projectRoot, '.cache', 'verification'), albums);
    app.quit();
  }
}

app.on('window-all-closed', () => app.quit());
void bootstrap().catch(error => {
  console.error(error);
  if (!smokeMode) dialog.showErrorBox('启动失败', String(error));
  app.exit(1);
});
