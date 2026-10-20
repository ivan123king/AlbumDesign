/** 文件用途：仅使用临时画册验收裁剪像素、二次裁剪、事务保存/放弃与左右真实界面入口。 */
import assert from 'node:assert/strict';
import { copyFile, lstat, mkdir, mkdtemp, readFile, readdir, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { dialog, nativeImage } from 'electron';
import { PDFDocument, PDFName, PDFRawStream } from 'pdf-lib';
import type { BrowserWindow } from 'electron';
import { AlbumStore } from './album-store';
import { PageStore } from './page-store';
import { CropImages } from './crop-images';
import { ImageValidationTask } from './image-validator';
import type { AlbumController } from './album-ipc';
import type { CropSettings } from '../shared/crop';
import { cropPixelBounds } from '../shared/crop';
import type { ImageObject } from '../shared/canvas';

/** 等待具体 DOM 条件；仅用于开发验收，不以固定延时推断成功。 */
async function waitFor(window: BrowserWindow, expression: string): Promise<void> {
  await window.webContents.executeJavaScript(`(async () => {
    for (let i = 0; !(${expression}); i++) { if (i > 400) throw new Error('裁剪界面等待超时：' + ${JSON.stringify(expression)}); await new Promise(resolve => setTimeout(resolve, 25)); }
  })()`);
}

/** 真正的 Chromium 鼠标右击，确保生产右键入口能够打开模态框。 */
async function openCrop(window: BrowserWindow, selector: string, button: string): Promise<void> {
  await waitFor(window, `!document.querySelector('dialog[open]') && document.querySelector(${JSON.stringify(selector)})?.getAttribute('aria-disabled') !== 'true'`);
  const point = await window.webContents.executeJavaScript(`(() => {
    const target = document.querySelector(${JSON.stringify(selector)}); target.scrollIntoView({block:'center'});
    const bounds = target.getBoundingClientRect(); return { x: Math.round(bounds.x + bounds.width / 2), y: Math.round(bounds.y + bounds.height / 2) };
  })()`);
  window.webContents.sendInputEvent({ type: 'mouseDown', button: 'right', clickCount: 1, ...point });
  window.webContents.sendInputEvent({ type: 'mouseUp', button: 'right', clickCount: 1, ...point });
  try { await waitFor(window, `document.querySelector(${JSON.stringify(button)})`); }
  catch (error) {
    const detail = await window.webContents.executeJavaScript("({state:document.querySelector('.app-shell')?.getAttribute('data-app-ready'),dialog:document.querySelector('dialog[open]')?.textContent,menu:document.querySelector('[role=menu]')?.textContent})");
    throw new Error(`${String(error)}；入口 ${selector}；状态 ${JSON.stringify(detail)}`);
  }
  assert.equal(await window.webContents.executeJavaScript(`document.querySelector(${JSON.stringify(button)}).textContent`), '裁剪');
  await window.webContents.executeJavaScript(`document.querySelector(${JSON.stringify(button)}).click()`);
  try {
    await waitFor(window, "document.querySelector('[data-image-crop] svg') && document.querySelector('.crop-source-loader')?.naturalWidth > 0 && !document.querySelector('[data-image-crop] .crop-status')");
  } catch (error) {
    const detail = await window.webContents.executeJavaScript("document.querySelector('[data-image-crop]')?.textContent");
    throw new Error(`${String(error)}；弹框内容：${detail}`);
  }
}

/** 截图等待 Chromium 完成合成，避免隐藏窗口捕获到上一次弹框的画面。 */
async function capture(window: BrowserWindow, path: string): Promise<void> {
  await window.webContents.executeJavaScript('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolve, 100))))');
  await writeFile(path, (await window.webContents.capturePage()).toPNG());
}

/** 原生鼠标拖动控制点，验证真实指针捕获与局部缩放坐标。 */
async function dragHandle(window: BrowserWindow, handle: string, dx: number, dy: number): Promise<void> {
  const point = await window.webContents.executeJavaScript(`(() => {
    const rect = document.querySelector('[data-crop-handle="${handle}"]').getBoundingClientRect();
    return { x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y + rect.height / 2) };
  })()`);
  window.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...point });
  window.webContents.sendInputEvent({ type: 'mouseMove', button: 'left', x: point.x + dx, y: point.y + dy });
  window.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, x: point.x + dx, y: point.y + dy });
  await window.webContents.executeJavaScript('new Promise(resolve => requestAnimationFrame(resolve))');
}

