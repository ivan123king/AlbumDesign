/** 文件用途：用独立沙箱窗口解码临时图片，避免大图解码阻塞主窗口或主进程。 */
import { BrowserWindow, net, protocol } from 'electron';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { open } from 'node:fs/promises';
import type { ImageFormat } from './album-store';

const pendingImages = new Map<string, { path: string; format: ImageFormat }>();

/** 必须在 app.ready 前声明；协议只接受一次校验任务持有的随机令牌。 */
export function declareImageProtocol(): void {
  protocol.registerSchemesAsPrivileged(['album-import', 'album-page'].map(scheme => ({ scheme,
    privileges: { standard: true, secure: true, supportFetchAPI: true } })));
}

/** 正式页面资源只接受会话、页面与对象 ID，切页后旧请求无法读取其他页面。 */
export function installPageImageProtocol(resolve: (albumId: string, pageId: string, objectId: string) => Promise<string>): void {
  protocol.handle('album-page', async request => {
    try {
      const url = new URL(request.url);
      const parts = url.pathname.slice(1).split('/');
      if (request.method !== 'GET' || url.hostname !== 'image' || url.search || parts.length !== 3
        || parts.some(part => !/^[a-zA-Z0-9-]+$/u.test(part))) return new Response(null, { status: 404 });
      const path = await resolve(parts[0]!, parts[1]!, parts[2]!);
      const response = await net.fetch(pathToFileURL(path).href);
      return new Response(response.body, { headers: { 'Content-Type': path.toLowerCase().endsWith('.png') ? 'image/png' : 'image/jpeg',
        'Cache-Control': 'no-store' } });
    } catch { return new Response(null, { status: 404 }); }
  });
}

/** 不接受磁盘路径、目录或相对路径；任务结束后立即撤销令牌。 */
export function installImageProtocol(): void {
  protocol.handle('album-import', async request => {
    const url = new URL(request.url);
    const image = pendingImages.get(url.pathname.slice(1));
    if (request.method !== 'GET' || url.hostname !== 'validate' || url.search || !image) return new Response(null, { status: 404 });
    const response = await net.fetch(pathToFileURL(image.path).href);
    return new Response(response.body, { status: response.status, headers: {
      'Content-Type': image.format === 'png' ? 'image/png' : 'image/jpeg', 'Cache-Control': 'no-store'
    } });
  });
}

/** 每批图片共用一个后台窗口，逐张校验后释放资源，批次结束销毁窗口。 */
export class ImageValidationTask {
  private window: BrowserWindow | null = null;

  /** 输入只来自主进程生成的临时副本；解码失败或超时则拒绝导入。 */
  async validate(path: string, format: ImageFormat): Promise<void> {
    await this.inspect(path, format);
  }

  /** 后台按浏览器照片方向解码，返回有效像素尺寸；不传回二进制或 Base64。 */
  async inspect(path: string, format: ImageFormat): Promise<{ width: number; height: number }> {
    const file = await open(path, 'r');
    const header = Buffer.alloc(8);
    try { await file.read(header, 0, 8, 0); } finally { await file.close(); }
    if (format === 'png' ? !header.equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
      : header[0] !== 255 || header[1] !== 216 || header[2] !== 255) throw new Error('图片格式与文件后缀不符。');
    if (!this.window) {
      this.window = new BrowserWindow({ show: false, webPreferences: {
        contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false
      } });
      this.window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
      this.window.webContents.on('will-navigate', event => event.preventDefault());
      await this.window.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(
        '<!doctype html><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; img-src album-import:;"><title>图片校验</title>'
      ));
    }
    const token = randomUUID();
    pendingImages.set(token, { path, format });
    try {
      const valid = await this.window.webContents.executeJavaScript(`(async () => {
        const image = new Image();
        let timer;
        try {
          image.src = ${JSON.stringify(`album-import://validate/${token}`)};
          await Promise.race([image.decode(), new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error('图片解码超时')), 30000);
          })]);
          return { width: image.naturalWidth, height: image.naturalHeight };
        } finally {
          clearTimeout(timer);
          image.removeAttribute('src');
        }
      })()`);
      if (!valid.width || !valid.height) throw new Error('图片没有有效尺寸。');
      return valid;
    } catch {
      throw new Error('图片无法完整解码或校验超时，请检查文件是否损坏。');
    } finally { pendingImages.delete(token); }
  }

  /** 关闭后台进程资源，不持有图片缓存或长期窗口。 */
  dispose(): void {
    this.window?.destroy();
    this.window = null;
  }
}
