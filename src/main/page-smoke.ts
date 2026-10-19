/** 文件用途：在临时画册中验收页面编号、文件回滚、真实拖放与横竖视角下的移动。 */
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rename, rm, writeFile, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { dialog, nativeImage, net } from 'electron';
import type { BrowserWindow } from 'electron';
import { AlbumStore } from './album-store';
import { PageStore } from './page-store';
import { ImageValidationTask } from './image-validator';
import type { AlbumController } from './album-ipc';
import type { AlbumState } from '../shared/album';
import { screenDeltaToPaper } from '../shared/canvas';
import type { ImageObject } from '../shared/canvas';
import { runResizeSmoke } from './resize-smoke';

/** 等待真实渲染进程状态，避免依赖操作耗时猜测。 */
async function waitFor(window: BrowserWindow, expression: string): Promise<void> {
  await window.webContents.executeJavaScript(`(async () => {
    for (let i = 0; !(${expression}); i++) {
      if (i > 300) throw new Error('页面验收等待超时：' + ${JSON.stringify(expression)});
      await new Promise(resolve => setTimeout(resolve, 20));
    }
  })()`);
}

/** 隐藏窗口等待合成器绘制后截图，用于人工查看布局。 */
async function capture(window: BrowserWindow, path: string): Promise<void> {
  await window.webContents.executeJavaScript('new Promise(resolve => setTimeout(() => requestAnimationFrame(() => requestAnimationFrame(resolve)), 150))');
  await writeFile(path, (await window.webContents.capturePage()).toPNG());
}

/** 生成带 EXIF 方向 6 的 JPEG，不依赖外部图片或用户文件。 */
function orientedJpeg(jpeg: Buffer): Buffer {
  const exif = Buffer.from('45786966000049492a0008000000010012010300010000000600000000000000', 'hex');
  const marker = Buffer.alloc(4); marker[0] = 255; marker[1] = 225; marker.writeUInt16BE(exif.length + 2, 2);
  return Buffer.concat([jpeg.subarray(0, 2), marker, exif, jpeg.subarray(2)]);
}

