import { canUseAIResearch, canUseChatgptPlan } from '../services/auth.js';

/** The browser sees safe provider status; API keys and login credentials stay on the backend. */
export function initChatgptAuth({ service, baseUrl, onChange = () => {}, documentImpl = document, windowImpl = window }) {
  const el = id => documentImpl.getElementById(id);
  const ui = {
    status: el('chatgpt-auth-state'), account: el('chatgpt-account'), login: el('chatgpt-login'),
    refresh: el('chatgpt-refresh'), test: el('chatgpt-test'), logout: el('chatgpt-logout'),
    feedback: el('chatgpt-feedback'), linkPanel: el('chatgpt-login-link-panel'), link: el('chatgpt-login-link'),
    title: el('chatgpt-title'), description: el('ai-provider-description'),
  };
  let status = null;
  let busy = null;
  let loginUrl = null;
  let attempt = 0;
  let statusRevision = 0;
  let pollTimer = null;
  let timeoutTimer = null;
  let disposed = false;

  function feedback(message = '', error = false) {
    ui.feedback.textContent = message; ui.feedback.hidden = !message; ui.feedback.classList.toggle('error', error);
  }
  function render() {
    const shared = status?.sharedReadOnly === true;
    const deepseek = status?.provider === 'deepseek';
    const chatgpt = status?.provider === 'chatgpt';
    const authorized = canUseAIResearch(status);
    ui.title.textContent = deepseek ? 'DeepSeek' : chatgpt ? 'ChatGPT' : 'AI 驱动';
    ui.description.textContent = deepseek ? '通过后端配置的 DeepSeek API 生成研究观点，无需登录。' : chatgpt ? '使用 ChatGPT 套餐授权生成研究观点。' : '正在读取后端的 AI 服务配置。';
    ui.status.textContent = shared ? '局域网只读' : !status ? '未取得连接状态' : deepseek ? authorized ? 'API 已配置' : !status.configured ? 'API Key 未配置' : '研究服务不可用' : authorized ? '已授权套餐用量' : status.authenticated ? '已登录，套餐授权未获得' : '未登录';
    ui.status.classList.toggle('authorized', authorized);
    ui.account.textContent = shared ? '' : deepseek ? status.model ? `模型 · ${status.model}` : '' : status?.account?.name || status?.account?.email || '';
    ui.account.hidden = !ui.account.textContent;
    ui.login.hidden = shared || !chatgpt || authorized;
    ui.login.disabled = shared || !chatgpt || Boolean(busy);
    ui.login.textContent = busy === 'login' ? '准备登录链接…' : loginUrl ? '重新准备登录链接' : status?.authenticated ? '重新授权 ChatGPT' : 'Continue with ChatGPT';
    ui.refresh.hidden = shared;
    ui.refresh.textContent = chatgpt ? '刷新登录状态' : '刷新连接状态';
    ui.refresh.disabled = shared || busy === 'test' || busy === 'logout';
    ui.test.hidden = shared || !authorized; ui.test.disabled = shared || Boolean(busy);
    ui.test.textContent = busy === 'test' ? '测试连接中…' : '测试连接';
    ui.logout.hidden = shared || !chatgpt || !status?.authenticated; ui.logout.disabled = shared || !chatgpt || Boolean(busy);
    if (!chatgpt) { ui.linkPanel.hidden = true; ui.link.removeAttribute('href'); }
    onChange(status, { busy });
  }
  function stopWaiting() {
    attempt += 1;
    windowImpl.clearTimeout(pollTimer); windowImpl.clearTimeout(timeoutTimer);
    pollTimer = null; timeoutTimer = null;
    if (busy === 'login') busy = null;
  }
  function clearLoginLink() {
    loginUrl = null; ui.linkPanel.hidden = true; ui.link.removeAttribute('href');
  }
  async function refreshStatus({ silent = false } = {}) {
    const revision = ++statusRevision;
    try {
      const next = await service.status();
      if (disposed || revision !== statusRevision) return status;
      status = next;
      if (status?.sharedReadOnly === true) {
        stopWaiting(); clearLoginLink(); feedback();
      } else if (status?.provider === 'deepseek') {
        stopWaiting(); clearLoginLink();
        if (status.error) feedback(status.error.message, true);
        else if (!status.configured) feedback('请在后端 .env 中配置 DEEPSEEK_API_KEY，然后重启后端并刷新连接状态。', true);
        else if (!canUseAIResearch(status)) feedback('DeepSeek 研究服务当前不可用，请检查后端配置并刷新连接状态。', true);
        else if (!silent) feedback('已读取 DeepSeek API 配置；请点击“测试连接”确认当前是否可用。');
        else feedback();
      } else if (canUseChatgptPlan(status)) {
        const wasWaitingForLogin = Boolean(loginUrl) || busy === 'login';
        stopWaiting(); clearLoginLink();
        if (status.error) feedback(status.error.message, true);
        else if (wasWaitingForLogin) feedback('登录授权完成。先点击“测试连接”，再尝试生成核心市场分歧。');
        else if (!silent) feedback('已读取本地套餐授权记录；这不验证网络连接。请点击“测试连接”确认当前是否可用。');
      } else if (status.error) feedback(status.error.message, true);
      else if (!silent && busy !== 'login') feedback(status.authenticated ? '这个账号尚未获得套餐调用权限，请重新授权或检查资格。' : '尚未登录 ChatGPT，点击登录按钮开始授权。');
      render(); return status;
    } catch (error) {
      if (disposed || revision !== statusRevision) return status;
      // Fail closed if the backend cannot confirm the current authorization.
      status = null; feedback(error.message, true); render(); return null;
    }
  }
  function pollLogin(currentAttempt) {
    pollTimer = windowImpl.setTimeout(async () => {
      if (disposed || currentAttempt !== attempt) return;
      await refreshStatus({ silent: true });
      if (disposed || currentAttempt !== attempt || canUseChatgptPlan(status)) return;
      pollLogin(currentAttempt);
    }, 5000);
  }
  async function login() {
    if (busy || status?.provider !== 'chatgpt' || status?.sharedReadOnly === true) return;
    stopWaiting(); clearLoginLink();
    busy = 'login'; const currentAttempt = attempt; feedback('正在准备 OpenAI 官方登录页面…'); render();
    try {
      const result = await service.start();
      if (disposed || currentAttempt !== attempt) return;
      loginUrl = result.url;
      // A real user-clicked link works in embedded browsers without manipulating an about:blank popup.
      ui.link.href = loginUrl; ui.linkPanel.hidden = false;
      busy = null;
      feedback('登录链接已准备好。点击下方链接，在 OpenAI 官方页面完成登录与套餐授权。'); render();
      pollLogin(currentAttempt);
      const expiry = Date.parse(result.expiresAt);
      const waitMs = Number.isFinite(expiry) ? Math.max(0, Math.min(10 * 60 * 1000, expiry - Date.now())) : 10 * 60 * 1000;
      timeoutTimer = windowImpl.setTimeout(() => {
        if (disposed || currentAttempt !== attempt) return;
        stopWaiting(); clearLoginLink(); feedback('登录链接已过期，请重新点击 Continue with ChatGPT。若已完成授权，可刷新登录状态。'); render();
      }, waitMs);
    } catch (error) {
      if (disposed || currentAttempt !== attempt) return;
      stopWaiting(); clearLoginLink(); feedback(error.message, true); render();
    }
  }
  async function testConnection() {
    if (busy || !canUseAIResearch(status)) return;
    const testingProvider = status.provider;
    const provider = status.provider === 'deepseek' ? 'DeepSeek' : 'ChatGPT';
    const stillCurrent = () => !disposed && status?.provider === testingProvider && status?.sharedReadOnly !== true;
    busy = 'test'; feedback(provider === 'DeepSeek' ? '正在使用少量 DeepSeek API 额度测试连接…' : '正在用少量 ChatGPT 套餐用量测试连接…'); render();
    try { const result = await service.test(); if (stillCurrent()) feedback(`${provider} 连接成功 · ${result.model}：${result.message}`); }
    catch (error) { if (stillCurrent()) { feedback(error.message, true); if (error.status === 401 || error.status === 403) await refreshStatus({ silent: true }); } }
    finally { busy = null; if (!disposed) render(); }
  }
  async function logout() {
    if (busy || status?.provider !== 'chatgpt' || status?.sharedReadOnly === true) return;
    busy = 'logout'; statusRevision += 1; render();
    try {
      await service.logout(); stopWaiting(); clearLoginLink();
      status = { provider: 'chatgpt', authenticated: false, planEnabled: false, expiresAt: null }; feedback('已退出本项目，其他应用的 ChatGPT 登录不受影响。');
    } catch (error) { feedback(error.message, true); }
    finally { busy = null; render(); }
  }
  const refreshClick = () => { void refreshStatus(); };
  const focus = () => { if (!disposed && busy !== 'test' && busy !== 'logout') void refreshStatus({ silent: true }); };
  const beforeUnload = () => stopWaiting();
  ui.login.addEventListener('click', login); ui.refresh.addEventListener('click', refreshClick);
  ui.test.addEventListener('click', testConnection); ui.logout.addEventListener('click', logout);
  windowImpl.addEventListener('focus', focus); windowImpl.addEventListener('pagehide', beforeUnload);
  render(); const ready = refreshStatus({ silent: true });
  return {
    ready, refresh: refreshStatus, get status() { return status; }, get busy() { return busy; },
    dispose() {
      disposed = true; statusRevision += 1; stopWaiting();
      ui.login.removeEventListener('click', login); ui.refresh.removeEventListener('click', refreshClick);
      ui.test.removeEventListener('click', testConnection); ui.logout.removeEventListener('click', logout);
      windowImpl.removeEventListener('focus', focus); windowImpl.removeEventListener('pagehide', beforeUnload);
    },
  };
}
