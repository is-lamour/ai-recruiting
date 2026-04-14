const API = "http://localhost:8000";

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {

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

  if (message.action === "reset_cancel") {
    chrome.storage.session.set({ cancelScreening: false });
    sendResponse({ ok: true });
    return true;
  }



  if (message.action === "api_get") {
    fetch(`${API}${message.path}`)
      .then(async res => {
        const data = await res.json().catch(() => ({}));
        sendResponse({ ok: res.ok, status: res.status, data });
      })
      .catch(err => sendResponse({ ok: false, error: err.message }));
    return true;
  }

  if (message.action === "api_post") {
    fetch(`${API}${message.path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(message.body),
    })
      .then(async res => {
        const data = await res.json().catch(() => ({}));
        sendResponse({ ok: res.ok, status: res.status, data });
      })
      .catch(err => sendResponse({ ok: false, error: err.message }));
    return true;
  }

  if (message.action === "api_patch") {
    fetch(`${API}${message.path}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(message.body),
    })
      .then(async res => {
        const data = await res.json().catch(() => ({}));
        sendResponse({ ok: res.ok, status: res.status, data });
      })
      .catch(err => sendResponse({ ok: false, error: err.message }));
    return true;
  }

  if (message.action === "api_delete") {
    fetch(`${API}${message.path}`, { method: "DELETE" })
      .then(async res => {
        const data = await res.json().catch(() => ({}));
        sendResponse({ ok: res.ok, status: res.status, data });
      })
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
