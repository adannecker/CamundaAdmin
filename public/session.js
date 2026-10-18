(() => {
  const base = document.querySelector('meta[name="app-base"]')?.content || '';
  const csrf = document.querySelector('meta[name="app-csrf"]')?.content || '';
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
      if (notice) { notice.hidden = false; notice.textContent = 'Sitzung abgelaufen. Bitte erneut mit AAI anmelden.'; }
    }
    return response;
  };
  const area = document.createElement('div');
  area.id = 'session-notice'; area.className = 'read-only'; area.hidden = true;
  document.querySelector('aside')?.append(area);
  if (csrf) {
    const link = document.createElement('a'); link.href = base + '/auth/login'; link.textContent = 'Erneut anmelden'; area.append(link);
    const box = document.createElement('div'); box.className = 'read-only';
    const name = document.createElement('div'); name.textContent = 'AAI · Owner';
    const button = document.createElement('button'); button.type = 'button'; button.textContent = 'Abmelden';
    button.addEventListener('click', async () => {
      button.disabled = true;
      try { const response = await window.fetch('/auth/logout', { method: 'POST' }); if (!response.ok) throw Error(); location.assign((await response.json()).redirect); }
      catch { button.disabled = false; area.hidden = false; area.textContent = 'Abmelden fehlgeschlagen. Bitte Seite neu laden.'; }
    });
    box.append(name, button); document.querySelector('aside')?.append(box);
  }
})();