/** 所有创建、删除、外部修改及异常注入均限于本次新建的临时测试画册。 */
export async function runPageSmoke(window: BrowserWindow, output: string, controller: AlbumController): Promise<void> {
  console.log('画布验收：检查临时文件、坐标与编号。');
  const temporary = await mkdtemp(join(output, '画布验收-'));
  const root = join(temporary, '测试画册'); await mkdir(root);
  const albums = new AlbumStore(); const album = await albums.create(root);
  const pixels = Buffer.alloc(320 * 180 * 4);
  for (let y = 0; y < 180; y++) for (let x = 0; x < 320; x++) {
    const i = (y * 320 + x) * 4;
    pixels[i] = Math.round(90 + y / 2); pixels[i + 1] = Math.round(80 + x / 3); pixels[i + 2] = 170; pixels[i + 3] = 255;
  }
  const image = nativeImage.createFromBitmap(pixels, { width: 320, height: 180 });
  const png = image.toPNG(); const jpeg = orientedJpeg(image.toJPEG(90));
  const asset = join(root, 'assets', '中文素材.png');
  await writeFile(asset, png); await writeFile(join(root, 'assets', '方向照片.jpg'), jpeg);
  const task = new ImageValidationTask();
  const pages = new PageStore(albums, (path, format) => task.inspect(path, format));
  try {
    assert.deepEqual(await task.inspect(join(root, 'assets', '方向照片.jpg'), 'jpeg'), { width: 180, height: 320 });
    await pages.create(album.id, '第一张', 'portrait'); const first = pages.snapshot()!.pageId;
    await pages.addImage(album.id, first, '中文素材.png'); await pages.addImage(album.id, first, '中文素材.png');
    const objects = pages.snapshot()!.document.objects.filter((item): item is ImageObject => item.kind === 'image');
    assert.equal(objects[0]!.fileName, '001.png'); assert.equal(objects[1]!.fileName, '002.png');
    assert(objects[0]!.id !== objects[1]!.id); assert.equal(objects[1]!.zIndex, 1);
    assert.equal(objects[0]!.widthMm, 210); assert.equal(objects[0]!.xMm, 0);
    assert.deepEqual(await readFile(join(root, 'pages', '001', '001.png')), png);
    await rename(asset, join(root, 'assets', '改名后的素材.png'));
    assert.deepEqual(await readFile(await pages.imagePath(album.id, first, objects[0]!.id)), png);
    pages.move(album.id, first, objects[0]!.id, -10, 44); assert(pages.dirty);
    await pages.save(); await pages.load(album.id, first); assert.equal(pages.snapshot()!.document.objects[0]!.xMm, -10);
    const positioned = structuredClone(pages.snapshot()!.document.objects);
    for (let i = 0; i < 10; i++) { pages.setOrientation(album.id, first, 'landscape'); pages.setOrientation(album.id, first, 'portrait'); }
    assert.deepEqual(pages.snapshot()!.document.objects, positioned); assert(!pages.dirty);
    pages.move(album.id, first, objects[0]!.id, 123, 45); pages.discard(); assert(!pages.dirty);
    const canvasFile = join(root, 'pages', '001', 'canvas.json');
    const original = await readFile(canvasFile, 'utf8');
    await writeFile(canvasFile, original + ' ');
    await assert.rejects(pages.deleteImage(album.id, first, objects[0]!.id), /外部修改/u);
    assert.deepEqual(await readFile(join(root, 'pages', '001', '001.png')), png);
    assert(!(await readdir(join(root, 'pages', '001'))).some(name => name.startsWith('.delete-')));
    await writeFile(canvasFile, original);
    await pages.deleteImage(album.id, first, objects[0]!.id);
    await assert.rejects(lstat(join(root, 'pages', '001', '001.png')), { code: 'ENOENT' });
    assert.deepEqual(await readFile(join(root, 'pages', '001', '002.png')), png);
    await pages.addImage(album.id, first, '改名后的素材.png');
    assert.equal((pages.snapshot()!.document.objects.at(-1)! as ImageObject).fileName, '003.png');
    assert.deepEqual(await readFile(join(root, 'assets', '改名后的素材.png')), png);
    await pages.create(album.id, '横版', 'landscape'); const second = pages.snapshot()!.pageId;
    await pages.addImage(album.id, second, '方向照片.jpg');
    const oriented = pages.snapshot()!.document.objects[0]!;
    assert.equal(oriented.rotation, 90); assert(Math.abs(oriented.widthMm / oriented.heightMm - 180 / 320) < 1e-9);
    await pages.rename(album.id, first, '中文封面'); await pages.reorder(album.id, second, -1);
    assert.deepEqual(albums.pageReferences(album.id).map(page => page.directoryName), ['002', '001']);
    const projectFile = join(root, 'project.json'); const projectText = await readFile(projectFile, 'utf8');
    await writeFile(projectFile, projectText + ' ');
    await assert.rejects(pages.delete(album.id, first), /外部修改/u);
    assert((await lstat(join(root, 'pages', '001'))).isDirectory());
    await writeFile(projectFile, projectText);
    await mkdir(join(root, 'cache', 'thumbnails', '001'));
    await writeFile(join(root, 'cache', 'thumbnails', '001', 'cache.png'), png);
    await pages.delete(album.id, first);
    await assert.rejects(lstat(join(root, 'pages', '001')), { code: 'ENOENT' });
    await assert.rejects(lstat(join(root, 'cache', 'thumbnails', '001')), { code: 'ENOENT' });
    await pages.create(album.id, '第三张', 'portrait');
    assert.equal(albums.pageReferences(album.id).at(-1)!.directoryName, '003');
    await pages.addImage(album.id, pages.snapshot()!.pageId, '改名后的素材.png');
    // 模拟图片解码失败，只有计数前进，没有无效对象、孤立图片或临时副本。
    const beforeFailure = pages.snapshot()!.document.objects.length;
    await writeFile(join(root, 'assets', '损坏.png'), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    await assert.rejects(pages.addImage(album.id, pages.snapshot()!.pageId, '损坏.png'));
    assert.equal(pages.snapshot()!.document.objects.length, beforeFailure);
    assert(!(await readdir(join(root, 'pages', '003'))).some(name => name.startsWith('.image-')));
    await assert.rejects(pages.addImage(album.id, pages.snapshot()!.pageId, '../project.json'));
  } finally { task.dispose(); }
  const movedRoot = join(temporary, '搬迁后的画册'); await rename(root, movedRoot);
  const loaded = await controller.loadSmokeAlbum(movedRoot);
  console.log('画布验收：临时数据检查完成，开始界面操作。');
  window.setSize(1440, 960);
  await waitFor(window, "document.querySelector('[data-paper]') && !document.querySelector('.assets-panel').getAttribute('aria-busy').includes('true')");
  const originalMessage = dialog.showMessageBox;
  let response = 2;
  const messages: string[] = [];
  dialog.showMessageBox = (async (...args: unknown[]) => {
    messages.push((args[1] as { message: string }).message);
    return { response, checkboxChecked: false };
  }) as typeof dialog.showMessageBox;
  /** 从隔离接口读取实际状态，避免依赖测试代码持有的旧对象。 */
  const state = async (): Promise<AlbumState> => window.webContents.executeJavaScript('window.desktop.getAlbumState()');
  try {
    // 用真实表单创建画布，旧页面保持存在。
    await window.webContents.executeJavaScript("document.querySelector('.add-page').click()");
    await waitFor(window, "document.querySelector('.page-dialog[open]')");
    await window.webContents.executeJavaScript(`(() => { const input = document.querySelector('#page-name');
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, '拖放验收画布');
      input.dispatchEvent(new Event('input', {bubbles:true})); })()`);
    await capture(window, join(output, 'page-create-dialog.png'));
    await window.webContents.executeJavaScript("document.querySelector('.page-dialog button[type=submit]').click()");
    await waitFor(window, "!document.querySelector('.page-dialog') && document.querySelector('.document-title')");
    await waitFor(window, "document.querySelectorAll('[data-page-button]').length === 3 && !document.querySelector('.add-page').disabled");
    await window.webContents.executeJavaScript(`(() => {
      const item = document.querySelector('[data-asset-file="改名后的素材.png"]');
      const dataTransfer = new DataTransfer();
      item.dispatchEvent(new DragEvent('dragstart', {dataTransfer, bubbles:true}));
      const paper = document.querySelector('[data-paper]');
      paper.dispatchEvent(new DragEvent('dragover', {dataTransfer, bubbles:true, cancelable:true}));
      paper.dispatchEvent(new DragEvent('drop', {dataTransfer, bubbles:true, cancelable:true}));
    })()`);
    await waitFor(window, "document.querySelectorAll('[data-object-id]').length === 1 && !document.querySelector('.add-page').disabled");
    await waitFor(window, "document.querySelector('.canvas-picture img').naturalWidth === 320");
    const current = await state(); const pageId = current.canvas!.pageId; const objectId = current.canvas!.document.objects[0]!.id;
    assert.equal(current.album!.pages.at(-1)!.directoryName, '004');
    assert.equal((current.canvas!.document.objects[0]! as ImageObject).sourceName, '改名后的素材.png');
    const originalObject = structuredClone(current.canvas!.document.objects[0]!);
    // 素材删除后页面使用独立副本，且关闭旧页的资源 URL 无法读取当前页以外的对象。
    await rm(join(movedRoot, 'assets', '改名后的素材.png'));
    assert.equal((await net.fetch(`album-page://image/${loaded.id}/${pageId}/${objectId}`)).status, 200);
    assert.equal((await net.fetch(`album-page://image/${loaded.id}/${pageId}/not-an-object`)).status, 404);
    assert.equal((await net.fetch(`album-page://image/${loaded.id}/${pageId}/${objectId}?path=C:/Windows`)).status, 404);
    await window.webContents.executeJavaScript("document.querySelector('[data-fit-page]').click()");
    await capture(window, join(output, 'page-portrait.png'));
    // 真正发送 Chromium 指针输入，覆盖缩放与两种页面方向的坐标反变换。
    console.log('画布验收：素材拖放完成，检查两种视角下的移动。');
    for (const orientation of ['portrait', 'landscape'] as const) {
      await window.webContents.executeJavaScript(`(async () => {
        await window.desktop.setPageOrientation(${JSON.stringify(loaded.id)}, ${JSON.stringify(pageId)}, ${JSON.stringify(orientation)});
        await window.desktop.savePage();
      })()`);
      await waitFor(window, "!document.querySelector('.add-page').disabled");
      await window.webContents.executeJavaScript("document.querySelector('[data-fit-page]').click()");
      await window.webContents.executeJavaScript('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
      const before = (await state()).canvas!.document.objects[0]!;
      const point = await window.webContents.executeJavaScript(`(() => {
        const r = document.querySelector('[data-object-id]').getBoundingClientRect();
        return {x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2),zoom:Number(document.querySelector('[data-zoom-value]').dataset.zoomValue)};
      })()`);
      window.webContents.sendInputEvent({ type: 'mouseDown', x: point.x, y: point.y, button: 'left', clickCount: 1 });
      window.webContents.sendInputEvent({ type: 'mouseMove', x: point.x + 24, y: point.y + 12, modifiers: ['leftbuttondown'] });
      window.webContents.sendInputEvent({ type: 'mouseUp', x: point.x + 24, y: point.y + 12, button: 'left', clickCount: 1 });
      await waitFor(window, "document.querySelector('.unsaved-mark') && !document.querySelector('.add-page').disabled");
      const moved = (await state()).canvas!.document.objects[0]!;
      const delta = screenDeltaToPaper(24, 12, point.zoom, orientation);
      assert(Math.abs(moved.xMm - before.xMm - delta.x) < 0.1, JSON.stringify({ moved, before, delta }));
      assert(Math.abs(moved.yMm - before.yMm - delta.y) < 0.1);
      assert.equal(moved.widthMm, originalObject.widthMm); assert.equal(moved.rotation, originalObject.rotation);
      if (orientation === 'portrait') {
        response = 2;
        const canceled = await window.webContents.executeJavaScript(`window.desktop.selectPage(${JSON.stringify(loaded.id)}, ${JSON.stringify(loaded.pages[0]!.id)})`);
        assert.equal(canceled.status, 'canceled'); assert((await state()).canvas!.dirty);
        assert.equal(await controller.canClose(), false);
      }
      await window.webContents.executeJavaScript('window.desktop.savePage()');
    }
    const saved = structuredClone((await state()).canvas!.document);
    const other = loaded.pages[0]!.id;
    await window.webContents.executeJavaScript(`window.desktop.selectPage(${JSON.stringify(loaded.id)}, ${JSON.stringify(other)})`);
    await window.webContents.executeJavaScript(`window.desktop.selectPage(${JSON.stringify(loaded.id)}, ${JSON.stringify(pageId)})`);
    assert.deepEqual((await state()).canvas!.document, saved);
    await window.webContents.executeJavaScript(`window.desktop.movePageImage(${JSON.stringify(loaded.id)}, ${JSON.stringify(pageId)}, ${JSON.stringify(objectId)}, 18, 22)`);
    response = 1;
    await window.webContents.executeJavaScript(`window.desktop.selectPage(${JSON.stringify(loaded.id)}, ${JSON.stringify(other)})`);
    await window.webContents.executeJavaScript(`window.desktop.selectPage(${JSON.stringify(loaded.id)}, ${JSON.stringify(pageId)})`);
    assert.deepEqual((await state()).canvas!.document, saved);
    assert.equal(await controller.canClose(), true);
    await runResizeSmoke(window, output, movedRoot);
    await window.webContents.executeJavaScript("document.querySelector('[data-fit-page]').click()");
    await capture(window, join(output, 'page-landscape.png'));
    window.setSize(1000, 680);
    await window.webContents.executeJavaScript('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
    await window.webContents.executeJavaScript("document.querySelector('[data-fit-page]').click()");
    await capture(window, join(output, 'page-compact.png'));
    assert(await window.webContents.executeJavaScript('document.documentElement.scrollWidth <= window.innerWidth'));
    assert(messages.some(message => message.includes('保存')));
    // 真实 Delete 键从对象树进入删除流程，删除只影响本页副本。
    response = 1;
    await waitFor(window, "!document.querySelector('.add-page').disabled");
    await window.webContents.executeJavaScript("(() => { const button = document.querySelector('[data-object-button]'); button.focus(); button.click(); })()");
    await waitFor(window, "document.querySelector('[data-object-button]').getAttribute('aria-pressed') === 'true'");
    window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Delete' });
    window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Delete' });
    await waitFor(window, "document.querySelectorAll('[data-object-id]').length === 0 && !document.querySelector('.add-page').disabled");
    await assert.rejects(lstat(join(movedRoot, 'pages', '004', '001.png')), { code: 'ENOENT' });
    await window.webContents.executeJavaScript(`window.desktop.deletePage(${JSON.stringify(loaded.id)}, ${JSON.stringify(pageId)})`);
    assert.equal((await state()).album!.pages.length, 2);
    await window.webContents.executeJavaScript(`window.desktop.createPage(${JSON.stringify(loaded.id)}, '删除后新建', 'portrait')`);
    assert.equal((await state()).album!.pages.at(-1)!.directoryName, '005');
  } finally { dialog.showMessageBox = originalMessage; }
  await writeFile(join(output, 'pages-report.json'), JSON.stringify({
    temporaryAlbum: movedRoot, pageAndImageNumbersNotReused: true, fixedDirectoryAndPageOrder: true,
    byteIdenticalIndependentCopies: true, deleteRollbackAndCacheCleanup: true, externalEditsNotOverwritten: true,
    exifOrientation: true, realFormAndDragDrop: true, chromiumPointerMoveAtTwoOrientations: true,
    manualSaveReopenAndDiscard: true, cancelSwitchAndClose: true, restrictedImageProtocol: true, realDeleteKey: true,
    compactLayout: true, nativeDialogsManuallyVerified: false, largeProjectPerformanceMeasured: false
  }, null, 2));
  console.log('画布验收通过：页面存储、真实拖放、指针移动、保存和删除回滚已验证。');
}