/** 原像素透明度通过 Electron 原生 PNG 解码独立核对，不使用裁剪实现反推结果。 */
function alpha(png: Buffer, x: number, y: number): number {
  const image = nativeImage.createFromBuffer(png), size = image.getSize();
  return image.toBitmap()[(y * size.width + x) * 4 + 3]!;
}

/** 覆盖原像素、事务恢复和真实界面；所有删除只作用于本次 mkdtemp 的画册。 */
export async function runCropSmoke(window: BrowserWindow, output: string, controller: AlbumController): Promise<void> {
  const started = performance.now();
  await mkdir(output, { recursive: true });
  const temporary = await mkdtemp(join(output, '裁剪验收-'));
  const root = join(temporary, '临时画册'); await mkdir(root);
  const store = new AlbumStore(), album = await store.create(root);
  const pixels = Buffer.alloc(160 * 120 * 4);
  for (let y = 0; y < 120; y++) for (let x = 0; x < 160; x++) {
    const at = (y * 160 + x) * 4; pixels[at] = x < 80 ? 30 : 200; pixels[at + 1] = y * 2; pixels[at + 2] = x < 80 ? 220 : 40; pixels[at + 3] = 255;
  }
  const original = nativeImage.createFromBitmap(pixels, { width: 160, height: 120 });
  const source = join(root, 'assets', '照片.jpg'); await writeFile(source, original.toJPEG(95));
  const collision = join(root, 'assets', '照片.png'); await writeFile(collision, original.toPNG());
  const collisionBytes = await readFile(collision);
  const task = new ImageValidationTask();
  const pages = new PageStore(store, (path, format) => task.inspect(path, format));
  const cropper = new CropImages();
  const settings: CropSettings = { shape: 'rectangle', cx: .5, cy: .5, width: .5, height: .5, angle: 0, inverse: false };
  try {
    const rectangle = await task.crop(source, 'jpeg', settings);
    assert.deepEqual(rectangle.bounds, { x: 40, y: 30, width: 80, height: 60 });
    assert.deepEqual(nativeImage.createFromBuffer(rectangle.png).getSize(), { width: 80, height: 60 });
    assert.equal(alpha(rectangle.png, 0, 0), 255);
    const ellipse = await task.crop(source, 'jpeg', { ...settings, shape: 'ellipse' });
    assert.equal(alpha(ellipse.png, 0, 0), 0); assert.equal(alpha(ellipse.png, 40, 30), 255);
    const heart = await task.crop(source, 'jpeg', { ...settings, shape: 'heart' });
    assert.equal(alpha(heart.png, 0, 59), 0); assert.equal(alpha(heart.png, 40, 30), 255);
    const inverse = await task.crop(source, 'jpeg', { ...settings, shape: 'ellipse', inverse: true });
    assert.deepEqual(inverse.bounds, { x: 0, y: 0, width: 160, height: 120 });
    assert.equal(alpha(inverse.png, 80, 60), 0); assert.equal(alpha(inverse.png, 0, 0), 255);
    const rotated = await task.crop(source, 'jpeg', { ...settings, angle: 30 });
    assert.equal(alpha(rotated.png, 0, 0), 0);
    await assert.rejects(task.crop(source, 'jpeg', { ...settings, width: NaN }));
    await assert.rejects(task.crop(source, 'jpeg', { ...settings, width: 1, height: 1, inverse: true }), /没有可见/u);

    await pages.create(album.id, '裁剪画布', 'portrait');
    const pageId = pages.snapshot()!.pageId;
    await pages.addImage(album.id, pageId, '照片.jpg');
    const initial = pages.snapshot()!.document.objects[0] as ImageObject;
    pages.resize(album.id, pageId, initial.id, { xMm: 15, yMm: 35, widthMm: 120, heightMm: 60 });
    pages.rotate(album.id, pageId, initial.id, 30); pages.renameObject(album.id, pageId, initial.id, '裁剪测试'); await pages.save();
    const before = structuredClone(pages.snapshot()!.document.objects[0]) as ImageObject;
    const originalPagePath = await pages.imagePath(album.id, pageId, initial.id), originalPageBytes = await readFile(originalPagePath);
    let session = await cropper.begin({ kind: 'page', albumId: album.id, pageId, objectId: initial.id }, store, pages);
    await cropper.apply(session.token, settings, store, pages); await cropper.release(session.token);
    const first = pages.snapshot()!.document.objects[0] as ImageObject;
    assert(pages.dirty); assert.equal(first.widthMm, 60); assert.equal(first.heightMm, 30);
    assert.equal(first.xMm + first.widthMm / 2, before.xMm + before.widthMm / 2);
    assert.equal(first.yMm + first.heightMm / 2, before.yMm + before.heightMm / 2);
    assert.equal(first.rotation, 30); assert.equal(first.displayName, '裁剪测试'); assert.equal(first.id, before.id);
    assert.deepEqual(await readFile(originalPagePath), originalPageBytes);
    const stagedPath = await pages.imagePath(album.id, pageId, initial.id);
    assert.notEqual(stagedPath, originalPagePath);
    // 第二次输入确实为第一次的 80×60 结果，保留已有透明度。
    session = await cropper.begin({ kind: 'page', albumId: album.id, pageId, objectId: initial.id }, store, pages);
    assert.equal(session.width, 80); assert.equal(session.height, 60);
    await cropper.apply(session.token, { ...settings, shape: 'ellipse' }, store, pages); await cropper.release();
    await assert.rejects(lstat(stagedPath));
    await pages.discard(); assert(!pages.dirty);
    assert.equal(await pages.imagePath(album.id, pageId, initial.id), originalPagePath);
    assert((pages.snapshot()!.document.nextImageNumber) > Number(first.fileName.split('.')[0]));

    // 偏心裁剪验证对象旋转后的毫米位置补偿，保留内容不能跳动。
    session = await cropper.begin({ kind: 'page', albumId: album.id, pageId, objectId: initial.id }, store, pages);
    await cropper.apply(session.token, { ...settings, cx: .4, cy: .45 }, store, pages); await cropper.release();
    const offset = pages.snapshot()!.document.objects[0]!;
    assert(Math.abs(offset.xMm + offset.widthMm / 2 - (before.xMm + before.widthMm / 2 - 12 * Math.sqrt(3) / 2 + 1.5)) < 1e-7);
    assert(Math.abs(offset.yMm + offset.heightMm / 2 - (before.yMm + before.heightMm / 2 - 6 - 3 * Math.sqrt(3) / 2)) < 1e-7);
    await pages.discard();

    // 外部恰好创建了预留名称时，保存拒绝覆盖；放弃和恢复清理也不能误删外部文件。
    session = await cropper.begin({ kind: 'page', albumId: album.id, pageId, objectId: initial.id }, store, pages);
    await cropper.apply(session.token, settings, store, pages); await cropper.release();
    const conflictName = (pages.snapshot()!.document.objects[0] as ImageObject).fileName;
    const conflictPath = join(root, 'pages', '001', conflictName);
    await writeFile(conflictPath, '外部同名文件');
    await assert.rejects(pages.save()); await pages.discard();
    assert.equal(await readFile(conflictPath, 'utf8'), '外部同名文件');
    await unlink(conflictPath); await pages.load(album.id, pageId);

    session = await cropper.begin({ kind: 'page', albumId: album.id, pageId, objectId: initial.id }, store, pages);
    await cropper.apply(session.token, { ...settings, shape: 'heart' }, store, pages); await cropper.release();
    const jsonPath = join(root, 'pages', '001', 'canvas.json'), savedText = await readFile(jsonPath, 'utf8');
    await writeFile(jsonPath, savedText + ' ');
    await assert.rejects(pages.save()); assert(pages.dirty); assert.deepEqual(await readFile(originalPagePath), originalPageBytes);
    await writeFile(jsonPath, savedText); await pages.save(); assert(!pages.dirty);
    await assert.rejects(lstat(originalPagePath));
    const files = await readdir(join(root, 'pages', '001'));
    assert.equal(files.filter(name => /\.(png|jpg)$/u.test(name)).length, 1); assert(!files.some(name => name.startsWith('.crop-')));
    await pages.load(album.id, pageId);
    assert.equal((pages.snapshot()!.document.objects[0] as ImageObject).rotation, 30);

    session = await cropper.begin({ kind: 'asset', albumId: album.id, path: '照片.jpg' }, store, pages);
    const newPath = await cropper.apply(session.token, { ...settings, inverse: true, shape: 'ellipse' }, store, pages);
    await cropper.release(); assert.equal(newPath, '照片 (1).png');
    assert.deepEqual(await readFile(collision), collisionBytes); await assert.rejects(lstat(source));
    session = await cropper.begin({ kind: 'asset', albumId: album.id, path: newPath! }, store, pages);
    await cropper.apply(session.token, { ...settings, width: 1, height: 1 }, store, pages); await cropper.release();
    assert.equal(alpha(await readFile(join(root, 'assets', newPath!)), 80, 60), 0);
    session = await cropper.begin({ kind: 'asset', albumId: album.id, path: newPath! }, store, pages);
    await writeFile(join(root, 'assets', newPath!), original.toPNG());
    await assert.rejects(cropper.apply(session.token, settings, store, pages), /变化/u); await cropper.release();
    await assert.rejects(cropper.begin({ kind: 'asset', albumId: album.id, path: '../project.json' }, store, pages));

    // 模拟确认后未保存就退出：新实例根据事务记录清理暂存，保留正式图片与已预留计数。
    const savedFileName = (pages.snapshot()!.document.objects[0] as ImageObject).fileName;
    session = await cropper.begin({ kind: 'page', albumId: album.id, pageId, objectId: initial.id }, store, pages);
    await cropper.apply(session.token, settings, store, pages); await cropper.release();
    const stagedNumber = pages.snapshot()!.document.nextImageNumber;
    const recovery = new PageStore(store, (path, format) => task.inspect(path, format));
    await recovery.load(album.id, pageId);
    assert.equal((recovery.snapshot()!.document.objects[0] as ImageObject).fileName, savedFileName);
    assert.equal(recovery.snapshot()!.document.nextImageNumber, stagedNumber);
    assert(!(await readdir(join(root, 'pages', '001'))).some(name => name.startsWith('.crop-')));

    // 左侧 JPEG/PNG 入口及预览按钮通过真实生产 preload 与 DOM 验收。
    await copyFile(collision, join(root, 'assets', '界面测试.png'));
    const live = await controller.loadSmokeAlbum(root);
    await waitFor(window, "document.querySelector('[data-asset-file=\"界面测试.png\"]')");
    await openCrop(window, '[data-asset-file="界面测试.png"]', '[data-crop-asset]');
    await capture(window, join(temporary, '素材裁剪原图.png'));
    const beforeCancel = await readFile(join(root, 'assets', '界面测试.png'));
    await window.webContents.executeJavaScript("document.querySelector('[aria-label=\"裁剪形状\"]').value='ellipse';document.querySelector('[aria-label=\"裁剪形状\"]').dispatchEvent(new Event('change',{bubbles:true}));document.querySelector('.crop-inverse input').click()");
    await window.webContents.executeJavaScript("Array.from(document.querySelectorAll('[data-image-crop] button')).find(b=>b.textContent==='预览').click()");
    await waitFor(window, "document.querySelector('.crop-result')?.complete && !document.querySelector('.crop-status')");
    const previewAlpha = await window.webContents.executeJavaScript(`(() => {
      const image = document.querySelector('.crop-result'), canvas = document.createElement('canvas');
      canvas.width = image.naturalWidth; canvas.height = image.naturalHeight;
      const context = canvas.getContext('2d'); context.drawImage(image, 0, 0);
      const result = [context.getImageData(80,60,1,1).data[3], context.getImageData(0,0,1,1).data[3]];
      canvas.width=0;canvas.height=0;return result;
    })()`);
    assert.deepEqual(previewAlpha, [0, 255]);
    await capture(window, join(temporary, '素材裁剪预览.png'));
    await window.webContents.executeJavaScript("Array.from(document.querySelectorAll('[data-image-crop] button')).find(b=>b.textContent==='返回调整').click()");
    await waitFor(window, "document.querySelector('[data-image-crop] svg')");
    await window.webContents.executeJavaScript("Array.from(document.querySelectorAll('[data-image-crop] button')).find(b=>b.textContent==='取消').click()");
    await waitFor(window, "!document.querySelector('[data-image-crop]')");
    assert.deepEqual(await readFile(join(root, 'assets', '界面测试.png')), beforeCancel);
    await openCrop(window, '[data-asset-file="界面测试.png"]', '[data-crop-asset]');
    await window.webContents.executeJavaScript("document.querySelector('[data-image-crop] .primary-button').click()");
    await waitFor(window, "!document.querySelector('[data-image-crop]')");
    assert.deepEqual(nativeImage.createFromPath(join(root, 'assets', '界面测试.png')).getSize(), { width: 128, height: 96 });
    const objectId = (await window.webContents.executeJavaScript('window.desktop.getAlbumState()')).canvas.document.objects[0].id;
    await openCrop(window, `[data-object-button="${objectId}"]`, '[data-crop-object]');
    const frame = (): Promise<{ width: number; height: number }> => window.webContents.executeJavaScript("({width:+document.querySelector('.crop-frame').getAttribute('width'),height:+document.querySelector('.crop-frame').getAttribute('height')})");
    const initialFrame = await frame();
    await dragHandle(window, 'se', -30, -20);
    const cornerFrame = await frame();
    assert(cornerFrame.width < initialFrame.width);
    assert(Math.abs(cornerFrame.width / cornerFrame.height - initialFrame.width / initialFrame.height) < 1e-7);
    await dragHandle(window, 'e', 20, 0);
    const edgeFrame = await frame(); assert(edgeFrame.width > cornerFrame.width); assert.equal(edgeFrame.height, cornerFrame.height);
    await dragHandle(window, 'e', 300, 0);
    const boundaryFrame = await frame(); assert.equal(boundaryFrame.height, edgeFrame.height);
    assert(boundaryFrame.width >= edgeFrame.width);
    await dragHandle(window, 'rotate', 40, 20);
    assert.notEqual(await window.webContents.executeJavaScript("document.querySelector('[aria-label=\"裁剪旋转角度\"]').value"), '0');
    assert.equal(await window.webContents.executeJavaScript("document.querySelector('.crop-result')"), null);
    await window.webContents.executeJavaScript("document.querySelector('[aria-label=\"裁剪形状\"]').value='heart';document.querySelector('[aria-label=\"裁剪形状\"]').dispatchEvent(new Event('change',{bubbles:true}))");
    await capture(window, join(temporary, '画布裁剪编辑.png'));
    await window.webContents.executeJavaScript("document.querySelector('[data-image-crop] .primary-button').click()");
    await waitFor(window, "!document.querySelector('[data-image-crop]') && document.querySelector('.page-unsaved-marker')");
    assert.equal((await window.webContents.executeJavaScript('window.desktop.getAlbumState()')).album.id, live.id);
    assert.equal((await window.webContents.executeJavaScript('window.desktop.savePage()')).status, 'success');
    await waitFor(window, "!document.querySelector('.page-unsaved-marker')");
    assert.equal(await window.webContents.executeJavaScript("document.querySelector('.canvas-picture img').naturalWidth > 0"), true);
    // 裁剪后的透明 PNG 通过正式 PDF 导出；独立解析检查 A4、原始像素和透明蒙版。
    const originalSave = dialog.showSaveDialog;
    const pdfPath = join(temporary, '裁剪导出.pdf');
    try {
      dialog.showSaveDialog = (async () => ({ canceled: false, filePath: pdfPath })) as typeof dialog.showSaveDialog;
      assert.equal((await controller.exportPdf()).status, 'success');
    } finally { dialog.showSaveDialog = originalSave; }
    const pdf = await PDFDocument.load(await readFile(pdfPath));
    assert.equal(pdf.getPageCount(), 1);
    const paper = pdf.getPage(0).getSize();
    assert(Math.abs(paper.width * 25.4 / 72 - 210) < .01); assert(Math.abs(paper.height * 25.4 / 72 - 297) < .01);
    assert(pdf.context.enumerateIndirectObjects().some(([, object]) => object instanceof PDFRawStream
      && object.dict.get(PDFName.of('Subtype')) === PDFName.of('Image') && object.dict.has(PDFName.of('SMask'))));
    assert.deepEqual(cropPixelBounds(settings, 160, 120), rectangle.bounds);
    const report = { elapsedMs: Math.round(performance.now() - started), checks: ['矩形/椭圆/心形/旋转/反向透明像素', '二次裁剪与透明度保留', '保存重开/旧图清理/编号不复用', '放弃/保存失败/素材同名冲突/外部修改/路径安全', '左右真实菜单/按钮预览/取消/确认/手动保存', '真实鼠标四角等比/边中点单轴/旋转', '正式PDF竖向A4与透明蒙版'], directory: temporary };
    await writeFile(join(temporary, 'report.json'), JSON.stringify(report, null, 2)); console.log('裁剪验收通过', report);
  } finally { task.dispose(); await cropper.release(); }
}
