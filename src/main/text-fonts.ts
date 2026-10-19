/** 文件用途：异步检测首批中文字体文件，只提供有限字体选项，不暴露任意字体路径读取。 */
import { access } from 'node:fs/promises';
import { join } from 'node:path';
import type { TextFont } from '../shared/canvas';

const fonts = [
  { family: 'Microsoft YaHei', label: '微软雅黑', file: 'msyh.ttc' },
  { family: 'SimSun', label: '宋体', file: 'simsun.ttc' },
  { family: 'SimHei', label: '黑体', file: 'simhei.ttf' },
  { family: 'KaiTi', label: '楷体', file: 'simkai.ttf' },
  { family: 'FangSong', label: '仿宋', file: 'simfang.ttf' }
] as const;
export const textFontFamilies: readonly string[] = fonts.map(font => font.family);

/** 首批字体均为 Windows 系统字体；缺失时明确标记，不自动替换保存的字体。 */
export async function getTextFonts(): Promise<TextFont[]> {
  return Promise.all(fonts.map(async font => {
    const available = await access(join(process.env.WINDIR ?? 'C:\\Windows', 'Fonts', font.file)).then(() => true, () => false);
    return { family: font.family, label: font.label, available };
  }));
}
