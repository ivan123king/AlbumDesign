/** 文件用途：在既有临时验收画册中验证八点缩放、底层对象选择及尺寸表单的真实交互。 */
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { BrowserWindow } from 'electron';
import type { AlbumState } from '../shared/album';
import type { ImageObject, ResizeHandle } from '../shared/canvas';
import { resizeHandles, rotateVector } from '../shared/canvas';

/** 等待界面状态及绘制提交，不依赖文件复制速度。 */
async function waitFor(window: BrowserWindow, expression: string): Promise<void> {
  await window.webContents.executeJavaScript(`(async () => {
    for (let i = 0; !(${expression}); i++) {
      if (i > 300) throw new Error('缩放验收超时：' + ${JSON.stringify(expression)});
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  })()`);
}

/** 截图前等待隐藏窗口合成器完成，用于人工查看选框及表单。 */
async function capture(window: BrowserWindow, file: string): Promise<void> {
  await window.webContents.executeJavaScript('new Promise(resolve => setTimeout(() => requestAnimationFrame(() => requestAnimationFrame(resolve)), 150))');
  await writeFile(file, (await window.webContents.capturePage()).toPNG());
}

/** 读取控制框的实际屏幕矩形，独立核对固定锚点及显示尺寸。 */
async function bounds(window: BrowserWindow): Promise<{ x: number; y: number; width: number; height: number }> {
  return window.webContents.executeJavaScript(`(() => {
    const r = document.querySelector('[data-selection-for]').getBoundingClientRect();
    return {x:r.left,y:r.top,width:r.width,height:r.height};
  })()`);
}

/** 从右侧行发出真实右键事件并打开尺寸对话框，验证右击会先选中对应对象。 */
async function openSizeDialog(window: BrowserWindow, objectId: string): Promise<void> {
  const point = await window.webContents.executeJavaScript(`(() => {
    const button = [...document.querySelectorAll('[data-object-button]')].find(item => item.dataset.objectButton === ${JSON.stringify(objectId)});
    button.scrollIntoView({block:'nearest'});
    const r = button.getBoundingClientRect(); return {x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)};
  })()`);
  window.webContents.sendInputEvent({ type: 'mouseDown', x: point.x, y: point.y, button: 'right', clickCount: 1 });
  window.webContents.sendInputEvent({ type: 'mouseUp', x: point.x, y: point.y, button: 'right', clickCount: 1 });
  await waitFor(window, "document.querySelector('.image-context-menu [role=menuitem]')");
  // 菜单可以增加改名等入口，按动作名称定位尺寸项，不依赖第一项的位置。
  await window.webContents.executeJavaScript("[...document.querySelectorAll('.image-context-menu [role=menuitem]')].find(item => item.textContent === '调整图片大小').click()");
  await waitFor(window, "document.querySelector('.image-size-dialog[open]')");
}

/** 经 React 原生输入事件填值，真实提交表单和 preload，未替换尺寸业务接口。 */
async function fill(window: BrowserWindow, id: string, value: string): Promise<void> {
  await window.webContents.executeJavaScript(`(() => {
    const input = document.getElementById(${JSON.stringify(id)});
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, ${JSON.stringify(value)});
    input.dispatchEvent(new Event('input', {bubbles:true}));
  })()`);
  await waitFor(window, `document.getElementById(${JSON.stringify(id)}).value === ${JSON.stringify(value)}`);
}

/** 四角/四边均使用真实 Chromium 指针，不按 Ctrl；可中途 Escape 取消。 */
async function dragHandle(window: BrowserWindow, handle: ResizeHandle, dx: number, dy: number, cancel = false): Promise<void> {
  const point = await window.webContents.executeJavaScript(`(() => {
    const handle = document.querySelector('[data-resize-handle=${handle}]');
    const r = handle.getBoundingClientRect(); return {x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)};
  })()`);
  window.webContents.sendInputEvent({ type: 'mouseDown', x: point.x, y: point.y, button: 'left', clickCount: 1 });
  await waitFor(window, "document.querySelector('[data-resizing]').dataset.resizing === 'true'");
  window.webContents.sendInputEvent({ type: 'mouseMove', x: point.x + dx, y: point.y + dy, modifiers: ['leftbuttondown'] });
  if (cancel) {
    window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
    window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' });
  }
  window.webContents.sendInputEvent({ type: 'mouseUp', x: point.x + dx, y: point.y + dy, button: 'left', clickCount: 1 });
  await waitFor(window, "document.querySelector('[data-resizing]').dataset.resizing === 'false' && !document.querySelector('.add-page').disabled");
}

