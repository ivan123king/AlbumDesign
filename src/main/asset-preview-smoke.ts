/** 文件用途：仅用临时画册验证素材原图弹框、缩略图缓存/取消/路径边界，并记录 500 张合成图片浏览性能。 */
import assert from 'node:assert/strict';
import { app, nativeImage, net } from 'electron';
import type { BrowserWindow } from 'electron';
import { cpus, totalmem } from 'node:os';
import { randomUUID } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { AlbumStore } from './album-store';
import type { AlbumController } from './album-ipc';
import type { AlbumResult } from '../shared/album';

/** 条件等待始终有超时，原生对话框不参与此专项。 */
async function waitFor(window: BrowserWindow, expression: string): Promise<void> {
  await window.webContents.executeJavaScript(`(async () => {
    const end = Date.now() + 30000;
    while (!(${expression})) {
      if (Date.now() > end) throw new Error('素材预览等待超时：' + ${JSON.stringify(expression)});
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  })()`);
}

/** 截图记录完整网格、弹框和最小窗口，供视觉复核。 */
async function capture(window: BrowserWindow, output: string, name: string): Promise<void> {
  await window.webContents.executeJavaScript(`(async () => {
    await Promise.all([...document.images].filter(image => image.src).map(image => image.decode().catch(() => {})));
    await new Promise(resolve => setTimeout(() => requestAnimationFrame(() => requestAnimationFrame(resolve)), 120));
  })()`);
  await writeFile(join(output, name), (await window.webContents.capturePage()).toPNG());
}

/** 注入标准 EXIF Orientation=6，检查照片方向与浏览器原图一致。 */
function orientedJpeg(jpeg: Buffer): Buffer {
  const exif = Buffer.from('45786966000049492a0008000000010012010300010000000600000000000000', 'hex');
  const marker = Buffer.alloc(4); marker[0] = 255; marker[1] = 225; marker.writeUInt16BE(exif.length + 2, 2);
  return Buffer.concat([jpeg.subarray(0, 2), marker, exif, jpeg.subarray(2)]);
}

