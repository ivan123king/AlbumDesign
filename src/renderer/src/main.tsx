/** 文件用途：挂载 React，按本地查询参数选择编辑预览或独立打印视图。 */
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { PrintView } from './components/PagePreview';
import { AlbumPrintView } from './components/AlbumPrintView';
import './styles.css';

const root = document.getElementById('root');
if (!root) throw new Error('界面挂载节点不存在。');
const view = new URLSearchParams(location.search).get('view');
const printing = view === 'print' || view === 'album-print';
document.body.classList.toggle('print-view', printing);
createRoot(root).render(<StrictMode>{view === 'album-print' ? <AlbumPrintView /> : printing ? <PrintView /> : <App />}</StrictMode>);
