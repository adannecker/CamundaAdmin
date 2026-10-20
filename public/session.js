(() => {
  const base = document.querySelector('meta[name="app-base"]')?.content || '';
  let csrf = document.querySelector('meta[name="app-csrf"]')?.content || '';
  let expired = false, signedOut = false, loginWindow = null, loginAttempted = false, recoveryUntil = 0;
  async function checkSession() {
    if (signedOut || document.hidden) return;
    try {
      const response = await originalFetch(base + '/api/session', { signal: AbortSignal.timeout(10000) });
      if (response.status === 401) { if (!expired) requireLogin(); return; }
      if (!response.ok || !expired || !loginWindow) return;
      const session = await response.json();
      if (session.mode !== 'oidc' || !session.csrf) return;
      csrf = session.csrf; expired = false; loginAttempted = false;
      try { loginWindow.close(); } catch {} loginWindow = null;
      if (overlay.open) overlay.close();
      const notice = document.getElementById('session-notice');
      if (notice) { notice.hidden = false; notice.textContent = 'AAI-Anmeldung erneuert. Offene Eingaben bleiben erhalten. Bitte die gewünschte Aktion erneut ausführen.'; }
      window.dispatchEvent(new Event('session-restored'));
    } catch { /* Network failures do not prove session expiry. */ }
  }
  function openLogin() {
    if (typeof window.open !== 'function') return;
    try { loginWindow = window.open(base + '/auth/login', 'camundaadmin-relogin', 'width=680,height=780'); } catch {}
    recoveryUntil = Date.now() + 5 * 60000;
  }
  const overlay = document.createElement('dialog');
  overlay.id = 'session-dialog'; overlay.className = 'session-dialog';
  overlay.setAttribute('aria-labelledby', 'session-dialog-title'); overlay.setAttribute('aria-describedby', 'session-dialog-detail');
  const content = document.createElement('div'); content.className = 'dialog-content';
  const heading = document.createElement('h2'); heading.id = 'session-dialog-title'; heading.textContent = 'Erneut mit AAI anmelden';
  const detail = document.createElement('p'); detail.id = 'session-dialog-detail';
  const actions = document.createElement('div'); actions.className = 'dialog-actions';
  const login = document.createElement('a'); login.className = 'session-login'; login.href = base + '/auth/login'; login.textContent = 'Jetzt mit AAI anmelden';
  actions.append(login); content.append(heading, detail, actions); overlay.append(content); document.body.append(overlay);
  overlay.addEventListener('cancel', event => event.preventDefault());
  function requireLogin(message = 'Deine Sitzung ist abgelaufen oder wurde durch einen Neustart beendet. Bitte melde dich erneut an, um weiterzuarbeiten.') {
    expired = true; detail.textContent = message;
    if (!signedOut && !loginAttempted && !document.hidden) { loginAttempted = true; openLogin(); }
    window.dispatchEvent(new Event('session-expired'));
    if (!overlay.open) { overlay.showModal(); login.focus(); }
  }
  login.addEventListener('click', event => {
    if (typeof window.open !== 'function') return;
    openLogin();
    if (loginWindow) { event.preventDefault(); signedOut = false; loginAttempted = true; }
  });
  setInterval(() => { if (!expired) checkSession(); }, 60000);
  setInterval(() => { if (expired && loginWindow && Date.now() < recoveryUntil) checkSession(); }, 2000);
  window.addEventListener('focus', () => { if (!signedOut) checkSession(); });
  window.SessionState = { get expired() { return expired; } };
  const originalFetch = window.fetch.bind(window);
  window.fetch = async (input, init = {}) => {
    const original = new URL(typeof input === 'string' || input instanceof URL ? input : input.url, location.href);
    const local = original.origin === location.origin;
    let target = input;
    if (local && (original.pathname.startsWith('/api/') || original.pathname.startsWith('/auth/'))) {
      original.pathname = base + original.pathname;
      target = input instanceof Request ? new Request(original.href, input) : original.href;
    }
    const method = String(init.method || (input instanceof Request ? input.method : 'GET')).toUpperCase();
    const headers = new Headers(init.headers || (input instanceof Request ? input.headers : undefined));
    if (local && csrf && !['GET', 'HEAD', 'OPTIONS'].includes(method)) headers.set('x-csrf-token', csrf);
    const response = await originalFetch(target, { ...init, headers });
    if (local && response.status === 401) {
      const notice = document.getElementById('session-notice');
      if (notice) {
        notice.hidden = false;
        notice.replaceChildren(document.createTextNode('Sitzung abgelaufen. Daten können nicht geladen werden. '));
        const login = document.createElement('a');
        login.href = base + '/auth/login'; login.textContent = 'Erneut mit AAI anmelden';
        notice.append(login);
      }
      requireLogin();
    }
    return response;
  };
  const area = document.createElement('div');
  area.id = 'session-notice'; area.className = 'session-notice'; area.hidden = true; area.setAttribute('role', 'alert');
  document.querySelector('main')?.prepend(area);
  if (csrf) {
    const box = document.createElement('div'); box.className = 'read-only';
    const name = document.createElement('div'); name.textContent = 'AAI · Owner';
    const button = document.createElement('button'); button.type = 'button'; button.textContent = 'Abmelden';
    button.addEventListener('click', async () => {
      button.disabled = true;
      try { const response = await window.fetch('/auth/logout', { method: 'POST' }); if (!response.ok) throw Error(); signedOut = true; if (loginWindow) { try { loginWindow.close(); } catch {} loginWindow = null; } requireLogin('Du bist abgemeldet. Melde dich erneut mit AAI an, um Camunda Admin weiterzuverwenden.'); }
      catch { button.disabled = false; area.hidden = false; area.textContent = 'Abmelden fehlgeschlagen. Bitte Seite neu laden.'; }
    });
    box.append(name, button); document.querySelector('aside')?.append(box);
  }
})();
