/** 文件用途：创建桌面窗口、注册受限通信、导出框架样例，并管理应用生命周期。 */
import { app, BrowserWindow, dialog, ipcMain, Menu } from 'electron';
import type { IpcMainInvokeEvent } from 'electron';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { AppInfo, SamplePdfResult } from '../shared/framework';
import { runFrameworkSmoke } from './smoke';
import { AlbumController } from './album-ipc';
import { declareImageProtocol, installImageProtocol } from './image-validator';
import { runAlbumSmoke } from './album-smoke';
import { runPageSmoke } from './page-smoke';
import { runTextSmoke } from './text-smoke';

declareImageProtocol();

const textSmoke = !app.isPackaged && process.argv.includes('--text-smoke');
const smokeMode = !app.isPackaged && (process.argv.includes('--framework-smoke') || textSmoke);
const projectRoot = join(__dirname, '../..');
const rendererFile = join(__dirname, '../renderer/index.html');
const developmentUrl = !app.isPackaged ? process.env.ELECTRON_RENDERER_URL : undefined;
let mainWindow: BrowserWindow | null = null;
let exporting = false;

/** 本地打包界面与开发服务器共用入口，打印页只切换查询参数。 */
async function loadRenderer(window: BrowserWindow, printing = false): Promise<void> {
  if (developmentUrl) {
    const url = new URL(developmentUrl);
    if (url.hostname !== '127.0.0.1' && url.hostname !== 'localhost') {
      throw new Error('开发服务器必须位于本机。');
    }
    if (printing) url.searchParams.set('view', 'print');
    await window.loadURL(url.href);
  } else {
    await window.loadFile(rendererFile, { query: printing ? { view: 'print' } : {} });
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

/** 用户通过保存对话框选择样例位置，取消与失败分别反馈，不接收界面传入路径。 */
async function chooseSamplePdf(): Promise<SamplePdfResult> {
  if (!mainWindow || exporting) throw new Error('已有导出任务正在进行。');
  exporting = true;
  try {
    const result = await dialog.showSaveDialog(mainWindow, {
      title: '导出双页 A4 样例',
      defaultPath: '画册工坊-A4样例.pdf',
      filters: [{ name: 'PDF 文档', extensions: ['pdf'] }]
    });
    if (result.canceled || !result.filePath) return { canceled: true };
    await exportSamplePdf(result.filePath);
    return { canceled: false, filePath: result.filePath };
  } finally {
    exporting = false;
  }
}

/** 安装原生菜单，画册入口及手动保存与界面共用控制器和忙碌状态。 */
function installMenu(albums: AlbumController): void {
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: '文件', submenu: [
      { id: 'create-album', label: '新建画册…', click: () => { void albums.chooseAlbum(true); } },
      { id: 'open-album', label: '打开画册…', click: () => { void albums.chooseAlbum(false); } },
      { id: 'save-page', label: '保存', accelerator: 'CmdOrCtrl+S', enabled: false, click: () => { void albums.savePage(); } },
      { type: 'separator' },
      { label: '导出双页 A4 样例…', click: () => {
        void chooseSamplePdf().catch(error => dialog.showErrorBox('导出失败', String(error)));
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
    { label: '帮助', submenu: [{ label: '关于画册工坊', click: () => {
      void dialog.showMessageBox({ type: 'info', title: '画册工坊',
        message: '画册工坊 ' + app.getVersion(), detail: '画册编辑器框架预览：手工排版，留住每一页记忆。' });
    } }] }
  ]));
}

/** 注册受限桌面与画册接口，后台图片校验使用独立资源协议。 */
async function bootstrap(): Promise<void> {
  if (!app.isPackaged) {
    const profile = join(projectRoot, '.cache', smokeMode ? 'smoke-profile' : 'dev-profile');
    await mkdir(profile, { recursive: true });
    app.setPath('userData', profile);
  }
  await app.whenReady();
  installImageProtocol();
  ipcMain.handle('framework:app-info', (event): AppInfo => {
    assertMainSender(event);
    return { version: app.getVersion(), electron: process.versions.electron,
      chromium: process.versions.chrome };
  });
  ipcMain.handle('framework:sample-pdf', event => {
    assertMainSender(event);
    return chooseSamplePdf();
  });
  const albums = new AlbumController(() => {
    if (!mainWindow) throw new Error('主窗口已关闭。');
    return mainWindow;
  }, assertMainSender);
  albums.register();
  installMenu(albums);
  mainWindow = createWindow(smokeMode);
  let closeApproved = false;
  mainWindow.on('close', event => {
    if (closeApproved) return;
    event.preventDefault();
    void albums.canClose().then(allowed => {
      if (allowed && mainWindow) { closeApproved = true; mainWindow.close(); }
    });
  });
  mainWindow.on('closed', () => { mainWindow = null; });
  await loadRenderer(mainWindow);
  if (smokeMode) {
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
