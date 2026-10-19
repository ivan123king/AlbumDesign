/** 文件用途：临时画册验收横竖文字、等比缩放、任意角度旋转、旧页兼容和文字打印样例。 */
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { dialog, nativeImage } from 'electron';
import type { BrowserWindow } from 'electron';
import { AlbumStore } from './album-store';
import { PageStore } from './page-store';
import { ImageValidationTask } from './image-validator';
import { getTextFonts } from './text-fonts';
import type { AlbumController } from './album-ipc';
import type { AlbumState } from '../shared/album';
import type { CanvasObject, TextDraft, TextObject } from '../shared/canvas';
import { centeredGeometry, normalizeAngle, rotateVector } from '../shared/canvas';

/** 读取真实渲染进程状态并等待绘制，不替换文字与旋转业务接口。 */
async function waitFor(window: BrowserWindow, expression: string): Promise<void> {
  await window.webContents.executeJavaScript(`(async () => {
    for (let i = 0; !(${expression}); i++) {
      if (i > 300) throw new Error('文字验收等待超时：' + ${JSON.stringify(expression)});
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  })()`);
}

/** 等待隐藏窗口合成器生成当前画面。 */
async function capture(window: BrowserWindow, path: string): Promise<void> {
  await window.webContents.executeJavaScript('new Promise(resolve => setTimeout(() => requestAnimationFrame(() => requestAnimationFrame(resolve)), 150))');
  await writeFile(path, (await window.webContents.capturePage()).toPNG());
}

/** 表单输入使用 DOM 原生事件，保留 React 与中文文本处理链路。 */
async function fill(window: BrowserWindow, id: string, value: string): Promise<void> {
  await window.webContents.executeJavaScript(`(() => {
    const input = document.getElementById(${JSON.stringify(id)});
    Object.getOwnPropertyDescriptor(input.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype, 'value').set.call(input, ${JSON.stringify(value)});
    input.dispatchEvent(new Event('input', {bubbles:true}));
  })()`);
  await waitFor(window, `document.getElementById(${JSON.stringify(id)}).value === ${JSON.stringify(value)}`);
}

/** 选中真实对象并确认控制点已切换到相应数量。 */
async function select(window: BrowserWindow, id: string, count: number): Promise<void> {
  await window.webContents.executeJavaScript(`(() => {
    const button = [...document.querySelectorAll('[data-object-button]')].find(item => item.dataset.objectButton === ${JSON.stringify(id)});
    button.scrollIntoView({block:'nearest'}); button.click();
  })()`);
  await waitFor(window, `document.querySelector('[data-selection-for]')?.dataset.selectionFor === ${JSON.stringify(id)} && document.querySelectorAll('[data-resize-handle]').length === ${count}`);
}

/** 用圆弧上的真实指针位置旋转，核对预览期间不提前修改模型。 */
async function rotate(window: BrowserWindow, degrees: number, cancel = false): Promise<void> {
  const point = await window.webContents.executeJavaScript(`(() => {
    const h = document.querySelector('[data-rotation-handle]').getBoundingClientRect();
    const r = document.querySelector('[data-selection-for]').getBoundingClientRect();
    return {x:Math.round(h.left+h.width/2),y:Math.round(h.top+h.height/2),cx:r.left+r.width/2,cy:r.top+r.height/2};
  })()`);
  window.webContents.sendInputEvent({ type: 'mouseDown', x: point.x, y: point.y, button: 'left', clickCount: 1 });
  await waitFor(window, "document.querySelector('[data-resizing]').dataset.resizing === 'true'");
  let end = { x: point.x, y: point.y };
  for (let i = 1; i <= 6; i++) {
    const delta = rotateVector(point.x - point.cx, point.y - point.cy, degrees * i / 6);
    end = { x: Math.round(point.cx + delta.x), y: Math.round(point.cy + delta.y) };
    window.webContents.sendInputEvent({ type: 'mouseMove', ...end, modifiers: ['leftbuttondown'] });
    await window.webContents.executeJavaScript('new Promise(resolve => requestAnimationFrame(resolve))');
  }
  if (cancel) {
    window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' }); window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' });
  }
  window.webContents.sendInputEvent({ type: 'mouseUp', ...end, button: 'left', clickCount: 1 });
  await waitFor(window, "document.querySelector('[data-resizing]').dataset.resizing === 'false' && !document.querySelector('.add-page').disabled");
}

