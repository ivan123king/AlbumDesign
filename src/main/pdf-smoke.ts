/** 文件用途：仅使用临时画册验收真实 PDF、命名、页序、取消、异常和旧文件保护。 */
import assert from 'node:assert/strict';
import { copyFile, mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { app, dialog, Menu, nativeImage } from 'electron';
import type { BrowserWindow, SaveDialogOptions, MessageBoxOptions } from 'electron';
import type { AlbumState, AlbumResult } from '../shared/album';
import type { TextObject } from '../shared/canvas';
import { pdfFileName } from '../shared/pdf';
import { AlbumStore } from './album-store';
import { PageStore } from './page-store';
import { getTextFonts } from './text-fonts';
import type { AlbumController } from './album-ipc';

/** 等待真实渲染状态，条件失败直接报告，不依赖固定长延时。 */
async function waitFor(window: BrowserWindow, expression: string): Promise<void> {
  await window.webContents.executeJavaScript(`(async () => {
    for (let index = 0; !(${expression}); index++) {
      if (index > 400) throw new Error('PDF 界面等待超时：' + ${JSON.stringify(expression)});
      await new Promise(resolve => setTimeout(resolve, 25));
    }
  })()`);
}

/** 十页混合排版包含原图、缩放文字、竖排、任意角度、透明图、越界与一页空白。 */
export async function runPdfSmoke(window: BrowserWindow, output: string, controller: AlbumController): Promise<void> {
  await mkdir(output, { recursive: true });
  const temporary = await mkdtemp(join(output, 'PDF验收-'));
  const root = join(temporary, '旅行回忆'); await mkdir(root);
  const store = new AlbumStore(); const album = await store.create(root);
  const pages = new PageStore(store, async () => ({ width: 1200, height: 800 }));
  const font = (await getTextFonts()).find(item => item.available); assert(font, '未找到可用中文字体');
  const bitmap = Buffer.alloc(1200 * 800 * 4);
  for (let y = 0; y < 800; y++) for (let x = 0; x < 1200; x++) {
    const at = (y * 1200 + x) * 4;
    bitmap[at] = x < 600 ? 45 : 180; bitmap[at + 1] = y < 400 ? 150 : 70; bitmap[at + 2] = 90; bitmap[at + 3] = 255;
  }
  const original = nativeImage.createFromBitmap(bitmap, { width: 1200, height: 800 }).toJPEG(96);
  const overlay = nativeImage.createFromBitmap(Buffer.from([30, 50, 220, 150]), { width: 1, height: 1 }).toPNG();
  const references = [];
  for (let index = 0; index < 10; index++) {
    await pages.create(album.id, `测试画布${index + 1}`, index % 2 ? 'landscape' : 'portrait');
    const snapshot = pages.snapshot()!; const document = snapshot.document;
    const reference = store.pageReferences(album.id)[index]!; references.push(reference);
    if (index !== 9) {
      document.nextImageNumber = 4;
      const text: TextObject = { id: randomUUID(), kind: 'text', xMm: 18, yMm: 15, widthMm: 170, heightMm: 30,
        layoutWidthMm: 170, layoutHeightMm: 30, rotation: 0, zIndex: 2, text: `第 ${index + 1} 页 · 中文画册 ABC 123`,
        writingMode: 'horizontal', fontFamily: font.family, fontSizePt: 22, color: '#203020', letterSpacingPt: .5,
        lineSpacing: 1.4, columns: 1, columnGapMm: 3 };
      document.objects = [
        { id: randomUUID(), kind: 'image', fileName: '001.jpg', sourceName: '1200像素原图.jpg', xMm: 15, yMm: 65,
          widthMm: 120, heightMm: 80, rotation: index * 7, zIndex: 0 },
        { id: randomUUID(), kind: 'image', fileName: '002.png', sourceName: '半透明叠层.png', xMm: 100, yMm: 110,
          widthMm: 50, heightMm: 50, rotation: 17, zIndex: 3 },
        { id: randomUUID(), kind: 'image', fileName: '003.jpg', sourceName: '越界图片.jpg', xMm: -10, yMm: 280,
          widthMm: 90, heightMm: 60, rotation: 0, zIndex: 1 },
        text,
        { ...text, id: randomUUID(), text: '天地玄黄\n宇宙洪荒', writingMode: 'vertical', xMm: 170, yMm: 60,
          widthMm: 28, heightMm: 120, layoutWidthMm: 28, layoutHeightMm: 120, zIndex: 4 },
        { ...text, id: randomUUID(), text: '等比缩放与旋转\n中文标点，。！？', xMm: 25, yMm: 185, widthMm: 153,
          heightMm: 27, rotation: 12.5, zIndex: 5 }
      ];
      await writeFile(join(root, 'pages', reference.directoryName, '001.jpg'), original);
      await writeFile(join(root, 'pages', reference.directoryName, '002.png'), overlay);
      await writeFile(join(root, 'pages', reference.directoryName, '003.jpg'), original);
    }
    await writeFile(join(root, 'pages', reference.directoryName, 'canvas.json'), JSON.stringify(document));
  }
  // 人为调整页序，保证不能按固定目录编号输出。
  const { manifest } = await store.project(album.id);
  manifest.pages = [references[2]!, references[0]!, references[1]!, ...references.slice(3)];
  await store.commitManifest(album.id, manifest);
  assert.equal(pdfFileName('中文画册', new Date(2026, 0, 2)), '中文画册-20260102.pdf');
  assert.equal(pdfFileName('旅行回忆', new Date(2026, 9, 19)), '旅行回忆-20261019.pdf');
  assert.throws(() => pdfFileName('../非法名字'));

  const originalSave = dialog.showSaveDialog; const originalMessage = dialog.showMessageBox;
  let destination = join(temporary, pdfFileName(album.name)); let saveCanceled = false; let answer = 0;
  let defaultName = ''; const errors: string[] = [];
  dialog.showSaveDialog = (async (...args: unknown[]) => {
    defaultName = (args[args.length - 1] as SaveDialogOptions).defaultPath ?? '';
    return { canceled: saveCanceled, filePath: destination };
  }) as typeof dialog.showSaveDialog;
  dialog.showMessageBox = (async (...args: unknown[]) => {
    const options = args[args.length - 1] as MessageBoxOptions;
    if (options.type === 'error') errors.push(options.message);
    return { response: answer, checkboxChecked: false };
  }) as typeof dialog.showMessageBox;
  /** 通过 preload 调用正式接口，不新增生产验收权限。 */
  const state = (): Promise<AlbumState> => window.webContents.executeJavaScript('window.desktop.getAlbumState()');
  const exportPdf = (): Promise<AlbumResult<string>> => window.webContents.executeJavaScript('window.desktop.exportAlbumPdf()');
  /** 每个失败或取消用例后均检查任务临时目录已清理。 */
  const clean = async (): Promise<void> => { assert(!(await readdir(temporary)).some(name => name.startsWith('.album-pdf-'))); };
  let peakWorkingSetKB = 0;
  const measure = setInterval(() => {
    peakWorkingSetKB = Math.max(peakWorkingSetKB, app.getAppMetrics().reduce((sum, item) => sum + item.memory.workingSetSize, 0));
  }, 100);
  const started = performance.now();
  let singleExportSeconds = 0;
  try {
    assert.equal((await controller.exportPdf()).status, 'error');
    await controller.loadSmokeAlbum(root); await waitFor(window, "!document.querySelector('[data-export-pdf]').disabled");
    await assert.rejects(window.webContents.executeJavaScript('window.desktop.getPdfPrintPage()'));
    assert.equal(Menu.getApplicationMenu()?.getMenuItemById('export-pdf')?.enabled, true);
    const first = (await state()).canvas!; const albumId = (await state()).album!.id;
    const object = first.document.objects.find(item => item.kind === 'image')!;
    await window.webContents.executeJavaScript(`window.desktop.rotatePageObject(${JSON.stringify(albumId)},${JSON.stringify(first.pageId)},${JSON.stringify(object.id)},33)`);
    answer = 1; assert.equal((await exportPdf()).status, 'canceled'); assert((await state()).canvas!.dirty);
    answer = 0; saveCanceled = true;
    assert.equal((await exportPdf()).status, 'canceled'); assert(!(await state()).canvas!.dirty);
    saveCanceled = false;
    const firstExportStart = performance.now();
    const result = await exportPdf(); assert.equal(result.status, 'success');
    singleExportSeconds = (performance.now() - firstExportStart) / 1000;
    assert.equal(defaultName, pdfFileName(album.name)); assert.equal((await state()).canvas!.pageId, first.pageId);
    assert.equal((await readFile(destination)).subarray(0, 5).toString(), '%PDF-');
    await clean();
    await waitFor(window, "!document.querySelector('[data-export-pdf]').disabled");
    await writeFile(join(temporary, 'editor.png'), (await window.webContents.capturePage()).toPNG());
    const baseline = destination;
    const beforeView = join(temporary, '切换前.pdf'); await copyFile(destination, beforeView);
    // 同一文件覆盖成功；仅切换编辑视角，输出应可逐像素比对。
    await window.webContents.executeJavaScript(`window.desktop.setPageOrientation(${JSON.stringify(albumId)},${JSON.stringify(first.pageId)},'landscape')`);
    destination = join(temporary, '切换视角.pdf'); assert.equal((await exportPdf()).status, 'success');
    const rotated = destination;
    destination = baseline; assert.equal((await exportPdf()).status, 'success'); await clean();
    const previous = await readFile(destination);

    // 真实进度期间拒绝保存/新建等命令，界面取消保留原有 PDF。
    const running = exportPdf();
    await waitFor(window, "document.querySelector('[data-pdf-progress]')");
    assert.equal((await window.webContents.executeJavaScript('window.desktop.savePage()')).status, 'error');
    assert.equal(Menu.getApplicationMenu()?.getMenuItemById('export-pdf')?.enabled, false);
    await writeFile(join(temporary, 'progress.png'), (await window.webContents.capturePage()).toPNG());
    await window.webContents.executeJavaScript("document.querySelector('[data-pdf-progress] button').click()");
    assert.equal((await running).status, 'canceled'); assert.deepEqual(await readFile(destination), previous); await clean();

    // 合并阶段独立取消，验证线程终止不会让任务永久挂起。
    await window.webContents.executeJavaScript(`window.pdfSmokeUnsubscribe = window.desktop.onAlbumState(state => {
      if (state.pdfProgress?.phase === 'merging' && !state.pdfProgress.canceling) void window.desktop.cancelPdfExport();
    }); true`);
    assert.equal((await exportPdf()).status, 'canceled');
    await window.webContents.executeJavaScript('window.pdfSmokeUnsubscribe(); delete window.pdfSmokeUnsubscribe');
    assert.deepEqual(await readFile(destination), previous); await clean();

    // 导出期间外部修改目标，最终提交必须拒绝覆盖该外部修改。
    const changedTarget = exportPdf(); await waitFor(window, "document.querySelector('[data-pdf-progress]')");
    await writeFile(destination, '外部更新的目标文件');
    assert.equal((await changedTarget).status, 'error'); assert.equal(await readFile(destination, 'utf8'), '外部更新的目标文件');
    await writeFile(destination, previous); await clean();

    // 缺失、损坏原图及缺失字体均不能发布不完整文件。
    const folder = join(root, 'pages', references[0]!.directoryName);
    const file = join(folder, '001.jpg');
    const savedImage = join(temporary, '原图备份.jpg'); await copyFile(file, savedImage);
    const { unlink } = await import('node:fs/promises'); await unlink(file);
    assert.equal((await exportPdf()).status, 'error'); assert.deepEqual(await readFile(destination), previous); await clean();
    await writeFile(file, '损坏图片'); assert.equal((await exportPdf()).status, 'error'); await clean();
    await copyFile(savedImage, file);
    const canvasFile = join(folder, 'canvas.json'); const oldCanvas = await readFile(canvasFile, 'utf8');
    const invalid = JSON.parse(oldCanvas); invalid.objects.find((item: { kind: string }) => item.kind === 'text').fontFamily = '不存在的字体';
    await writeFile(canvasFile, JSON.stringify(invalid)); assert.equal((await exportPdf()).status, 'error');
    await writeFile(canvasFile, oldCanvas); assert.deepEqual(await readFile(destination), previous); await clean();

    destination = join(root, 'assets', '禁止写入.pdf'); assert.equal((await exportPdf()).status, 'error');
    destination = join(temporary, '目标目录.pdf'); await mkdir(destination); assert.equal((await exportPdf()).status, 'error');
    destination = join(temporary, '不存在的目录', '无法写入.pdf'); assert.equal((await exportPdf()).status, 'error'); await clean();
    assert(!(await state()).busy); assert(!(await state()).pdfProgress);
    await writeFile(join(temporary, 'report.json'), JSON.stringify({
      pageCount: 10, expectedPageLabels: [3, 1, 2, 4, 5, 6, 7, 8, 9, null], font: font.family,
      baseline: beforeView, rotated, finalPdf: baseline, defaultName, originalImagePixels: [1200, 800],
      checks: ['名称日期补零', '真实IPC与来源限制', '菜单与按钮', '未保存取消与保存', '保存位置取消', '同名覆盖', '忙碌互斥',
        '打印取消保留旧文件', '合并取消保留旧文件', '外部目标更新拒绝覆盖', '缺图拒绝', '坏图拒绝', '无效字体拒绝', '资源目录拒绝', '目标目录拒绝', '写入失败', '临时目录清理'],
      singleExportSeconds, suiteElapsedSeconds: (performance.now() - started) / 1000, peakAppWorkingSetMB: peakWorkingSetKB / 1024,
      environment: { platform: process.platform, arch: process.arch, electron: process.versions.electron, node: process.versions.node },
      errors, limitations: ['合成图片十页，非300～500页真实照片', '原生保存框与实体试印待人工验收', '独立线程内存包含在主进程工作集中']
    }, null, 2));
    console.log(`PDF 验收通过：${temporary}`);
  } finally { clearInterval(measure); dialog.showSaveDialog = originalSave; dialog.showMessageBox = originalMessage; }
}
