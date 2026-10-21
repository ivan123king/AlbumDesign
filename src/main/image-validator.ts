/** 文件用途：用独立沙箱窗口校验图片并生成小图，避免原图解码与编码阻塞主窗口或主进程。 */
import { BrowserWindow, net, protocol } from 'electron';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { open } from 'node:fs/promises';
import type { ImageFormat } from './album-store';
import { cropPixelBounds, cropShapePath, renderCrop, validateCrop } from '../shared/crop';
import type { CropSettings, CropBounds } from '../shared/crop';

const pendingImages = new Map<string, { path: string; format: ImageFormat }>();

/** 裁剪弹框只持有随机只读令牌；释放后不能再读取该源图。 */
export function leaseCropImage(path: string, format: ImageFormat): { token: string; url: string; release: () => void } {
  const token = randomUUID(); pendingImages.set(token, { path, format });
  return { token, url: `album-import://validate/${token}`, release: () => { pendingImages.delete(token); } };
}

/** 必须在 app.ready 前声明；协议只接受一次校验任务持有的随机令牌。 */
export function declareImageProtocol(): void {
  protocol.registerSchemesAsPrivileged(['album-import', 'album-page', 'album-asset'].map(scheme => ({ scheme,
    privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } })));
}

/** 正式页面资源只接受会话、页面与对象 ID，切页后旧请求无法读取其他页面。 */
export function installPageImageProtocol(resolve: (albumId: string, pageId: string, objectId: string) => Promise<string>): void {
  protocol.handle('album-page', async request => {
    try {
      const url = new URL(request.url);
      const parts = url.pathname.slice(1).split('/');
      if (request.method !== 'GET' || url.hostname !== 'image' || (url.search && !/^\?v=\d{3,}\.(png|jpg|jpeg)$/iu.test(url.search)) || parts.length !== 3
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
      'Content-Type': image.format === 'png' ? 'image/png' : 'image/jpeg', 'Cache-Control': 'no-store',
      // 后台小图绘制需要可读像素；只有持随机任务令牌的图片允许跨源读取。
      'Access-Control-Allow-Origin': '*'
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
    return this.decode(path, format, false);
  }

  /** 小图绘制与 PNG 编码在后台窗口完成，最长边 256 像素，保留透明度与照片方向。 */
  async thumbnail(path: string, format: ImageFormat): Promise<Buffer> {
    const result = await this.decode(path, format, true);
    if (!result.thumbnail) throw new Error('缩略图生成失败。');
    return Buffer.from(result.thumbnail, 'base64');
  }

  /** 原始像素裁剪及 PNG 编码仅在独立沙箱窗口执行；超限或全透明结果拒绝提交。 */
  async crop(path: string, format: ImageFormat, settings: CropSettings): Promise<{ png: Buffer; bounds: CropBounds; width: number; height: number }> {
    validateCrop(settings);
    const result = await this.decode(path, format, false, settings);
    if (!result.thumbnail || !result.bounds) throw new Error('裁剪结果无效。');
    return { png: Buffer.from(result.thumbnail, 'base64'), bounds: result.bounds, width: result.width, height: result.height };
  }

  /** 共用受限解码通道；小图字符串仅在后台与主进程间传递，不进入界面状态。 */
  private async decode(path: string, format: ImageFormat, thumbnail: boolean, crop?: CropSettings): Promise<{ width: number; height: number; thumbnail?: string; bounds?: CropBounds }> {
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
        '<!doctype html><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; img-src album-import:; connect-src album-import:;"><title>图片校验</title>'
      ));
    }
    const token = randomUUID();
    pendingImages.set(token, { path, format });
    try {
      const valid = await this.window.webContents.executeJavaScript(`(async () => {
        const image = new Image();
        const controller = new AbortController();
        let bitmap;
        let expired = false;
        let timer;
        try {
          const url = ${JSON.stringify(`album-import://validate/${token}`)};
          // ImageBitmap 不依赖隐藏窗口的图片呈现时机，并能在绘制后明确关闭原图像素。
          const decoding = ${thumbnail || !!crop} ? (async () => {
            const response = await fetch(url, { signal: controller.signal });
            if (!response.ok) throw new Error('图片读取失败');
            const decoded = await createImageBitmap(await response.blob(), { imageOrientation: 'from-image' });
            if (expired) { decoded.close(); throw new Error('图片解码已取消'); }
            bitmap = decoded;
          })() : (image.src = url, image.decode());
          await Promise.race([decoding, new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error('图片解码超时')), 30000);
          })]);
          const result = { width: bitmap ? bitmap.width : image.naturalWidth, height: bitmap ? bitmap.height : image.naturalHeight };
          if (${!!crop}) {
            if (result.width * result.height > 80000000 || Math.max(result.width, result.height) > 32767) throw new Error('图片过大，裁剪支持最长边 32767 像素且总像素不超过 8000 万。');
            const settings = ${JSON.stringify(crop ?? null)};
            const validateCrop = ${validateCrop.toString()};
            const bounds = (${cropPixelBounds.toString()})(settings, result.width, result.height);
            // 圆角按解码后的真实像素比例生成；与编辑轮廓和按钮预览共用路径函数。
            const path = (${cropShapePath.toString()})(settings.shape, settings.width * result.width, settings.height * result.height, settings.cornerRadii);
            const output = (${renderCrop.toString()})(bitmap, result.width, result.height, settings, bounds, path, Infinity);
            try {
              const blob = await new Promise(resolve => output.toBlob(resolve, 'image/png'));
              if (!blob) throw new Error('PNG 编码失败。');
              result.thumbnail = await new Promise((resolve, reject) => {
                const reader = new FileReader(); reader.onload = () => resolve(reader.result.split(',')[1]); reader.onerror = reject; reader.readAsDataURL(blob);
              });
              result.bounds = bounds;
            } finally { output.width = 0; output.height = 0; }
          }
          if (${thumbnail}) {
            const scale = Math.min(1, 256 / Math.max(result.width, result.height));
            const canvas = document.createElement('canvas');
            canvas.width = Math.max(1, Math.round(result.width * scale));
            canvas.height = Math.max(1, Math.round(result.height * scale));
            try {
              const context = canvas.getContext('2d');
              if (!context) throw new Error('无法绘制缩略图');
              context.drawImage(bitmap || image, 0, 0, canvas.width, canvas.height);
              result.thumbnail = canvas.toDataURL('image/png').split(',')[1];
            } finally { canvas.width = 0; canvas.height = 0; }
          }
          return result;
        } catch (error) {
          return { error: String(error && error.message || error) };
        } finally {
          clearTimeout(timer);
          expired = true;
          controller.abort();
          if (bitmap) bitmap.close();
          image.removeAttribute('src');
        }
      })()`);
      if (valid.error) throw new Error(valid.error);
      if (!valid.width || !valid.height) throw new Error('图片没有有效尺寸。');
      return valid;
    } catch (error) {
      if (crop) throw new Error(`裁剪失败：${error instanceof Error ? error.message : String(error)}`);
      if (thumbnail) throw new Error(`缩略图生成失败：${error instanceof Error ? error.message : String(error)}`);
      throw new Error('图片无法完整解码或校验超时，请检查文件是否损坏。');
    } finally { pendingImages.delete(token); }
  }

  /** 关闭后台进程资源，不持有图片缓存或长期窗口。 */
  dispose(): void {
    this.window?.destroy();
    this.window = null;
  }
}
