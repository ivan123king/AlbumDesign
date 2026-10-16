/** 文件用途：提供侧栏宽度拖动和键盘调整，限制宽度以保留中间画布空间。 */
import { useRef } from 'react';

interface Props {
  side: 'left' | 'right';
  width: number;
  onChange: (width: number) => void;
}

/** 拖动捕获只影响相邻面板，不读取或改变页面物理尺寸。 */
export function PanelDivider({ side, width, onChange }: Props): React.JSX.Element {
  const drag = useRef<{ x: number; width: number } | null>(null);
  const direction = side === 'left' ? 1 : -1;
  const update = (value: number): void => onChange(Math.max(180, Math.min(320, value)));
  return <div className="panel-divider" role="separator" tabIndex={0} aria-orientation="vertical"
    aria-label={side === 'left' ? '调整素材栏宽度' : '调整页面栏宽度'}
    aria-valuenow={width} aria-valuemin={180} aria-valuemax={320} data-divider={side}
    onPointerDown={event => {
      drag.current = { x: event.clientX, width };
      event.currentTarget.setPointerCapture(event.pointerId);
    }}
    onPointerMove={event => {
      if (drag.current) update(drag.current.width + (event.clientX - drag.current.x) * direction);
    }}
    onPointerUp={event => {
      drag.current = null;
      if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    }}
    onLostPointerCapture={() => { drag.current = null; }}
    onKeyDown={event => {
      if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
        event.preventDefault();
        update(width + (event.key === 'ArrowRight' ? 12 : -12) * direction);
      }
    }} />;
}