/** 所有文件修改均局限于本次 mkdtemp 目录，500 张为合成图片，不替代真实照片与整册导出性能测试。 */
export async function runAssetPreviewSmoke(window: BrowserWindow, output: string, controller: AlbumController): Promise<void> {
  const uiOnly = process.argv.includes('--asset-preview-ui-only');
  await mkdir(output, { recursive: true });
  const temporary = await mkdtemp(join(output, '素材预览验收-'));
  const root = join(temporary, '五百张素材画册'); await mkdir(root);
  const store = new AlbumStore(); await store.create(root);
  await mkdir(join(root, 'assets', '旅行', '海边'), { recursive: true });
  // 只在测试准备阶段同步构造位图；业务缩略图仍由独立后台窗口串行解码。
  const width = 3000; const height = 2000;
  let bitmap = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const offset = (y * width + x) * 4;
    bitmap[offset] = (x * 255 / width + (x * y % 29)) % 256;
    bitmap[offset + 1] = y * 255 / height;
    bitmap[offset + 2] = 130 + (x + y) % 100; bitmap[offset + 3] = 255;
  }
  const jpeg = nativeImage.createFromBitmap(bitmap, { width, height }).toJPEG(88);
  bitmap = Buffer.alloc(64 * 32 * 4);
  for (let i = 0; i < bitmap.length; i += 4) { bitmap[i] = 80; bitmap[i + 1] = 150; bitmap[i + 2] = 110; bitmap[i + 3] = i % 8 ? 0 : 128; }
  const transparent = nativeImage.createFromBitmap(bitmap, { width: 64, height: 32 }).toPNG();
  await writeFile(join(root, 'assets', '0001.jpg'), jpeg);
  // 分组共 498 张普通 JPEG，另有 EXIF 照片和透明 PNG，总计 500 张。
  for (let i = 2; i <= 498; i++) await copyFile(join(root, 'assets', '0001.jpg'), join(root, 'assets', i > 298 ? '旅行/海边' : '', `${String(i).padStart(4, '0')}.jpg`));
  await writeFile(join(root, 'assets', '方向 照片.jpg'), orientedJpeg(jpeg));
  await writeFile(join(root, 'assets', '透明.png'), transparent);
  // 旧画册允许缓存目录不存在；重建只能发生在实际请求缩略图后。
  await rm(join(root, 'cache'), { recursive: true });
  const openStart = performance.now();
  const album = await controller.loadSmokeAlbum(root);
  await waitFor(window, "document.querySelector('[data-asset-count]')?.textContent === '500' && document.querySelector('[data-asset-file]')");
  const openMs = performance.now() - openStart;
  assert.equal(await readdir(root).then(names => names.includes('cache')), false);
  assert.equal(await window.webContents.executeJavaScript("document.querySelectorAll('[data-asset-thumbnail]').length"), 0);

  /** 通过真实 preload 申请资源，校验受限协议及取消生命周期。 */
  async function request(path: string, kind: 'preview' | 'thumbnail', id = randomUUID(), retry = false): Promise<{ id: string; url: string }> {
    const result = await window.webContents.executeJavaScript(`window.desktop.requestAssetImage(${JSON.stringify(album.id)}, ${JSON.stringify(path)}, '${kind}', '${id}', ${retry})`) as AlbumResult<string>;
    assert.equal(result.status, 'success', JSON.stringify(result));
    return { id, url: result.status === 'success' ? result.value : '' };
  }
  /** 释放后再次读取地址必须失败，重复释放无副作用。 */
  async function release(id: string): Promise<void> {
    await window.webContents.executeJavaScript(`window.desktop.releaseAssetImage('${id}')`);
  }
  const original = await request('方向 照片.jpg', 'preview');
  assert.equal((await net.fetch(original.url)).status, 200);
  await release(original.id); await release(original.id);
  assert.equal((await net.fetch(original.url)).status, 404);
  for (const path of ['../project.json', 'E:/outside.jpg', '旅行/../../outside.jpg', 'missing.png']) {
    const result = await window.webContents.executeJavaScript(`window.desktop.requestAssetImage(${JSON.stringify(album.id)}, ${JSON.stringify(path)}, 'thumbnail', '${randomUUID()}')`) as AlbumResult<string>;
    assert.equal(result.status, 'error');
  }
  const cancellation = await window.webContents.executeJavaScript(`(async () => {
    const id = crypto.randomUUID();
    const result = window.desktop.requestAssetImage(${JSON.stringify(album.id)}, '0001.jpg', 'thumbnail', id);
    await window.desktop.releaseAssetImage(id);
    return await result;
  })()`);
  assert.equal(cancellation.status, 'canceled');

  // 目录树双击与真实 Esc 输入，关闭后原图地址失效。
  await window.webContents.executeJavaScript("document.querySelector('[data-asset-file]').dispatchEvent(new MouseEvent('dblclick', {bubbles:true}))");
  await waitFor(window, "document.querySelector('[data-asset-preview] img')?.naturalWidth > 0");
  await capture(window, output, 'asset-preview-dialog.png');
  window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
  window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' });
  await waitFor(window, "!document.querySelector('[data-asset-preview]')");

  const direction = await request('方向 照片.jpg', 'thumbnail');
  const directionBytes = Buffer.from(await (await net.fetch(direction.url)).arrayBuffer());
  assert.deepEqual(nativeImage.createFromBuffer(directionBytes).getSize(), { width: 171, height: 256 });
  const alpha = await request('透明.png', 'thumbnail');
  const alphaBytes = Buffer.from(await (await net.fetch(alpha.url)).arrayBuffer());
  const alphaBitmap = nativeImage.createFromBuffer(alphaBytes).toBitmap();
  assert.equal(alphaBitmap[7], 0); assert.equal(alphaBitmap[3], 128);
  await release(direction.id); await release(alpha.id);
  const cache = join(root, 'cache', 'thumbnails', 'assets');
  const cachedBefore = await readdir(cache);
  const repeated = await request('透明.png', 'thumbnail'); await release(repeated.id);
  assert.deepEqual(await readdir(cache), cachedBefore);
  // 相同路径的源文件被替换时必须产生新缓存；坏缓存可通过重试重建。
  await writeFile(join(root, 'assets', '透明.png'), Buffer.concat([transparent, Buffer.from('changed')]));
  const changed = await request('透明.png', 'thumbnail'); await release(changed.id);
  const newCache = (await readdir(cache)).find(name => !cachedBefore.includes(name)); assert.ok(newCache);
  await writeFile(join(cache, newCache), Buffer.from('broken'));
  const repaired = await request('透明.png', 'thumbnail', randomUUID(), true);
  assert.equal((await net.fetch(repaired.url)).status, 200); await release(repaired.id);

  const memorySamples: number[] = [];
  /** 使用 Electron 进程工作集总和采样，包含主进程、渲染进程和后台解码进程。 */
  function sampleMemory(): void { memorySamples.push(app.getAppMetrics().reduce((sum, item) => sum + item.memory.workingSetSize, 0) / 1024); }
  sampleMemory(); const memoryTimer = setInterval(sampleMemory, 100);
  try {
    await window.webContents.executeJavaScript(`window.assetTiming = { gaps: [], last: performance.now() };
      window.assetTimer = setInterval(() => { const now = performance.now(); window.assetTiming.gaps.push(now - window.assetTiming.last); window.assetTiming.last = now; }, 16)`);
    const coldStart = performance.now();
    await window.webContents.executeJavaScript("document.getElementById('asset-tab-gallery').click()");
    await waitFor(window, "document.querySelectorAll('[data-asset-thumbnail]').length > 0 && !document.querySelector('.asset-thumbnail-picture [role=\"status\"]') && [...document.querySelectorAll('[data-asset-thumbnail]')].every(img => img.naturalWidth > 0)");
    const firstScreenMs = performance.now() - coldStart;
    const mountedFirst = await window.webContents.executeJavaScript("document.querySelectorAll('[data-asset-thumbnail]').length");
    assert.ok(mountedFirst < 40);
    await capture(window, output, 'asset-gallery-desktop.png');
    // 分屏滚动全库；只等待当前区域，验证远处卡片没有一起申请图片。
    const scrolling = await window.webContents.executeJavaScript(`(async () => {
      const scroll = document.querySelector('.asset-scroll');
      let peak = 0; let screens = 0;
      for (let top = 0; top < scroll.scrollHeight; top += Math.max(120, scroll.clientHeight - 120)) {
        scroll.scrollTop = top; screens++;
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        const end = Date.now() + 15000;
        const pending = () => [...document.querySelectorAll('[data-thumbnail-card]')].some(card => {
          const bounds = card.getBoundingClientRect(), viewport = scroll.getBoundingClientRect();
          if (bounds.bottom <= viewport.top || bounds.top >= viewport.bottom) return false;
          const image = card.querySelector('img');
          return !card.querySelector('.asset-thumbnail-error') && (!image || !image.complete || !image.naturalWidth);
        });
        while (pending() || document.querySelector('.asset-thumbnail-picture [role="status"]')) {
          if (Date.now() > end) throw new Error('滚动生成超时');
          await new Promise(resolve => setTimeout(resolve, 25));
        }
        peak = Math.max(peak, document.querySelectorAll('[data-asset-thumbnail]').length);
        if (${uiOnly} && screens >= 2) break;
      }
      return { peak, screens, errors: document.querySelectorAll('.asset-thumbnail-error').length,
        cards: document.querySelectorAll('[data-thumbnail-card]').length, scrollHeight: scroll.scrollHeight };
    })()`);
    const coldBrowseMs = performance.now() - coldStart;
    console.log('素材滚动检查', JSON.stringify({ scrolling, cached: (await readdir(cache)).length, coldBrowseMs }));
    assert.ok(scrolling.peak < 40); assert.equal(scrolling.errors, 0);
    if (!uiOnly) assert.equal((await readdir(cache)).length, 501);
    const warmStart = performance.now();
    await window.webContents.executeJavaScript("document.getElementById('asset-tab-directory').click()");
    await waitFor(window, "document.querySelectorAll('[data-asset-thumbnail]').length === 0");
    await window.webContents.executeJavaScript("document.querySelector('.asset-scroll').scrollTop = 0; document.getElementById('asset-tab-gallery').click()");
    await waitFor(window, "document.querySelectorAll('[data-asset-thumbnail]').length > 0 && !document.querySelector('.asset-thumbnail-picture [role=\"status\"]') && [...document.querySelectorAll('[data-asset-thumbnail]')].every(img => img.naturalWidth > 0)");
    const warmFirstScreenMs = performance.now() - warmStart;
    await window.webContents.executeJavaScript("document.querySelector('[aria-label=\"浏览素材分组\"]').value = '旅行'; document.querySelector('[aria-label=\"浏览素材分组\"]').dispatchEvent(new Event('change', {bubbles:true}))");
    await waitFor(window, "document.querySelectorAll('[data-thumbnail-card]').length === 200");
    await window.webContents.executeJavaScript("document.querySelector('[data-thumbnail-card]').dispatchEvent(new MouseEvent('dblclick', {bubbles:true}))");
    await waitFor(window, "document.querySelector('[data-asset-preview] img')?.naturalWidth > 0");
    await capture(window, output, 'asset-gallery-preview.png');
    await window.webContents.executeJavaScript("document.querySelector('[aria-label=\"关闭图片预览\"]').click()");
    window.setSize(1000, 680);
    await waitFor(window, "innerWidth <= 1000 && !document.querySelector('[data-asset-preview]')");
    await capture(window, output, 'asset-gallery-compact.png');
    window.setSize(1440, 960);
    // 通过同一 DataTransfer 验证卡片拖入当前画布，页面只使用原图副本。
    const pageResult = await window.webContents.executeJavaScript(`window.desktop.createPage('${album.id}', '缩略图拖入验收', 'portrait')`);
    assert.equal(pageResult.status, 'success');
    await waitFor(window, "document.querySelector('[data-paper]') && !document.querySelector('[data-thumbnail-card]')?.getAttribute('aria-disabled')?.includes('true')");
    await window.webContents.executeJavaScript(`(() => {
      const transfer = new DataTransfer();
      document.querySelector('[data-thumbnail-card]').dispatchEvent(new DragEvent('dragstart', {bubbles:true, dataTransfer:transfer}));
      document.querySelector('[data-paper]').dispatchEvent(new DragEvent('drop', {bubbles:true, cancelable:true, dataTransfer:transfer}));
    })()`);
    await waitFor(window, "document.querySelector('.canvas-picture img')?.naturalWidth > 0");
    const gaps: number[] = await window.webContents.executeJavaScript("clearInterval(window.assetTimer); window.assetTiming.gaps");
    sampleMemory();
    const stale = await request('0001.jpg', 'preview');
    await controller.loadSmokeAlbum(root);
    assert.equal((await net.fetch(stale.url)).status, 404);
    await waitFor(window, "document.getElementById('asset-tab-directory')?.getAttribute('aria-selected') === 'true' && !document.querySelector('[data-asset-thumbnail]')");
    const report = { ok: true, fullBrowse: !uiOnly, temporary, environment: { platform: process.platform, arch: process.arch, node: process.versions.node,
      electron: process.versions.electron, cpu: cpus()[0]?.model, ramGiB: totalmem() / 1024 ** 3 },
      fixture: { count: 500, width, height, jpegBytes: jpeg.length, synthetic: true },
      checks: ['目录不加载图片', '双击原图与Esc', 'EXIF方向', 'PNG透明度', '路径拒绝', '取消与失效会话', '缓存复用/变更/损坏重试', '分组及子分组', '缩略图拖入原图'],
      timing: { openMs, firstScreenMs, coldBrowseMs, warmFirstScreenMs, maxTimerGapMs: Math.max(...gaps) },
      memory: { baselineWorkingSetMiB: memorySamples[0], peakWorkingSetMiB: Math.max(...memorySamples), sampleIntervalMs: 100 }, scrolling, mountedFirst,
      limitations: '500张为合成JPEG和PNG，非真实照片集；未执行真实画册300～500页切页/PDF导出与原生鼠标人工验收。' };
    await writeFile(join(output, uiOnly ? 'asset-preview-ui-report.json' : 'asset-preview-report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
  } finally { clearInterval(memoryTimer); }
}