/** 在同一真实文字 DOM 上打印单页验证样例，不增加正式画册导出入口。 */
async function printSample(window: BrowserWindow, file: string): Promise<void> {
  const css = await window.webContents.insertCSS(`@media print {
    html,body,#root,.app-shell,.editor-layout,.canvas-panel,.workspace,.canvas-stage { width:210mm!important; height:297mm!important; min-width:0!important; min-height:0!important; max-height:297mm!important; margin:0!important; padding:0!important; display:block!important; overflow:clip!important; background:white!important; }
    .app-header,.toolbar,.side-panel,.panel-divider,.canvas-toolbar,.canvas-bottom,.status-bar,.page-label,.canvas-hint,.object-selection,.text-overflow-hint {display:none!important;}
    .scaled-page,.canvas-view {width:210mm!important;height:297mm!important;transform:none!important;box-shadow:none!important;}
    .paper.editable-paper {position:absolute!important;top:0!important;left:0!important;transform:none!important;}
  }`);
  try {
    await window.webContents.executeJavaScript('document.fonts.ready.then(() => Promise.all([...document.images].map(image => image.decode())))');
    const pdf = await window.webContents.printToPDF({ pageSize: 'A4', landscape: false, printBackground: true,
      displayHeaderFooter: false, preferCSSPageSize: true, margins: { top: 0, bottom: 0, left: 0, right: 0 } });
    await writeFile(file, pdf);
  } finally { await window.webContents.removeInsertedCSS(css); }
}