/** 使用上游新建的临时画册；只改变当前验收页，结束时仍保留原图片供既有删除验收。 */
export async function runResizeSmoke(window: BrowserWindow, output: string, albumRoot: string): Promise<void> {
  console.log('缩放验收：开始八点指针检查。');
  const state = async (): Promise<AlbumState> => window.webContents.executeJavaScript('window.desktop.getAlbumState()');
  const start = await state();
  const albumId = start.album!.id; const pageId = start.canvas!.pageId; const original = start.canvas!.document.objects[0]! as ImageObject;
  const id = original.id;
  const current = async (): Promise<ImageObject> => (await state()).canvas!.document.objects.find((item): item is ImageObject => item.kind === 'image' && item.id === id)!;
  const directory = start.album!.pages.find(page => page.id === pageId)!.directoryName;
  const file = join(albumRoot, 'pages', directory, original.fileName);
  const originalBytes = await readFile(file);
  window.setSize(1440, 960);
  /** 通过实际业务接口复位测试矩形，保证每个控制点都在屏幕范围内。 */
  async function reset(orientation: 'portrait' | 'landscape'): Promise<void> {
    await window.webContents.executeJavaScript(`(async () => {
      await window.desktop.setPageOrientation(${JSON.stringify(albumId)}, ${JSON.stringify(pageId)}, ${JSON.stringify(orientation)});
      await window.desktop.resizePageImage(${JSON.stringify(albumId)}, ${JSON.stringify(pageId)}, ${JSON.stringify(id)}, {xMm:55,yMm:90,widthMm:80,heightMm:50});
      await window.desktop.savePage();
    })()`);
    await waitFor(window, "!document.querySelector('.add-page').disabled");
    await window.webContents.executeJavaScript("document.querySelector('[data-fit-page]').click(); document.querySelector('[data-object-button]').click()");
    await waitFor(window, "document.querySelectorAll('[data-resize-handle]').length === 8");
  }

  // 越界图片的焦点行为必须保持纸张内部坐标不变，数据未变不代表画面没有错位。
  for (const orientation of ['portrait', 'landscape'] as const) {
    const fixtureGeometry = orientation === 'portrait' ? { xMm: 120, yMm: 45, widthMm: 130, heightMm: 75 }
      : { xMm: 15, yMm: 200, widthMm: 180, heightMm: 100 };
    await window.webContents.executeJavaScript(`(async () => {
      await window.desktop.setPageOrientation(${JSON.stringify(albumId)}, ${JSON.stringify(pageId)}, ${JSON.stringify(orientation)});
      await window.desktop.resizePageImage(${JSON.stringify(albumId)}, ${JSON.stringify(pageId)}, ${JSON.stringify(id)}, ${JSON.stringify(fixtureGeometry)});
      await window.desktop.savePage();
    })()`);
    // 横版新图片自身为 90°，复现整页 -90° 与对象 +90° 叠加后的焦点滚动。
    const fixtureFile = join(albumRoot, 'pages', directory, 'canvas.json');
    const fixture = JSON.parse(await readFile(fixtureFile, 'utf8'));
    fixture.objects[0].rotation = orientation === 'portrait' ? 0 : 90;
    await writeFile(fixtureFile, JSON.stringify(fixture, null, 2) + '\n');
    await window.webContents.executeJavaScript(`window.desktop.selectPage(${JSON.stringify(albumId)}, ${JSON.stringify(pageId)})`);
    await waitFor(window, "!document.querySelector('.add-page').disabled");
    await window.webContents.executeJavaScript(`(() => {
      document.querySelector('[data-fit-page]').click();
      const row = [...document.querySelectorAll('[data-page-button]')].find(item => item.dataset.pageButton === ${JSON.stringify(pageId)});
      row.focus({preventScroll:true}); row.click();
      const paper = document.querySelector('[data-paper]'); paper.scrollLeft = 0; paper.scrollTop = 0;
    })()`);
    await waitFor(window, "!document.querySelector('[data-selection-for]')");
    const unchanged = (await state()).canvas!.document;
    const measure = async (): Promise<{ x: number; y: number; width: number; height: number; scrollX: number; scrollY: number }> =>
      window.webContents.executeJavaScript(`(() => {
        const paper = document.querySelector('[data-paper]'); const p = paper.getBoundingClientRect();
        const image = document.querySelector('[data-object-id]'); const r = image.getBoundingClientRect();
        return {x:r.left-p.left,y:r.top-p.top,width:r.width,height:r.height,scrollX:paper.scrollLeft,scrollY:paper.scrollTop};
      })()`);
    const before = await measure();
    if (orientation === 'portrait') await capture(window, join(output, 'selection-before.png'));
    const point = await window.webContents.executeJavaScript(`(() => {
      const p = document.querySelector('[data-paper]').getBoundingClientRect();
      const r = document.querySelector('[data-object-id]').getBoundingClientRect();
      return {x:Math.round((Math.max(p.left,r.left)+Math.min(p.right,r.right))/2),
        y:Math.round((Math.max(p.top,r.top)+Math.min(p.bottom,r.bottom))/2)};
    })()`);
    window.webContents.sendInputEvent({ type: 'mouseDown', x: point.x, y: point.y, button: 'left', clickCount: 1 });
    window.webContents.sendInputEvent({ type: 'mouseUp', x: point.x, y: point.y, button: 'left', clickCount: 1 });
    await waitFor(window, "document.querySelectorAll('[data-resize-handle]').length === 8 && !document.querySelector('.add-page').disabled");
    const after = await measure();
    if (orientation === 'portrait') await capture(window, join(output, 'selection-after.png'));
    assert(Math.abs(before.x - after.x) < 0.1 && Math.abs(before.y - after.y) < 0.1,
      `单击选中导致图像相对纸张位移：${JSON.stringify({ orientation, before, after })}`);
    assert.deepEqual((await state()).canvas!.document, unchanged); assert(!(await state()).canvas!.dirty);
    assert.equal(after.scrollX, 0); assert.equal(after.scrollY, 0);
    // 侧栏选中和键盘焦点同样不应改变纸张的内部滚动或图片显示位置。
    await window.webContents.executeJavaScript(`(() => {
      const row = document.querySelector('[data-object-button]'); row.focus({preventScroll:true}); row.click();
      document.querySelector('[data-object-id]').focus();
    })()`);
    await waitFor(window, "document.querySelectorAll('[data-resize-handle]').length === 8");
    const focused = await measure();
    assert(Math.abs(focused.x - before.x) < 0.1 && Math.abs(focused.y - before.y) < 0.1);
    const aligned = await window.webContents.executeJavaScript(`(() => {
      const a = document.querySelector('[data-object-id]').getBoundingClientRect();
      const b = document.querySelector('[data-selection-for]').getBoundingClientRect();
      return Math.abs(a.left-b.left) < .1 && Math.abs(a.top-b.top) < .1 && Math.abs(a.width-b.width) < .1 && Math.abs(a.height-b.height) < .1;
    })()`); assert(aligned, '选框与实际图片边界不一致');
  }
  const restored = (await state()).canvas!.document;
  restored.objects[0]!.rotation = original.rotation;
  await writeFile(join(albumRoot, 'pages', directory, 'canvas.json'), JSON.stringify(restored, null, 2) + '\n');
  await window.webContents.executeJavaScript(`window.desktop.selectPage(${JSON.stringify(albumId)}, ${JSON.stringify(pageId)})`);
  console.log('选中验收：越界图片单击、侧栏选中及键盘焦点不改变显示位置。');

  const handleSizes: number[] = [];
  for (const orientation of ['portrait', 'landscape'] as const) {
    await reset(orientation);
    for (const handle of resizeHandles) {
      const before = await current();
      const sx = handle.includes('e') ? 1 : handle.includes('w') ? -1 : 0;
      const sy = handle.includes('s') ? 1 : handle.includes('n') ? -1 : 0;
      const delta = rotateVector(sx * 18, sy * 12, before.rotation - (orientation === 'landscape' ? 90 : 0));
      await dragHandle(window, handle, Math.round(delta.x), Math.round(delta.y));
      const after = await current();
      if (sx && sy) assert(Math.abs(after.widthMm / after.heightMm - before.widthMm / before.heightMm) < 1e-9, handle);
      else {
        if (sx) assert(Math.abs(after.heightMm - before.heightMm) < 0.01, handle);
        if (sy) assert(Math.abs(after.widthMm - before.widthMm) < 0.01, handle);
      }
      const oldAnchor = rotateVector(-sx * before.widthMm / 2, -sy * before.heightMm / 2, before.rotation);
      const nextAnchor = rotateVector(-sx * after.widthMm / 2, -sy * after.heightMm / 2, after.rotation);
      assert(Math.abs(before.xMm + before.widthMm / 2 + oldAnchor.x - after.xMm - after.widthMm / 2 - nextAnchor.x) < .01, handle);
      assert(Math.abs(before.yMm + before.heightMm / 2 + oldAnchor.y - after.yMm - after.heightMm / 2 - nextAnchor.y) < .01, handle);
      assert.equal(after.rotation, before.rotation); assert.equal(after.zIndex, before.zIndex); assert.equal(after.fileName, before.fileName);
      assert((await state()).canvas!.dirty);
    }
    console.log(`缩放验收：${orientation} 八个控制点通过。`);
    handleSizes.push(await window.webContents.executeJavaScript("document.querySelector('[data-resize-handle=e]').getBoundingClientRect().width"));
  }
  assert(handleSizes.every(size => Math.abs(size - 12) < 0.1));
  await reset('landscape');
  await capture(window, join(output, 'resize-eight-handles.png'));
  const beforeCancel = (await state()).canvas!.document;
  const beforeCancelBounds = await bounds(window);
  await dragHandle(window, 'se', 35, 20, true);
  assert.deepEqual((await state()).canvas!.document, beforeCancel);
  const canceledBounds = await bounds(window); assert(Math.abs(canceledBounds.width - beforeCancelBounds.width) < 0.1);
  await dragHandle(window, 'e', 0, 350);
  assert(Math.abs((await current()).widthMm - 1) < 0.02);

  await reset('landscape');
  await window.webContents.executeJavaScript(`window.desktop.addPageImage(${JSON.stringify(albumId)}, ${JSON.stringify(pageId)}, '方向照片.jpg')`);
  await waitFor(window, "document.querySelectorAll('[data-object-id]').length === 2 && !document.querySelector('.add-page').disabled");
  const covering = (await state()).canvas!.document.objects.find(item => item.id !== id)!;
  // 右击底层图片名称会选中对应图，控制点在覆盖图片上方，叠层顺序不变。
  await openSizeDialog(window, id);
  assert.equal(await window.webContents.executeJavaScript("document.querySelector('[data-selection-for]').dataset.selectionFor"), id);
  assert.equal(await window.webContents.executeJavaScript("document.querySelector('#image-proportional').checked"), true);
  assert.equal(await window.webContents.executeJavaScript("document.querySelector('#image-width').readOnly"), true);
  await window.webContents.executeJavaScript("document.querySelector('#image-proportional').click()");
  assert.equal(await window.webContents.executeJavaScript("document.querySelector('#image-width').readOnly"), false);
  const beforeSize = await current();
  await fill(window, 'image-length', '70'); await fill(window, 'image-width', '40');
  await window.webContents.executeJavaScript("document.querySelector('.image-size-dialog button[type=submit]').click()");
  await waitFor(window, "!document.querySelector('.image-size-dialog') && !document.querySelector('.add-page').disabled");
  const free = await current(); assert.equal(free.widthMm, 70); assert.equal(free.heightMm, 40);
  assert(Math.abs(free.xMm + free.widthMm / 2 - beforeSize.xMm - beforeSize.widthMm / 2) < 1e-8);
  assert(Math.abs(free.yMm + free.heightMm / 2 - beforeSize.yMm - beforeSize.heightMm / 2) < 1e-8);
  assert.equal(free.zIndex, original.zIndex);
  assert.equal(await window.webContents.executeJavaScript("getComputedStyle(document.querySelector('.canvas-picture img')).objectFit"), 'fill');
  const topHit = await window.webContents.executeJavaScript(`(() => {
    const r = document.querySelector('[data-resize-handle=e]').getBoundingClientRect();
    return document.elementFromPoint(r.left+r.width/2, r.top+r.height/2).dataset.resizeHandle;
  })()`); assert.equal(topHit, 'e');
  await capture(window, join(output, 'resize-covered-selection.png'));
  await openSizeDialog(window, id);
  assert.equal(await window.webContents.executeJavaScript("document.querySelector('#image-proportional').checked"), true);
  await fill(window, 'image-length', '140');
  assert.equal(await window.webContents.executeJavaScript("document.querySelector('#image-width').readOnly"), true);
  assert.equal(await window.webContents.executeJavaScript("Number(document.querySelector('#image-width').value)"), 80);
  await capture(window, join(output, 'resize-size-dialog.png'));
  await window.webContents.executeJavaScript("document.querySelector('.image-size-dialog button[type=submit]').click()");
  await waitFor(window, "!document.querySelector('.image-size-dialog') && !document.querySelector('.add-page').disabled");
  const proportional = await current(); assert.equal(proportional.widthMm, 140); assert.equal(proportional.heightMm, 80);
  await window.webContents.executeJavaScript('window.desktop.savePage()');
  const canvasFile = join(albumRoot, 'pages', directory, 'canvas.json');
  assert.deepEqual(JSON.parse(await readFile(canvasFile, 'utf8')).objects.find((item: ImageObject) => item.id === id), proportional);
  await openSizeDialog(window, id); await fill(window, 'image-length', '90');
  window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' }); window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' });
  await waitFor(window, "!document.querySelector('.image-size-dialog')");
  assert.deepEqual(await current(), proportional); assert(!(await state()).canvas!.dirty);
  const invalid = await window.webContents.executeJavaScript(`window.desktop.resizePageImage(${JSON.stringify(albumId)}, ${JSON.stringify(pageId)}, ${JSON.stringify(id)}, {xMm:0,yMm:0,widthMm:0,heightMm:20})`);
  assert.equal(invalid.status, 'error'); assert.deepEqual(await current(), proportional);
  await window.webContents.executeJavaScript(`window.desktop.deletePageImage(${JSON.stringify(albumId)}, ${JSON.stringify(pageId)}, ${JSON.stringify(covering.id)})`);
  await window.webContents.executeJavaScript(`window.desktop.selectPage(${JSON.stringify(albumId)}, ${JSON.stringify(start.album!.pages.find(page => page.id !== pageId)!.id)})`);
  await window.webContents.executeJavaScript(`window.desktop.selectPage(${JSON.stringify(albumId)}, ${JSON.stringify(pageId)})`);
  assert.deepEqual(await current(), proportional); assert.deepEqual(await readFile(file), originalBytes);
  await writeFile(join(output, 'resize-report.json'), JSON.stringify({ eightHandlesAtTwoOrientations: true,
    cornersKeepRatioWithoutCtrl: true, edgesChangeSingleAxis: true, oppositeAnchorFixed: true,
    fixedScreenHandleSize: true, escapeRestoresPreview: true, minimumSize: true,
    selectCoveredObjectAndKeepLayer: true, realContextMenuAndSizeDialog: true,
    proportionalOnlyLengthEditable: true, proportionalCheckedByDefault: true, centerPreservedInSizeDialog: true,
    invalidSizeRejected: true, saveReopenAndOriginalBytes: true, clickAndFocusPreserveImagePosition: true,
    nativeMouseManuallyVerified: false }, null, 2));
  console.log('缩放验收通过：八点控制、右键尺寸、等比例复选框及保存重开已验证。');
}
