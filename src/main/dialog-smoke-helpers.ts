/** 文件用途：专项验收通过真实自定义弹框按钮回应未保存请求，不替换业务保存或放弃结果。 */
import type { BrowserWindow } from 'electron';
import type { UnsavedChoice } from '../shared/framework';

/** 先启动待确认操作，再等待真实模态框并点击指定按钮；超时不默认保存或放弃。 */
export async function answerUnsaved<T>(window: BrowserWindow, operation: () => Promise<T>, choice: UnsavedChoice): Promise<T> {
  const pending = operation();
  await window.webContents.executeJavaScript(`(async () => {
    for (let i = 0; !document.querySelector('[data-app-dialog=unsaved][open]'); i++) {
      if (i > 300) throw new Error('等待未保存提示超时');
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    const selector = ${JSON.stringify(choice === 'save' ? '[data-app-dialog-confirm]' : choice === 'discard' ? '[data-app-dialog-discard]' : '[data-app-dialog-cancel]')};
    const button = document.querySelector('[data-app-dialog=unsaved] ' + selector);
    if (!button) throw new Error('未保存提示缺少目标按钮');
    button.click();
  })()`);
  return pending;
}