/** 所有数据、异常和删除都只发生在测试新建目录中，完全隔离用户画册。 */
export async function runTextSmoke(window: BrowserWindow, output: string, controller: AlbumController): Promise<void> {
  window.webContents.on('console-message', event => { console.log('文字渲染：' + event.message); });
  await mkdir(output, { recursive: true });
  const temporary = await mkdtemp(join(output, '文字验收-')); const root = join(temporary, '中文画册'); await mkdir(root);
  const albums = new AlbumStore(); const album = await albums.create(root);
  const validator = new ImageValidationTask(); const pages = new PageStore(albums, (path, format) => validator.inspect(path, format));
  const fonts = await getTextFonts(); const font = fonts.find(item => item.available); assert(font, '无可用中文字体');
  const bitmap = Buffer.alloc(8 * 4 * 4);
  for (let i = 0; i < bitmap.length; i += 4) { bitmap[i] = 170; bitmap[i + 1] = 110; bitmap[i + 2] = 55; bitmap[i + 3] = 255; }
  const png = nativeImage.createFromBitmap(bitmap, { width: 8, height: 4 }).toPNG();
  await writeFile(join(root, 'assets', '测试图.png'), png);
  let horizontalId = ''; let verticalId = ''; let pageId = '';
  const base: TextDraft = { text: '春风又绿江南岸，明月何时照我还。\nABC 123，中文标点！？', writingMode: 'horizontal',
    fontFamily: font.family, fontSizePt: 18, color: '#30332f', letterSpacingPt: .5, lineSpacing: 1.6, columns: 2, columnGapMm: 3, widthMm: 120, heightMm: 60 };
  try {
    await pages.create(album.id, '文字与旋转', 'portrait'); pageId = pages.snapshot()!.pageId;
    const canvasFile = join(root, 'pages', '001', 'canvas.json');
    const legacy = pages.snapshot()!.document; legacy.formatVersion = 1;
    await writeFile(canvasFile, JSON.stringify(legacy, null, 2) + '\n'); await pages.load(album.id, pageId);
    assert.equal(pages.snapshot()!.document.formatVersion, 1); assert(!pages.dirty);
    await pages.addImage(album.id, pageId, '测试图.png');
    const image = pages.snapshot()!.document.objects[0]!;
    pages.rotate(album.id, pageId, image.id, 37.25); assert.equal(pages.snapshot()!.document.formatVersion, 2);
    assert.equal(JSON.parse(await readFile(canvasFile, 'utf8')).formatVersion, 1);
    await pages.save(); assert.equal(JSON.parse(await readFile(canvasFile, 'utf8')).formatVersion, 2);
    const counter = pages.snapshot()!.document.nextImageNumber;
    horizontalId = await pages.putText(album.id, pageId, null, base);
    verticalId = await pages.putText(album.id, pageId, null, { ...base, writingMode: 'vertical', columns: 1,
      text: '天地玄黄宇宙洪荒\n日月盈昃辰宿列张', widthMm: 60, heightMm: 100 });
    assert.equal(pages.snapshot()!.document.nextImageNumber, counter);
    assert.equal((await readdir(join(root, 'pages', '001'))).length, 2);
    const horizontal = pages.snapshot()!.document.objects.find(item => item.id === horizontalId)! as TextObject;
    pages.resize(album.id, pageId, horizontalId, centeredGeometry(horizontal, 180, 90));
    const scaled = pages.snapshot()!.document.objects.find(item => item.id === horizontalId)! as TextObject;
    assert.equal(scaled.layoutWidthMm, 120); assert.equal(scaled.fontSizePt, 18);
    const unchanged = structuredClone(pages.snapshot()!.document);
    assert.throws(() => pages.resize(album.id, pageId, horizontalId, { ...centeredGeometry(scaled, 181, 90) }), /等比例/u);
    assert.deepEqual(pages.snapshot()!.document, unchanged);
    pages.rotate(album.id, pageId, horizontalId, 724); assert.equal(pages.snapshot()!.document.objects.find(item => item.id === horizontalId)!.rotation, 4);
    await pages.putText(album.id, pageId, horizontalId, { ...base, text: base.text + '\n再次编辑', fontSizePt: 27, widthMm: 180, heightMm: 90 });
    const edited = pages.snapshot()!.document.objects.find(item => item.id === horizontalId)! as TextObject;
    assert.equal(edited.rotation, 4); assert.equal(edited.layoutWidthMm, 180); assert.equal(edited.fontSizePt, 27);
    const beforeView = structuredClone(pages.snapshot()!.document.objects);
    for (let i = 0; i < 6; i++) { pages.setOrientation(album.id, pageId, 'landscape'); pages.setOrientation(album.id, pageId, 'portrait'); }
    assert.deepEqual(pages.snapshot()!.document.objects, beforeView);
    await assert.rejects(pages.putText(album.id, pageId, null, { ...base, fontFamily: '不存在的字体' }));
    assert.throws(() => pages.rotate(album.id, pageId, horizontalId, NaN));
    await pages.save(); await pages.deleteObject(album.id, pageId, horizontalId);
    assert.deepEqual(await readFile(join(root, 'pages', '001', '001.png')), png);
    assert.equal(pages.snapshot()!.document.nextImageNumber, counter);
    await pages.load(album.id, pageId); assert.equal(pages.snapshot()!.document.objects.find(item => item.id === verticalId)!.kind, 'text');
  } finally { validator.dispose(); }
  const moved = join(temporary, '搬迁后的文字画册'); await rename(root, moved);
  console.log('文字验收：模型、等比限制、格式升级及文件检查通过。');
  const loaded = await controller.loadSmokeAlbum(moved); const albumId = loaded.id;
  const state = async (): Promise<AlbumState> => window.webContents.executeJavaScript('window.desktop.getAlbumState()');
  const object = async (id: string): Promise<CanvasObject> => (await state()).canvas!.document.objects.find(item => item.id === id)!;
  const originalMessage = dialog.showMessageBox;
  dialog.showMessageBox = (async (...args: unknown[]) => ({ response: (args[1] as { title: string }).title === '确认删除' ? 1 : 0, checkboxChecked: false })) as typeof dialog.showMessageBox;
  try {
    window.setSize(1440, 960);
    await waitFor(window, "!document.querySelector('.add-page').disabled && document.querySelector('[data-paper]')");
    await window.webContents.executeJavaScript("document.querySelector('[data-add-text=horizontal]').click()");
    await waitFor(window, "document.querySelector('.text-dialog[open]')");
    await fill(window, 'text-content', '第一行中文：春风又绿江南岸。\n第二行 ABC 123，标点！？\n第三行缩放后保持换行。');
    await capture(window, join(output, 'text-edit-dialog.png'));
    await window.webContents.executeJavaScript("document.querySelector('.text-dialog button[type=submit]').click()");
    await waitFor(window, "!document.querySelector('.text-dialog') && !document.querySelector('.add-page').disabled && document.querySelector('.page-unsaved-marker')");
    horizontalId = (await state()).canvas!.document.objects.at(-1)!.id;
    console.log('文字验收：表单创建通过，开始字形缩放检查。');
    await select(window, horizontalId, 4);
    assert.equal(await window.webContents.executeJavaScript("document.querySelector('[data-resize-handle=n]')"), null);
    await window.webContents.executeJavaScript("document.querySelector('[data-fit-page]').click()");
    const firstGlyph = async (): Promise<{ width: number; height: number; lines: number }> => window.webContents.executeJavaScript(`(() => {
      const flow = [...document.querySelectorAll('[data-object-id]')].find(item => item.dataset.objectId === ${JSON.stringify(horizontalId)}).querySelector('.text-flow');
      const range = document.createRange(); range.setStart(flow.firstChild,0); range.setEnd(flow.firstChild,1); const r = range.getBoundingClientRect();
      range.selectNodeContents(flow); return {width:r.width,height:r.height,lines:range.getClientRects().length};
    })()`);
    const beforeGlyph = await firstGlyph(); const beforeScale = await object(horizontalId) as TextObject;
    const point = await window.webContents.executeJavaScript(`(() => { const r = document.querySelector('[data-resize-handle=se]').getBoundingClientRect(); return {x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)}; })()`);
    window.webContents.sendInputEvent({ type: 'mouseDown', ...point, button: 'left', clickCount: 1 });
    window.webContents.sendInputEvent({ type: 'mouseMove', x: point.x + 30, y: point.y + 15, modifiers: ['leftbuttondown'] });
    window.webContents.sendInputEvent({ type: 'mouseUp', x: point.x + 30, y: point.y + 15, button: 'left', clickCount: 1 });
    await waitFor(window, "document.querySelector('[data-resizing]').dataset.resizing === 'false' && !document.querySelector('.add-page').disabled");
    const afterScale = await object(horizontalId) as TextObject; const afterGlyph = await firstGlyph();
    const factor = afterScale.widthMm / beforeScale.widthMm; assert(factor > 1);
    assert(Math.abs(afterScale.heightMm / beforeScale.heightMm - factor) < 1e-8);
    assert.equal(afterScale.layoutWidthMm, beforeScale.layoutWidthMm); assert.equal(afterScale.fontSizePt, beforeScale.fontSizePt);
    assert(Math.abs(afterGlyph.height / beforeGlyph.height - factor) < .02); assert.equal(afterGlyph.lines, beforeGlyph.lines);
    console.log('文字验收：字形缩放及换行保持通过，开始旋转。');
    await window.webContents.executeJavaScript('window.desktop.savePage()');
    await waitFor(window, "!document.querySelector('.page-unsaved-marker')");
    for (const id of [horizontalId, (await state()).canvas!.document.objects.find(item => item.kind === 'image')!.id]) {
      const before = await object(id); await select(window, id, before.kind === 'text' ? 4 : 8);
      const turn = before.kind === 'text' ? 36.5 : -65;
      await rotate(window, turn);
      const after = await object(id);
      const difference = normalizeAngle(after.rotation - before.rotation - turn); assert(Math.min(difference, 360 - difference) < 1);
      assert.equal(after.widthMm, before.widthMm); assert.equal(after.heightMm, before.heightMm);
      assert.equal(after.xMm, before.xMm); assert.equal(after.yMm, before.yMm); assert.equal(after.zIndex, before.zIndex);
      await window.webContents.executeJavaScript('window.desktop.savePage()');
      const beforeCancel = await object(id); await rotate(window, -27, true); assert.deepEqual(await object(id), beforeCancel);
      // 自由旋转后仍沿对象自身边缘缩放，验证文字等比及图片单轴，不用外接框代替对象尺寸。
      const handle = before.kind === 'text' ? 'se' : 'e';
      const resizePoint = await window.webContents.executeJavaScript(`(() => { const r=document.querySelector('[data-resize-handle=${handle}]').getBoundingClientRect(); return {x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)}; })()`);
      const resizeDelta = rotateVector(24, before.kind === 'text' ? 12 : 0, beforeCancel.rotation);
      window.webContents.sendInputEvent({ type: 'mouseDown', ...resizePoint, button: 'left', clickCount: 1 });
      window.webContents.sendInputEvent({ type: 'mouseMove', x: resizePoint.x + Math.round(resizeDelta.x), y: resizePoint.y + Math.round(resizeDelta.y), modifiers: ['leftbuttondown'] });
      window.webContents.sendInputEvent({ type: 'mouseUp', x: resizePoint.x + Math.round(resizeDelta.x), y: resizePoint.y + Math.round(resizeDelta.y), button: 'left', clickCount: 1 });
      await waitFor(window, "document.querySelector('[data-resizing]').dataset.resizing === 'false' && !document.querySelector('.add-page').disabled");
      const resized = await object(id); assert.equal(resized.rotation, beforeCancel.rotation); assert(resized.widthMm > beforeCancel.widthMm);
      if (before.kind === 'text') assert(Math.abs(resized.widthMm / resized.heightMm - beforeCancel.widthMm / beforeCancel.heightMm) < 1e-8);
      else assert.equal(resized.heightMm, beforeCancel.heightMm);
      await window.webContents.executeJavaScript('window.desktop.savePage()');
    }
    await select(window, verticalId, 4);
    console.log('文字验收：图片与文字旋转通过，开始竖排列序检查。');
    const verticalFlow = await window.webContents.executeJavaScript(`(() => {
      const flow = [...document.querySelectorAll('[data-object-id]')].find(item => item.dataset.objectId === ${JSON.stringify(verticalId)}).querySelector('.text-flow');
      const rect = index => { const r = document.createRange(); r.setStart(flow.firstChild,index); r.setEnd(flow.firstChild,index+1); return r.getBoundingClientRect(); };
      const a=rect(0), b=rect(1), c=rect(flow.textContent.indexOf(String.fromCharCode(10))+1);
      return {mode:getComputedStyle(flow).writingMode,down:b.top>a.top,left:c.left<a.left};
    })()`);
    assert.deepEqual(verticalFlow, { mode: 'vertical-rl', down: true, left: true });
    // 双击实际文字对象，确认可再次编辑且保存的是纯文本。
    await window.webContents.executeJavaScript(`(() => { const item=[...document.querySelectorAll('[data-object-id]')].find(item=>item.dataset.objectId===${JSON.stringify(horizontalId)}); item.dispatchEvent(new MouseEvent('dblclick',{bubbles:true})); })()`);
    await waitFor(window, "document.querySelector('.text-dialog[open]')");
    await fill(window, 'text-content', '再次编辑中文与 ABC 123\n<script>这里只是文字</script>');
    await window.webContents.executeJavaScript("document.querySelector('.text-dialog button[type=submit]').click()");
    await waitFor(window, "!document.querySelector('.text-dialog') && !document.querySelector('.add-page').disabled");
    assert((await object(horizontalId) as TextObject).text.includes('<script>'));
    assert.equal(await window.webContents.executeJavaScript("document.querySelectorAll('.text-flow script').length"), 0);
    await window.webContents.executeJavaScript('window.desktop.savePage()');
    // 实际拖动竖排文字入口，在落点创建，并确认删除文字不分配图片编号。
    const imageCounter = (await state()).canvas!.document.nextImageNumber;
    const dropPoint = await window.webContents.executeJavaScript(`(() => {
      const dataTransfer=new DataTransfer();
      document.querySelector('[data-add-text=vertical]').dispatchEvent(new DragEvent('dragstart',{dataTransfer,bubbles:true}));
      const paper=document.querySelector('[data-paper]'); const r=paper.getBoundingClientRect();
      const event=new DragEvent('drop',{dataTransfer,bubbles:true,cancelable:true,clientX:r.left+r.width*.3,clientY:r.top+r.height*.4});
      const expected={xMm:(event.clientX-r.left)*210/r.width,yMm:(event.clientY-r.top)*297/r.height};
      paper.dispatchEvent(event); return expected;
    })()`);
    await waitFor(window, "document.querySelector('.text-dialog[open]')"); await fill(window, 'text-content', '竖排拖入测试\n保留行列');
    await window.webContents.executeJavaScript("document.querySelector('.text-dialog button[type=submit]').click()");
    await waitFor(window, "!document.querySelector('.text-dialog') && !document.querySelector('.add-page').disabled");
    const dropped = (await state()).canvas!.document.objects.at(-1)! as TextObject;
    assert.equal(dropped.writingMode, 'vertical');
    assert(Math.abs(dropped.xMm + dropped.widthMm / 2 - dropPoint.xMm) < .1, JSON.stringify({ dropped, dropPoint }));
    assert(Math.abs(dropped.yMm + dropped.heightMm / 2 - dropPoint.yMm) < .1);
    assert.equal((await state()).canvas!.document.nextImageNumber, imageCounter);
    await window.webContents.executeJavaScript('window.desktop.savePage()');
    await window.webContents.executeJavaScript(`window.desktop.deletePageObject(${JSON.stringify(albumId)},${JSON.stringify(pageId)},${JSON.stringify(dropped.id)})`);
    const saved = (await state()).canvas!.document;
    const other = await window.webContents.executeJavaScript(`window.desktop.createPage(${JSON.stringify(albumId)}, '切页检查', 'portrait')`); assert.equal(other.status, 'success');
    await window.webContents.executeJavaScript(`window.desktop.selectPage(${JSON.stringify(albumId)}, ${JSON.stringify(pageId)})`);
    assert.deepEqual((await state()).canvas!.document, saved);
    // 设置可读的单页打印样例，复用真实渲染组件，验证文字、图片与任意角度同时存在。
    await window.webContents.executeJavaScript(`(async () => {
      await window.desktop.putPageText(${JSON.stringify(albumId)},${JSON.stringify(pageId)},${JSON.stringify(horizontalId)},${JSON.stringify({ ...base, text: '横排文字打印样例\n春风又绿江南岸，明月何时照我还。\nABC 123，中文标点：！？', columns: 1, widthMm: 150, heightMm: 60 })});
      await window.desktop.movePageObject(${JSON.stringify(albumId)},${JSON.stringify(pageId)},${JSON.stringify(horizontalId)},20,70);
      await window.desktop.rotatePageObject(${JSON.stringify(albumId)},${JSON.stringify(pageId)},${JSON.stringify(horizontalId)},0);
      await window.desktop.movePageObject(${JSON.stringify(albumId)},${JSON.stringify(pageId)},${JSON.stringify(verticalId)},130,160);
      await window.desktop.rotatePageObject(${JSON.stringify(albumId)},${JSON.stringify(pageId)},${JSON.stringify(verticalId)},12.5);
      const image=(await window.desktop.getAlbumState()).canvas.document.objects.find(item=>item.kind==='image');
      await window.desktop.resizePageObject(${JSON.stringify(albumId)},${JSON.stringify(pageId)},image.id,{xMm:20,yMm:20,widthMm:50,heightMm:25});
      await window.desktop.savePage();
    })()`);
    await select(window, verticalId, 4); await capture(window, join(output, 'text-rotation-desktop.png'));
    await printSample(window, join(output, 'text-print-sample.pdf'));
    window.setSize(1000, 680); await window.webContents.executeJavaScript('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
    await window.webContents.executeJavaScript("document.querySelector('[data-fit-page]').click()");
    await capture(window, join(output, 'text-rotation-compact.png'));
    assert(await window.webContents.executeJavaScript('document.documentElement.scrollWidth <= window.innerWidth'));
    await window.webContents.executeJavaScript(`window.desktop.deletePageObject(${JSON.stringify(albumId)},${JSON.stringify(pageId)},${JSON.stringify(horizontalId)})`);
    assert(!(await state()).canvas!.document.objects.some(item => item.id === horizontalId));
    assert.deepEqual(await readFile(join(moved, 'pages', '001', '001.png')), png);
  } finally { dialog.showMessageBox = originalMessage; }
  await writeFile(join(output, 'text-report.json'), JSON.stringify({ oldPageUpgradesOnlyOnSave: true, textDoesNotConsumeImageNumbers: true,
    proportionalTextOnly: true, glyphAndSpacingScaleWithoutReflow: true, horizontalAndVerticalText: true,
    realRotationForTextAndImage: true, rotationCenterAndDimensionsPreserved: true, escapeCancelsRotation: true, resizeAfterFreeRotation: true,
    dragVerticalTextIntoPage: true,
    textEditAndPlainTextSafety: true, saveReopenAndMovedAlbum: true, textDeletePreservesImage: true,
    textPrintSampleGenerated: true, compactLayout: true, nativeMouseManuallyVerified: false }, null, 2));
  console.log('文字验收通过：横竖文字、四角等比、图片与文字自由旋转、编辑保存及打印样例已验证。');
}
