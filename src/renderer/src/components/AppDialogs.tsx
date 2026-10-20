/** 文件用途：统一绘制告警、未保存确认和关于弹框，提供模态焦点、取消及受限请求响应。 */
import { useEffect, useRef, useState } from 'react';
import type { AppDialogRequest, AppDialogResponse, AppDialogState, AppInfo } from '../../../shared/framework';

/** 单个请求采用独立组件，避免请求切换时继承上次的提交状态或错误。 */
function AppDialogView({ request, info }: { request: AppDialogRequest; info: AppInfo | null }): React.JSX.Element {
  const dialog = useRef<HTMLDialogElement>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const warning = request.kind === 'warning';
  const unsaved = request.kind === 'unsaved';
  const cancelResponse = unsaved ? 'cancel' : false;
  const version = `V${(info?.version ?? '1.0.0').replace(/\.0$/u, '')}`;

  useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    element?.querySelector<HTMLButtonElement>(warning ? '[data-app-dialog-cancel]' : '[data-app-dialog-confirm]')?.focus({ preventScroll: true });
    return () => { element?.close(); };
  }, [warning]);

  /** 主进程校验请求 ID 后才完成原操作；通信失败保留弹窗供取消或重试。 */
  async function respond(response: AppDialogResponse): Promise<void> {
    if (pending) return;
    setPending(true); setError('');
    try {
      if (!await window.desktop.respondAppDialog(request.id, response)) setError('此操作已结束，请关闭弹窗后重试。');
    } catch { setError('无法完成确认，请重试。'); }
    finally { setPending(false); }
  }

  return <dialog ref={dialog} className={`app-dialog ${warning ? 'app-dialog-warning' : unsaved ? 'app-dialog-unsaved' : 'app-dialog-about'}`}
    role={warning || unsaved ? 'alertdialog' : 'dialog'} aria-modal="true" aria-labelledby="app-dialog-title"
    aria-describedby={warning || unsaved ? 'app-dialog-description' : 'app-about-details'} data-app-dialog={request.kind}
    onCancel={event => { event.preventDefault(); void respond(cancelResponse); }}>
    <button type="button" className="app-dialog-close" aria-label="关闭弹窗" disabled={pending} onClick={() => { void respond(cancelResponse); }}>×</button>
    {warning ? <div className="app-dialog-content">
      <div className="app-dialog-heading">
        <span className="app-warning-icon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none">
          <path d="M10.3 4.5a2 2 0 0 1 3.4 0l7.5 13a2 2 0 0 1-1.7 3H4.5a2 2 0 0 1-1.7-3l7.5-13Z" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" />
          <path d="M12 9v4.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" /><circle cx="12" cy="17" r="1" fill="currentColor" />
        </svg></span>
        <div><span className="app-dialog-eyebrow">操作告警</span><h2 id="app-dialog-title">{request.title}</h2></div>
      </div>
      <div className="app-delete-target"><span>即将删除</span><strong title={request.subject}>{request.subject}</strong></div>
      <p id="app-dialog-description" className="app-dialog-description">{request.message}<br />请确认是否继续。</p>
      <p className="app-dialog-assurance"><span aria-hidden="true">✓</span>已有画布中的图片不受影响。</p>
    </div> : request.kind === 'unsaved' ? <div className="app-dialog-content">
      <div className="app-dialog-heading">
        <span className="app-warning-icon app-save-icon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none">
          <path d="M6 3.5h9l4 4V20H5V3.5h1Z" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
          <path d="M14 3.5V9h5M8 13h8M8 16.5h5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
        </svg></span>
        <div><span className="app-dialog-eyebrow">未保存修改</span><h2 id="app-dialog-title">{request.exportOnly ? '保存后导出 PDF？' : '保存画布修改？'}</h2></div>
      </div>
      <div className="app-delete-target"><span>当前画布</span><strong title={request.subject}>{request.subject}</strong></div>
      <p id="app-dialog-description" className="app-dialog-description">{request.exportOnly
        ? '此画布有尚未保存的更改。保存后将导出整本画册。'
        : '此画布有尚未保存的更改。保存后继续，也可以返回画布继续编辑。'}</p>
      {!request.exportOnly && <p className="app-unsaved-note">选择“放弃修改”会丢失本次未保存的更改。</p>}
    </div> : <div className="app-dialog-content">
      <div className="app-about-brand"><span className="app-about-mark" aria-hidden="true">册</span>
        <div><span className="app-dialog-eyebrow">关于软件</span><h2 id="app-dialog-title">画册工坊</h2>
          <span className="app-about-tagline">留住每一页记忆</span></div>
        <span className="app-about-version" aria-label={`软件版本 ${version}`}>{version}</span>
      </div>
      <dl className="app-about-details" id="app-about-details">
        <div><dt>软件名称</dt><dd>画册工坊</dd></div>
        <div><dt>作者</dt><dd>刘伟</dd></div>
        <div><dt>联系方式</dt><dd className="app-about-contact">lw18751836671@163.com</dd></div>
      </dl>
    </div>}
    {error && <p className="app-dialog-error" role="alert">{error}</p>}
    <div className="app-dialog-actions">
      {request.kind === 'unsaved' && !request.exportOnly && <button type="button" className="app-dialog-discard" disabled={pending} data-app-dialog-discard
        onClick={() => { void respond('discard'); }}>放弃修改</button>}
      {(warning || unsaved) && <button type="button" className="app-dialog-cancel" disabled={pending} data-app-dialog-cancel
        onClick={() => { void respond(cancelResponse); }}>取消</button>}
      <button type="button" className="app-dialog-confirm" disabled={pending} data-app-dialog-confirm
        onClick={() => { void respond(unsaved ? 'save' : true); }}>{pending ? '正在确认…' : request.kind === 'unsaved' ? request.exportOnly ? '保存并导出' : '保存' : '确定'}</button>
    </div>
  </dialog>;
}

/** 先订阅再查询，主进程版本号消除晚到快照；三类业务请求共用单个弹框位置。 */
export function AppDialogs({ info }: { info: AppInfo | null }): React.JSX.Element | null {
  const [state, setState] = useState<AppDialogState>({ revision: -1, request: null });
  useEffect(() => {
    let disposed = false;
    const receive = (value: AppDialogState): void => {
      if (!disposed) setState(previous => value.revision >= previous.revision ? value : previous);
    };
    const unsubscribe = window.desktop.onAppDialog(receive);
    void window.desktop.getAppDialog().then(receive);
    return () => { disposed = true; unsubscribe(); };
  }, []);
  return state.request ? <AppDialogView key={state.request.id} request={state.request} info={info} /> : null;
}
