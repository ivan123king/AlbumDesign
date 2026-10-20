/** 文件用途：编辑画布和 PDF 共用对象几何样式、原图与文字内容，避免打印排版偏离编辑。 */
import type { CSSProperties } from 'react';
import type { CanvasObject } from '../../../shared/canvas';
import { textBaseSize } from '../../../shared/canvas';
import { TextContent } from './TextContent';

/** 对象始终使用竖向基础毫米坐标，自身旋转与查看比例、横竖编辑视角无关。 */
export function pageObjectStyle(object: CanvasObject): CSSProperties {
  return { left: `${object.xMm}mm`, top: `${object.yMm}mm`, width: `${object.widthMm}mm`, height: `${object.heightMm}mm`,
    transform: `rotate(${object.rotation}deg)`, zIndex: object.zIndex + 1,
    '--text-scale': object.kind === 'text' ? object.widthMm / textBaseSize(object).widthMm : 1 } as CSSProperties;
}

/** 原图通过受限页面协议读取；导出不显示编辑溢出提示，解码失败由打印就绪检查拒绝。 */
export function ObjectContent({ object, albumId, pageId, editing = false, onImageError }: {
  object: CanvasObject; albumId: string; pageId: string; editing?: boolean; onImageError?: () => void;
}): React.JSX.Element {
  return object.kind === 'image'
    ? <img key={object.fileName} src={`album-page://image/${albumId}/${pageId}/${object.id}?v=${object.fileName}`} alt={object.sourceName} draggable={false} onError={onImageError} />
    : <TextContent object={object} showOverflow={editing} />;
}
