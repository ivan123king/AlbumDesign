/** 文件用途：仅用临时画册验收对象命名、图片/文字混合叠层、列表拖放、菜单边界和保存恢复。 */
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { dialog, nativeImage } from 'electron';
import type { BrowserWindow } from 'electron';
import { AlbumStore } from './album-store';
import { PageStore, parseCanvas } from './page-store';
import { getTextFonts } from './text-fonts';
import type { AlbumController } from './album-ipc';
import type { AlbumState } from '../shared/album';
import type { CanvasObject, TextDraft } from '../shared/canvas';
import { defaultObjectLabel, objectLabel } from '../shared/canvas';

/** 等待真实渲染完成，超时保留明确的失败条件。 */
async function waitFor(window: BrowserWindow, expression: string): Promise<void> {
  await window.webContents.executeJavaScript(`(async () => {
    for (let i = 0; !(${expression}); i++) {
      if (i > 250) throw new Error('图层验收等待超时：' + ${JSON.stringify(expression)});
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  })()`);
}

/** 截图保留实际画面与插入线，供视觉复核。 */
async function capture(window: BrowserWindow, output: string, name: string): Promise<void> {
  await window.webContents.executeJavaScript('new Promise(resolve => setTimeout(() => requestAnimationFrame(resolve), 100))');
  await writeFile(join(output, name), (await window.webContents.capturePage()).toPNG());
}

/** 模型比较忽略唯一允许变化的叠层，防止排序意外改变几何、文字或编号。 */
function withoutLayers(objects: CanvasObject[]): unknown {
  return objects.map(({ zIndex: _layer, ...rest }) => rest);
}

