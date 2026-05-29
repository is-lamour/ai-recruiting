// Синхронизирует Gemini API ключ из chrome.storage.local в localStorage дашборда

chrome.storage.local.get("geminiApiKey", ({ geminiApiKey }) => {
  if (geminiApiKey) {
    localStorage.setItem("geminiApiKey", geminiApiKey);
  }
});

// Слушаем изменения — если ключ обновили в расширении, сразу обновляем в дашборде
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local" || !changes.geminiApiKey) return;
  const { newValue } = changes.geminiApiKey;
  if (newValue) {
    localStorage.setItem("geminiApiKey", newValue);
  } else {
    localStorage.removeItem("geminiApiKey");
  }
});
