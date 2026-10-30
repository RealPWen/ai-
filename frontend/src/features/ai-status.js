const CONNECTION_STATUS_ERROR = '无法读取 AI 连接状态，请检查后端服务后重试。';
const errorMessage = error => typeof error?.message === 'string' && error.message ? error.message : CONNECTION_STATUS_ERROR;

/** Reads safe backend status without rendering controls or triggering inference. */
export function initAIStatus({ service, onChange = () => {}, windowImpl = window }) {
  let status = null;
  let revision = 0;
  let disposed = false;

  async function refresh() {
    if (disposed) return status;
    const requestRevision = ++revision;
    let next;
    try {
      next = await service.status();
    } catch (error) {
      if (disposed || requestRevision !== revision) return status;
      status = null;
      onChange(null, { busy: null, error: errorMessage(error) });
      return null;
    }
    if (disposed || requestRevision !== revision) return status;
    status = next;
    onChange(status, { busy: null, error: status?.error?.message || '' });
    return status;
  }

  const focus = () => refresh();
  windowImpl.addEventListener('focus', focus);
  onChange(null, { busy: null, error: '' });
  const ready = refresh();

  return {
    ready,
    refresh,
    get status() { return status; },
    get busy() { return null; },
    dispose() {
      if (disposed) return;
      disposed = true;
      revision += 1;
      windowImpl.removeEventListener('focus', focus);
    },
  };
}
