const API = "http://localhost:8000";

async function apiHeaders(extra = {}) {
  const d = await chrome.storage.local.get("geminiApiKey");
  const headers = { "Content-Type": "application/json", ...extra };
  if (d.geminiApiKey) headers["X-Gemini-Key"] = d.geminiApiKey;
  return headers;
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {

  // Хранилище (content scripts не могут обращаться к storage.session напрямую)
  if (message.action === "save_progress") {
    chrome.storage.session.set({ screeningProgress: message.data });
    sendResponse({ ok: true });
    return true;
  }

  if (message.action === "is_cancelled") {
    chrome.storage.session.get("cancelScreening", d => {
      sendResponse({ cancelled: !!d.cancelScreening });
    });
    return true;
  }

  if (message.action === "get_selected_vacancy") {
    chrome.storage.session.get("selectedVacancyId", d => {
      sendResponse({ vacancyId: d.selectedVacancyId || null });
    });
    return true;
  }

  if (message.action === "reset_cancel") {
    chrome.storage.session.set({ cancelScreening: false });
    sendResponse({ ok: true });
    return true;
  }



  if (message.action === "api_get") {
    apiHeaders().then(headers =>
      fetch(`${API}${message.path}`, { headers })
        .then(async res => {
          const data = await res.json().catch(() => ({}));
          sendResponse({ ok: res.ok, status: res.status, data });
        })
        .catch(err => sendResponse({ ok: false, error: err.message }))
    );
    return true;
  }

  if (message.action === "api_post") {
    apiHeaders().then(headers =>
      fetch(`${API}${message.path}`, {
        method: "POST",
        headers,
        body: JSON.stringify(message.body),
      })
        .then(async res => {
          const data = await res.json().catch(() => ({}));
          sendResponse({ ok: res.ok, status: res.status, data });
        })
        .catch(err => sendResponse({ ok: false, error: err.message }))
    );
    return true;
  }

  if (message.action === "api_patch") {
    apiHeaders().then(headers =>
      fetch(`${API}${message.path}`, {
        method: "PATCH",
        headers,
        body: JSON.stringify(message.body),
      })
        .then(async res => {
          const data = await res.json().catch(() => ({}));
          sendResponse({ ok: res.ok, status: res.status, data });
        })
        .catch(err => sendResponse({ ok: false, error: err.message }))
    );
    return true;
  }

  if (message.action === "api_delete") {
    apiHeaders().then(headers =>
      fetch(`${API}${message.path}`, { method: "DELETE", headers })
        .then(async res => {
          const data = await res.json().catch(() => ({}));
          sendResponse({ ok: res.ok, status: res.status, data });
        })
        .catch(err => sendResponse({ ok: false, error: err.message }))
    );
    return true;
  }

  if (message.action === "fetch_page") {
    fetch(message.url, { credentials: "omit" })
      .then(res => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.text();
      })
      .then(html => sendResponse({ ok: true, html }))
      .catch(err => sendResponse({ ok: false, error: err.message }));
    return true;
  }

  if (message.action === "open_tabs") {
    message.urls.forEach(url => chrome.tabs.create({ url, active: false }));
    sendResponse({ status: "ok", count: message.urls.length });
    return true;
  }

  return true;
});