/** 创建独立测试工程；文件异常只注入此临时目录，原生确认在结束后恢复。 */
export async function runLayerSmoke(window: BrowserWindow, output: string, controller: AlbumController): Promise<void> {
  await mkdir(output, { recursive: true });
  const temporary = await mkdtemp(join(output, '图层验收-'));
  const root = join(temporary, '混合图层画册'); await mkdir(root);
  const albums = new AlbumStore(); const album = await albums.create(root);
  const pages = new PageStore(albums, async () => ({ width: 8, height: 6 }));
  const bitmap = Buffer.alloc(8 * 6 * 4);
  for (let i = 0; i < bitmap.length; i += 4) { bitmap[i] = 195; bitmap[i + 1] = 150; bitmap[i + 2] = 75; bitmap[i + 3] = 255; }
  const png = nativeImage.createFromBitmap(bitmap, { width: 8, height: 6 }).toPNG();
  await writeFile(join(root, 'assets', '背景照片.png'), png);
  await pages.create(album.id, '图片与文字叠放', 'portrait');
  const pageId = pages.snapshot()!.pageId;
  const file = join(root, 'pages', '001', 'canvas.json');
  // 版本 1 纯图片页面调整叠层不需要升级格式。
  const legacy = pages.snapshot()!.document; legacy.formatVersion = 1;
  await writeFile(file, JSON.stringify(legacy)); await pages.load(album.id, pageId);
  await pages.addImage(album.id, pageId, '背景照片.png'); await pages.addImage(album.id, pageId, '背景照片.png');
  const [imageA, imageB] = pages.snapshot()!.document.objects;
  pages.reorderObject(album.id, pageId, imageA!.id, 0);
  await pages.save(); await pages.load(album.id, pageId);
  assert.equal(pages.snapshot()!.document.formatVersion, 1);
  // 旧格式缺少名称可原样载入；改名仅增加可选字段，不升级格式或触碰图片副本。
  const legacyText = await readFile(file, 'utf8');
  const legacyObjects = pages.snapshot()!.document.objects;
  assert.equal(objectLabel(legacyObjects[0]!), '背景照片.png');
  pages.renameObject(album.id, pageId, imageA!.id, '  封面主图  ');
  assert.equal(await readFile(file, 'utf8'), legacyText);
  assert.equal(objectLabel(pages.snapshot()!.document.objects.find(item => item.id === imageA!.id)!), '封面主图');
  await pages.save(); await pages.load(album.id, pageId);
  assert.equal(pages.snapshot()!.document.formatVersion, 1);
  pages.renameObject(album.id, pageId, imageA!.id, '封面主图'); assert(!pages.dirty);
  pages.renameObject(album.id, pageId, imageA!.id, null); await pages.save();
  assert.deepEqual(pages.snapshot()!.document.objects, legacyObjects);
  const font = (await getTextFonts()).find(item => item.available); assert(font);
  const draft: TextDraft = { text: '图层叠放示例\n文字位于照片上方', writingMode: 'horizontal', fontFamily: font.family,
    fontSizePt: 32, color: '#ffffff', letterSpacingPt: 0, lineSpacing: 1.4, columns: 1, columnGapMm: 0, widthMm: 150, heightMm: 60 };
  const horizontal = await pages.putText(album.id, pageId, null, draft);
  const vertical = await pages.putText(album.id, pageId, null, { ...draft, text: '竖排文字', writingMode: 'vertical', widthMm: 30, heightMm: 80 });
  const order = (): string[] => pages.snapshot()!.document.objects.sort((a, b) => b.zIndex - a.zIndex).map(item => item.id);
  assert.deepEqual(order(), [vertical, horizontal, imageA!.id, imageB!.id]);
  const unchanged = pages.snapshot()!.document;
  pages.reorderObject(album.id, pageId, imageB!.id, 0);
  assert.deepEqual(order(), [imageB!.id, vertical, horizontal, imageA!.id]);
  pages.reorderObject(album.id, pageId, imageB!.id, 3);
  assert.deepEqual(order(), [vertical, horizontal, imageA!.id, imageB!.id]);
  assert.deepEqual(withoutLayers(pages.snapshot()!.document.objects), withoutLayers(unchanged.objects));
  assert.equal(pages.snapshot()!.document.nextImageNumber, unchanged.nextImageNumber);
  const beforeInvalid = pages.snapshot()!.document;
  for (const target of [-1, 4, .5, NaN]) assert.throws(() => pages.reorderObject(album.id, pageId, horizontal, target));
  assert.throws(() => pages.reorderObject(album.id, pageId, 'missing', 0));
  assert.throws(() => pages.reorderObject(album.id, 'other-page', horizontal, 0));
  assert.deepEqual(pages.snapshot()!.document, beforeInvalid);
  await pages.save();
  pages.reorderObject(album.id, pageId, imageB!.id, 0); assert(pages.dirty);
  pages.discard(); assert(!pages.dirty); assert.deepEqual(order(), [vertical, horizontal, imageA!.id, imageB!.id]);
  pages.reorderObject(album.id, pageId, horizontal, 0);
  const savedText = await readFile(file, 'utf8'); await writeFile(file, savedText + ' ');
  await assert.rejects(pages.save(), /外部修改/u); assert(pages.dirty);
  await writeFile(file, savedText); await pages.save(); await pages.load(album.id, pageId);
  assert.deepEqual(order(), [horizontal, vertical, imageA!.id, imageB!.id]);
  assert.deepEqual(await readFile(join(root, 'pages', '001', '001.png')), png);
  // 数据验收围绕名称持久化、正文更新及异常不部分修改，全部限定在本临时画册。
  const beforeNames = pages.snapshot()!.document;
  const beforeNamesText = await readFile(file, 'utf8');
  for (const id of [imageA!.id, horizontal, vertical]) pages.renameObject(album.id, pageId, id, '纪念照片与说明');
  assert(pages.dirty); assert.equal(await readFile(file, 'utf8'), beforeNamesText);
  const named = pages.snapshot()!.document;
  for (const invalid of ['', '  ', 'a'.repeat(121), '换\n行', '制\u0000符', '制\u007f符', 42, {}, undefined]) {
    assert.throws(() => pages.renameObject(album.id, pageId, horizontal, invalid as string));
    const broken = structuredClone(named); broken.objects[0]!.displayName = invalid as string;
    if (invalid !== undefined) assert.throws(() => parseCanvas(broken));
  }
  assert.throws(() => pages.renameObject(album.id, '失效页面', horizontal, '有效名称'));
  assert.throws(() => pages.renameObject('失效画册', pageId, horizontal, '有效名称'));
  assert.throws(() => pages.renameObject(album.id, pageId, '失效对象', '有效名称'));
  assert.deepEqual(pages.snapshot()!.document, named);
  const withoutNames = (objects: CanvasObject[]): unknown => objects.map(({ displayName: _name, ...rest }) => rest);
  assert.deepEqual(withoutNames(named.objects), withoutNames(beforeNames.objects));
  assert.equal(named.nextImageNumber, beforeNames.nextImageNumber);
  await pages.save(); await pages.load(album.id, pageId);
  for (const id of [imageA!.id, horizontal, vertical]) assert.equal(pages.snapshot()!.document.objects.find(item => item.id === id)!.displayName, '纪念照片与说明');
  await pages.putText(album.id, pageId, horizontal, { ...draft, text: '修改后的标题' });
  await pages.putText(album.id, pageId, vertical, { ...draft, text: '新的竖排说明', writingMode: 'vertical', widthMm: 30, heightMm: 80 });
  for (const id of [horizontal, vertical]) assert.equal(pages.snapshot()!.document.objects.find(item => item.id === id)!.displayName, '纪念照片与说明');
  pages.discard();
  pages.renameObject(album.id, pageId, horizontal, '临时名称'); pages.discard();
  assert.equal(objectLabel(pages.snapshot()!.document.objects.find(item => item.id === horizontal)!), '纪念照片与说明');
  for (const id of [imageA!.id, horizontal, vertical]) pages.renameObject(album.id, pageId, id, null);
  await pages.save(); await pages.load(album.id, pageId);
  assert.deepEqual(pages.snapshot()!.document, beforeNames);
  assert.equal(objectLabel(pages.snapshot()!.document.objects.find(item => item.id === vertical)!), defaultObjectLabel(beforeNames.objects.find(item => item.id === vertical)!));
  const loaded = await controller.loadSmokeAlbum(root); const albumId = loaded.id;
  const state = async (): Promise<AlbumState> => window.webContents.executeJavaScript('window.desktop.getAlbumState()');
  const uiOrder = async (): Promise<string[]> => window.webContents.executeJavaScript('[...document.querySelectorAll("[data-object-button]")].map(item => item.dataset.objectButton)');
  const idle = async (): Promise<void> => waitFor(window, "!document.querySelector('.add-page').disabled");
  const button = (id: string): string => `document.querySelector('[data-object-button="${id}"]')`;
  /** 用 Chromium 右键输入打开真实菜单，不绕过对象选择及菜单事件。 */
  const menu = async (id: string): Promise<void> => {
    const point = await window.webContents.executeJavaScript(`(() => { const el = ${button(id)}; el.scrollIntoView({block:'nearest'}); const r = el.getBoundingClientRect(); return {x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)}; })()`);
    window.webContents.sendInputEvent({ type: 'mouseDown', ...point, button: 'right', clickCount: 1 });
    window.webContents.sendInputEvent({ type: 'mouseUp', ...point, button: 'right', clickCount: 1 });
    await waitFor(window, 'document.querySelector("[data-layer-action]")');
  };
  const action = async (id: string, name: string): Promise<void> => {
    await menu(id);
    await window.webContents.executeJavaScript(`document.querySelector('[data-layer-action="${name}"]').click()`);
    await waitFor(window, "!document.querySelector('.image-context-menu') && !document.querySelector('.add-page').disabled");
  };
  /** DOM 拖放事件保留浏览器 DataTransfer、React 处理及真实 IPC，不替换排序业务。 */
  const startDrag = async (id: string): Promise<void> => {
    await window.webContents.executeJavaScript(`window.layerTransfer = new DataTransfer(); ${button(id)}.dispatchEvent(new DragEvent('dragstart', {bubbles:true,cancelable:true,dataTransfer:window.layerTransfer}))`);
    await waitFor(window, 'document.querySelector(".layer-dragging")');
  };
  const dragEvent = async (id: string, type: string, after: boolean): Promise<void> => {
    await window.webContents.executeJavaScript(`(() => { const el = ${button(id)}, r = el.getBoundingClientRect(); el.dispatchEvent(new DragEvent(${JSON.stringify(type)}, {bubbles:true,cancelable:true,dataTransfer:window.layerTransfer,clientX:r.left+10,clientY:r.top+r.height*${after ? .8 : .2}})); })()`);
  };
  const originalMessage = dialog.showMessageBox;
  let answer = 0;
  dialog.showMessageBox = (async () => ({ response: answer, checkboxChecked: false })) as typeof dialog.showMessageBox;
  try {
    window.setSize(1440, 960); await idle();
    assert.deepEqual(await uiOrder(), [horizontal, vertical, imageA!.id, imageB!.id]);
    const initialObjects = (await state()).canvas!.document.objects;
    await menu(horizontal);
    assert(await window.webContents.executeJavaScript("document.querySelector('[data-layer-action=up]').disabled && document.querySelector('[data-layer-action=top]').disabled"));
    await capture(window, output, 'layers-menu.png');
    await window.webContents.executeJavaScript("document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))");
    await capture(window, output, 'layers-text-top.png');
    await action(horizontal, 'down'); assert.deepEqual(await uiOrder(), [vertical, horizontal, imageA!.id, imageB!.id]);
    await action(horizontal, 'up'); assert.equal((await uiOrder())[0], horizontal);
    await action(horizontal, 'bottom'); assert.equal((await uiOrder()).at(-1), horizontal);
    await menu(horizontal);
    assert(await window.webContents.executeJavaScript("document.querySelector('[data-layer-action=down]').disabled && document.querySelector('[data-layer-action=bottom]').disabled"));
    await window.webContents.executeJavaScript("document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))");
    await action(imageB!.id, 'top'); assert.equal((await uiOrder())[0], imageB!.id);
    await capture(window, output, 'layers-image-top.png');
    // 在重叠中心用实际 DOM 命中验证顶层遮挡；选框层不参与命中。
    assert.equal(await window.webContents.executeJavaScript(`(() => { const r = document.querySelector('[data-object-id="${imageB!.id}"]').getBoundingClientRect(); return document.elementFromPoint(r.left+r.width/2,r.top+r.height/2)?.closest('[data-object-id]')?.dataset.objectId; })()`), imageB!.id);
    await startDrag(horizontal); await dragEvent(imageB!.id, 'dragover', false);
    await waitFor(window, 'document.querySelector(".layer-insert-before")');
    await capture(window, output, 'layers-insertion.png');
    await dragEvent(imageB!.id, 'drop', false); await idle();
    assert.equal((await uiOrder())[0], horizontal);
    assert.equal(await window.webContents.executeJavaScript(`document.querySelector('[data-object-button="${horizontal}"]').getAttribute('aria-pressed')`), 'true');
    await startDrag(horizontal); await dragEvent(imageA!.id, 'drop', true); await idle();
    assert.equal((await uiOrder()).at(-1), horizontal);
    const beforeCancel = (await state()).canvas!.document;
    await startDrag(horizontal); await dragEvent(imageB!.id, 'dragover', false);
    await window.webContents.executeJavaScript("document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))");
    await dragEvent(imageB!.id, 'drop', false); assert.deepEqual((await state()).canvas!.document, beforeCancel);
    await startDrag(horizontal); await dragEvent(horizontal, 'dragend', false);
    assert.deepEqual((await state()).canvas!.document, beforeCancel);
    // 无本地拖动来源的跨页/外部拖放应忽略。
    await dragEvent(imageB!.id, 'drop', false); assert.deepEqual((await state()).canvas!.document, beforeCancel);
    const uiObjects = (await state()).canvas!.document.objects;
    assert.deepEqual(withoutLayers(uiObjects), withoutLayers(initialObjects));
    assert.equal(new Set(uiObjects.map(item => item.zIndex)).size, uiObjects.length);
    assert((await state()).canvas!.dirty);
    for (const item of uiObjects) assert.equal(await window.webContents.executeJavaScript(`Number(getComputedStyle(document.querySelector('[data-object-id="${item.id}"]')).zIndex)`), item.zIndex + 1);
    await window.webContents.executeJavaScript('window.desktop.savePage()'); await idle();
    const savedOrder = await uiOrder();
    await action(horizontal, 'top');
    answer = 2;
    const canceled = await window.webContents.executeJavaScript(`window.desktop.selectPage(${JSON.stringify(albumId)},${JSON.stringify(pageId)})`);
    assert.equal(canceled.status, 'canceled'); assert((await state()).canvas!.dirty);
    answer = 1;
    await window.webContents.executeJavaScript(`window.desktop.selectPage(${JSON.stringify(albumId)},${JSON.stringify(pageId)})`); await idle();
    assert.deepEqual(await uiOrder(), savedOrder); assert(!(await state()).canvas!.dirty);
    await controller.loadSmokeAlbum(root); await idle(); assert.deepEqual(await uiOrder(), savedOrder);
    const currentAlbumId = (await state()).album!.id;
    await window.webContents.executeJavaScript(`window.desktop.setPageOrientation(${JSON.stringify(currentAlbumId)},${JSON.stringify(pageId)},'landscape')`); await idle();
    assert.deepEqual(await uiOrder(), savedOrder);
    await action(horizontal, 'top');
    window.setSize(1100, 760); await menu(horizontal);
    assert(await window.webContents.executeJavaScript("(() => {const r=document.querySelector('.image-context-menu').getBoundingClientRect();return r.top>=0 && r.bottom<=innerHeight;})()"));
    await capture(window, output, 'layers-compact.png');
    await window.webContents.executeJavaScript('window.desktop.savePage()'); await idle();
    assert(!(await state()).canvas!.dirty);
    // 通过真实右键、模态表单和 preload 验收命名，输入取消不改变选中对象或页面草稿。
    window.setSize(1440, 960);
    const namingBaseline = (await state()).canvas!.document;
    const namingAlbumId = (await state()).album!.id;
    const openName = async (id: string): Promise<void> => {
      await menu(id);
      await window.webContents.executeJavaScript("document.querySelector('[data-rename-object]').click()");
      await waitFor(window, 'document.querySelector(".object-name-dialog[open]")');
      assert(await window.webContents.executeJavaScript("(() => {const el=document.querySelector('#object-name');return document.activeElement===el && el.selectionStart===0 && el.selectionEnd===el.value.length;})()"));
    };
    const enterName = async (value: string): Promise<void> => {
      await window.webContents.insertText(value);
      await waitFor(window, `document.querySelector('#object-name').value === ${JSON.stringify(value)} && !document.querySelector('.object-name-dialog button[type=submit]').disabled`);
      window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Enter' });
      window.webContents.sendInputEvent({ type: 'char', keyCode: '\r' });
      window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Enter' });
      try {
        await waitFor(window, '!document.querySelector(".object-name-dialog") && !document.querySelector(".add-page").disabled');
      } catch (error) {
        await capture(window, output, 'object-name-failed.png');
        console.error(await window.webContents.executeJavaScript("({value:document.querySelector('#object-name')?.value,active:document.activeElement?.outerHTML,message:document.querySelector('.status-message')?.textContent})"));
        throw error;
      }
    };
    await openName(imageA!.id); await capture(window, output, 'object-name-dialog.png');
    window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
    window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' });
    await waitFor(window, '!document.querySelector(".object-name-dialog")');
    assert.deepEqual((await state()).canvas!.document, namingBaseline); assert(!(await state()).canvas!.dirty);
    const uiNames = [[imageA!.id, '封面主图'], [horizontal, '主标题'], [vertical, '拍摄说明']] as const;
    for (const [id, name] of uiNames) {
      await openName(id); await enterName(name);
      assert.equal(await window.webContents.executeJavaScript(`${button(id)}.querySelector('span:last-child').textContent`), name);
      assert.equal((await state()).canvas!.document.objects.find(item => item.id === id)!.displayName, name);
    }
    assert(await window.webContents.executeJavaScript(`${button(imageA!.id)}.title.includes('来源文件：背景照片.png')`));
    assert(await window.webContents.executeJavaScript("!!document.querySelector('.page-unsaved-marker')"));
    assert.deepEqual(withoutNames((await state()).canvas!.document.objects), withoutNames(namingBaseline.objects));
    await capture(window, output, 'object-names-list.png');
    await openName(horizontal);
    await window.webContents.executeJavaScript("document.querySelector('.object-name-dialog .dialog-actions button[type=button]').click()");
    await waitFor(window, '!document.querySelector(".object-name-dialog")');
    await window.webContents.executeJavaScript('window.desktop.savePage()'); await idle();
    await controller.loadSmokeAlbum(root); await idle();
    for (const [id, name] of uiNames) assert.equal(objectLabel((await state()).canvas!.document.objects.find(item => item.id === id)!), name);
    await openName(imageA!.id);
    await window.webContents.executeJavaScript("document.querySelector('.restore-object-name').click()");
    await waitFor(window, '!document.querySelector(".object-name-dialog") && !document.querySelector(".add-page").disabled');
    assert.equal(objectLabel((await state()).canvas!.document.objects.find(item => item.id === imageA!.id)!), '背景照片.png');
    answer = 1;
    const restoredAlbumId = (await state()).album!.id;
    await window.webContents.executeJavaScript(`window.desktop.selectPage(${JSON.stringify(restoredAlbumId)},${JSON.stringify(pageId)})`); await idle();
    assert.equal(objectLabel((await state()).canvas!.document.objects.find(item => item.id === imageA!.id)!), '封面主图');
    assert(!(await state()).canvas!.dirty);
    await openName(imageA!.id); await enterName('未保存的新名称');
    answer = 2;
    const cancelNameSwitch = await window.webContents.executeJavaScript(`window.desktop.selectPage(${JSON.stringify(restoredAlbumId)},${JSON.stringify(pageId)})`);
    assert.equal(cancelNameSwitch.status, 'canceled'); assert((await state()).canvas!.dirty);
    // 外部修改导致保存失败时名称草稿保留；恢复测试文件后可重试保存。
    const namedFile = await readFile(file, 'utf8'); await writeFile(file, namedFile + ' ');
    const failedSave = await window.webContents.executeJavaScript('window.desktop.savePage()');
    assert.equal(failedSave.status, 'error'); assert((await state()).canvas!.dirty);
    await writeFile(file, namedFile); await window.webContents.executeJavaScript('window.desktop.savePage()'); await idle();
    // 已失效会话通过 IPC 拒绝，不改动当前页。
    const beforeStale = (await state()).canvas!.document;
    const staleName = await window.webContents.executeJavaScript(`window.desktop.renamePageObject(${JSON.stringify(namingAlbumId)},${JSON.stringify(pageId)},${JSON.stringify(horizontal)},'误改')`);
    assert.equal(staleName.status, 'error'); assert.deepEqual((await state()).canvas!.document, beforeStale);
    await writeFile(join(output, 'layers-report.json'), JSON.stringify({ passed: true, temporary,
      checks: ['旧格式名称与叠层兼容', '图片与横竖文字命名及重名', '非法名称与失效目标拒绝', '正文编辑保留名称', '右键改名聚焦全选及回车确认', 'Esc和按钮取消', '恢复默认及名称保存重开放弃取消', '名称保存失败重试与失效会话', '图片与横竖文字共用顺序', '四种菜单及边界禁用', 'DOM拖放上下插入与取消', '真实遮挡命中与CSS叠层', '编号几何原图保持', '保存失败保留草稿', '保存重开及放弃取消', '横竖视角及小窗口菜单'],
      limitations: ['原生拖动鼠标手工验收未执行', '真实画册PDF尚未实现'] }, null, 2));
    console.log('图层专项验收通过：' + temporary);
  } finally { dialog.showMessageBox = originalMessage; }
}
