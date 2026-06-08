const API = "http://localhost:8000";

let activeTabId = null;
let selectedVacancyId = null;
let editingVacancyId = null;   // null = создание, id = редактирование
let pendingActions = { to_reject: [], to_huntflow: [] };

const $ = id => document.getElementById(id);

// ── Init ──────────────────────────────────────────────────────────────────────

document.addEventListener("DOMContentLoaded", async () => {
  const hasKey = await initApiKey();
  if (!hasKey) return;
  await detectTab();
  await checkBackend();
  await loadVacancies();
  bindEvents();
  await restoreState();
});

// ── API Key management ────────────────────────────────────────────────────────

async function getApiKey() {
  const d = await chrome.storage.local.get("geminiApiKey");
  return d.geminiApiKey || null;
}

async function saveApiKey(key) {
  await chrome.storage.local.set({ geminiApiKey: key });
}

function toggleEye(inputId, btnId) {
  const input = $(inputId);
  const btn   = $(btnId);
  if (!input || !btn) return;
  btn.addEventListener("click", () => {
    const isHidden = input.type === "password";
    input.type = isHidden ? "text" : "password";
    btn.textContent = isHidden ? "🙈" : "👁";
  });
}

async function initApiKey() {
  const key = await getApiKey();
  if (!key) {
    $("setup-screen").classList.remove("hidden");
    toggleEye("setup-api-key", "btn-eye-setup");
    $("btn-save-setup-key").addEventListener("click", async () => {
      const val = $("setup-api-key").value.trim();
      if (!val) { alert("Введите API ключ"); return; }
      await saveApiKey(val);
      $("setup-screen").classList.add("hidden");
      await detectTab();
      await checkBackend();
      await loadVacancies();
      bindEvents();
      await restoreState();
    });
    return false;
  }
  return true;
}

function openSettings() {
  const panel = $("settings-panel");
  const isHidden = panel.classList.contains("hidden");
  panel.classList.toggle("hidden", !isHidden);
  if (isHidden) {
    getApiKey().then(k => {
      const input = $("settings-api-key");
      input.type = "password";
      input.value = k || "";
      $("btn-eye-settings").textContent = "👁";
    });
  }
}

async function detectTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  activeTabId = tab?.id;

  const bar = $("page-status");
  if (tab?.url?.includes("hh.kz")) {
    bar.className = "status-bar ok";
    bar.textContent = "✓ hh.kz — откройте страницу откликов";
  } else {
    bar.className = "status-bar warn";
    bar.textContent = "⚠ Перейдите на страницу откликов hh.kz";
    activeTabId = null;
  }
}

async function checkBackend() {
  try {
    const res = await fetch(`${API}/health`, { signal: AbortSignal.timeout(2000) });
    if (!res.ok) throw new Error();
  } catch {
    $("page-status").className = "status-bar error";
    $("page-status").textContent = "✗ Бэкенд не запущен — выполните start.bat";
  }
}

// ── Restore state ─────────────────────────────────────────────────────────────

async function restoreState() {
  const stored = await chrome.storage.session.get(["selectedVacancyId", "screeningProgress"]);

  const savedVacancyId = stored.selectedVacancyId;
  if (savedVacancyId) {
    $("vacancy-select").value = savedVacancyId;
    if ($("vacancy-select").value == savedVacancyId) {
      selectedVacancyId = String(savedVacancyId);
      $("screening-section").classList.remove("hidden");
      $("btn-delete-vacancy").style.display = "";
      $("btn-edit-vacancy").style.display = "";
      await loadPendingActions();
    }
  }

  const p = stored.screeningProgress;
  if (!p) return;

  if (p.vacancyId && !selectedVacancyId) {
    $("vacancy-select").value = p.vacancyId;
    selectedVacancyId = String(p.vacancyId);
    $("screening-section").classList.remove("hidden");
    $("btn-delete-vacancy").style.display = "";
    $("btn-edit-vacancy").style.display = "";
  }

  if (p.active) {
    showProgress(true);
    const pct = p.total ? Math.round((p.current / p.total) * 100) : 0;
    $("progress-fill").style.width = pct + "%";
    $("progress-text").textContent = `${p.current} / ${p.total}${p.name ? " — " + p.name : ""}`;
    $("btn-start").classList.add("hidden");
    $("btn-stop").classList.remove("hidden");
    watchScreeningProgress();

  } else if (p.done) {
    showProgress(true);
    $("progress-fill").style.width = "100%";

    if (p.error) {
      $("progress-text").textContent = "⚠ " + p.error;
    } else if (p.allSkipped) {
      $("progress-text").textContent = `✓ Все ${p.skipped} резюме уже скринированы. Откройте дашборд.`;
    } else {
      let msg = `✓ Готово: ${p.processed} обработано`;
      if (p.skipped) msg += `, ${p.skipped} пропущено`;
      if (p.errors)  msg += `, ${p.errors} ошибок`;
      $("progress-text").textContent = msg;
    }
    await loadPendingActions();
    setTimeout(() => chrome.storage.session.remove("screeningProgress"), 60000);
  }
}


// ── Vacancies ─────────────────────────────────────────────────────────────────

async function loadVacancies() {
  try {
    const res = await fetch(`${API}/api/vacancies`);
    const vacancies = await res.json();
    const sel = $("vacancy-select");
    sel.innerHTML = '<option value="">— Выберите вакансию —</option>';
    vacancies.forEach(v => {
      const opt = document.createElement("option");
      opt.value = v.id;
      opt.textContent = v.title;
      sel.appendChild(opt);
    });
  } catch { /* backend not running */ }
}

function openNewVacancyForm() {
  editingVacancyId = null;
  $("vacancy-title").value        = "";
  $("vacancy-desc").value         = "";
  $("vacancy-url").value          = "";
  $("vacancy-requirements").value = "";
  $("new-vacancy-form").classList.toggle("hidden");
}

function openEditVacancyForm() {
  if (!selectedVacancyId) return;
  editingVacancyId = selectedVacancyId;

  // Заполняем форму текущими данными вакансии
  fetch(`${API}/api/vacancies`)
    .then(r => r.json())
    .then(vacancies => {
      const v = vacancies.find(x => String(x.id) === String(selectedVacancyId));
      if (!v) return;
      $("vacancy-title").value        = v.title;
      $("vacancy-desc").value         = v.description;
      $("vacancy-url").value          = "";
      $("vacancy-requirements").value = v.requirements || "";
      $("new-vacancy-form").classList.remove("hidden");
    });
}

async function saveVacancy() {
  const title        = $("vacancy-title").value.trim();
  const desc         = $("vacancy-desc").value.trim();
  const requirements = $("vacancy-requirements").value.trim() || null;
  if (!title || !desc) { alert("Заполните название и текст вакансии"); return; }

  const apiKey = await getApiKey();
  const headers = { "Content-Type": "application/json" };
  if (apiKey) headers["X-Gemini-Key"] = apiKey;

  if (editingVacancyId) {
    // Редактирование существующей
    const res = await fetch(`${API}/api/vacancies/${editingVacancyId}`, {
      method: "PUT",
      headers,
      body: JSON.stringify({ title, description: desc, requirements }),
    });
    const v = await res.json();

    // Обновляем текст в селекте
    const opt = $("vacancy-select").querySelector(`option[value="${v.id}"]`);
    if (opt) opt.textContent = v.title;

    editingVacancyId = null;
    $("new-vacancy-form").classList.add("hidden");
    $("vacancy-title").value        = "";
    $("vacancy-desc").value         = "";
    $("vacancy-requirements").value = "";
  } else {
    // Создание новой
    const res = await fetch(`${API}/api/vacancies`, {
      method: "POST",
      headers,
      body: JSON.stringify({ title, description: desc, requirements }),
    });
    const v = await res.json();

    const opt = document.createElement("option");
    opt.value = v.id;
    opt.textContent = v.title;
    $("vacancy-select").appendChild(opt);
    $("vacancy-select").value = v.id;

    $("new-vacancy-form").classList.add("hidden");
    $("vacancy-title").value        = "";
    $("vacancy-desc").value         = "";
    $("vacancy-requirements").value = "";
    onVacancyChange(v.id);
  }
}

async function deleteVacancy() {
  if (!selectedVacancyId) return;
  const name = $("vacancy-select").selectedOptions[0]?.textContent || "вакансию";
  if (!confirm(`Удалить «${name}» и всех её кандидатов?`)) return;

  await fetch(`${API}/api/vacancies/${selectedVacancyId}`, { method: "DELETE" });
  await loadVacancies();
  onVacancyChange(null);
  $("vacancy-select").value = "";
}

// ── Parse vacancy from HH URL ─────────────────────────────────────────────────

async function parseVacancyUrl() {
  const url = $("vacancy-url").value.trim();
  if (!url || !url.includes("hh.")) { alert("Вставьте ссылку на вакансию hh.kz / hh.ru"); return; }

  $("btn-parse-url").textContent = "Загружаю...";
  $("btn-parse-url").disabled = true;

  try {
    const res = await chrome.runtime.sendMessage({ action: "fetch_page", url });
    if (!res.ok) throw new Error(res.error || "Ошибка загрузки");

    const doc = new DOMParser().parseFromString(res.html, "text/html");

    const title =
      doc.querySelector("[data-qa='vacancy-title']")?.textContent?.trim() ||
      doc.querySelector("h1")?.textContent?.trim() ||
      "";

    const descEl =
      doc.querySelector("[data-qa='vacancy-description']") ||
      doc.querySelector(".vacancy-description")             ||
      doc.querySelector("[class*='vacancy-description']");

    const desc = descEl?.innerText?.trim() || descEl?.textContent?.replace(/\s+/g, " ").trim() || "";

    if (!title) { alert("Не удалось считать название — попробуйте вставить текст вручную"); return; }

    $("vacancy-title").value = title;
    $("vacancy-desc").value  = desc;
  } catch (e) {
    alert("Ошибка: " + e.message);
  } finally {
    $("btn-parse-url").textContent = "Загрузить";
    $("btn-parse-url").disabled = false;
  }
}

// ── Screening ─────────────────────────────────────────────────────────────────

function showProgress(visible) {
  $("progress-wrap").classList.toggle("hidden", !visible);
}

async function startScreening() {
  if (!selectedVacancyId) { alert("Выберите вакансию"); return; }
  if (!activeTabId) { alert("Откройте страницу откликов на hh.kz"); return; }

  let ack;
  try {
    ack = await chrome.tabs.sendMessage(activeTabId, {
      action: "start_screening",
      vacancyId: parseInt(selectedVacancyId),
    });
  } catch (e) {
    alert("Ошибка подключения к странице.\nОбновите страницу hh.kz (F5) и попробуйте снова.\n\n" + e.message);
    return;
  }

  if (ack?.error) {
    alert("Ошибка: " + ack.error);
    return;
  }

  $("btn-start").classList.add("hidden");
  $("btn-stop").classList.remove("hidden");
  showProgress(true);
  $("progress-fill").style.width = "0%";
  $("progress-text").textContent = "Поиск резюме на странице...";

  watchScreeningProgress();
}

function watchScreeningProgress() {
  function onStorageChange(changes, area) {
    if (area !== "session" || !changes.screeningProgress) return;
    const p = changes.screeningProgress.newValue;
    if (!p) return;

    if (p.active) {
      const pct = p.total ? Math.round(((p.current) / p.total) * 100) : 0;
      $("progress-fill").style.width = pct + "%";
      $("progress-text").textContent = `${p.current} / ${p.total}${p.name ? " — " + p.name : ""}`;
    }

    if (!p.active && p.done) {
      chrome.storage.onChanged.removeListener(onStorageChange);
      $("btn-start").classList.remove("hidden");
      $("btn-stop").classList.add("hidden");
      $("btn-stop").disabled = false;

      $("progress-fill").style.width = "100%";

      if (p.error) {
        $("progress-text").textContent = "⚠ " + p.error;
      } else if (p.allSkipped) {
        $("progress-text").textContent = `✓ Все ${p.skipped} резюме уже скринированы. Откройте дашборд.`;
      } else {
        let msg = `✓ Готово: ${p.processed} обработано`;
        if (p.skipped) msg += `, ${p.skipped} пропущено`;
        if (p.errors)  msg += `, ${p.errors} ошибок`;
        $("progress-text").textContent = msg;
      }
      loadPendingActions();
    }
  }
  chrome.storage.onChanged.addListener(onStorageChange);
}

async function stopScreening() {
  await chrome.storage.session.set({ cancelScreening: true });
  $("progress-text").textContent = "Останавливаем...";
  $("btn-stop").disabled = true;
}

// ── Pending actions ───────────────────────────────────────────────────────────

async function loadPendingActions() {
  if (!selectedVacancyId) return;
  try {
    const res = await fetch(`${API}/api/vacancies/${selectedVacancyId}/pending-actions`);
    pendingActions = await res.json();

    const rejectCount   = pendingActions.to_reject?.length   || 0;
    const huntflowCount = pendingActions.to_huntflow?.length || 0;
    const hasActions    = rejectCount > 0 || huntflowCount > 0;

    $("actions-section").classList.toggle("hidden", !hasActions);

    // Рендерим список с чекбоксами
    const rejectSection = $("reject-section");
    rejectSection.classList.toggle("hidden", rejectCount === 0);
    if (rejectCount > 0) {
      const list = $("reject-list");
      list.innerHTML = "";
      pendingActions.to_reject.forEach(c => {
        const label = document.createElement("label");
        label.className = "reject-item";
        const cb = document.createElement("input");
        cb.type = "checkbox";
        cb.checked = true;
        cb.dataset.id = c.id;
        cb.dataset.hhUrl = c.hh_url;
        const span = document.createElement("span");
        span.textContent = c.name || c.hh_url;
        label.appendChild(cb);
        label.appendChild(span);
        list.appendChild(label);
      });
      $("reject-check-all").checked = true;
      $("reject-check-all").indeterminate = false;
      updateRejectCount();
    }

    $("btn-do-huntflow").classList.toggle("hidden", huntflowCount === 0);
    $("huntflow-count").textContent = huntflowCount;
  } catch { /* ignore */ }
}

function updateRejectCount() {
  const all     = [...document.querySelectorAll("#reject-list .reject-item input")];
  const checked = all.filter(cb => cb.checked);
  $("reject-count").textContent = checked.length;
  $("btn-do-rejections").disabled = checked.length === 0;
  const allCb = $("reject-check-all");
  if (checked.length === 0) {
    allCb.checked = false;
    allCb.indeterminate = false;
  } else if (checked.length === all.length) {
    allCb.checked = true;
    allCb.indeterminate = false;
  } else {
    allCb.checked = false;
    allCb.indeterminate = true;
  }
}

async function executeRejections() {
  if (!activeTabId) { alert("Откройте страницу откликов hh.kz"); return; }
  const checked = [...document.querySelectorAll("#reject-list .reject-item input:checked")];
  const candidates = checked.map(cb => ({ id: parseInt(cb.dataset.id), hh_url: cb.dataset.hhUrl }));
  if (!candidates.length) return;

  $("btn-do-rejections").disabled = true;
  $("btn-do-rejections").textContent = "Выполняется...";

  try {
    const result = await chrome.tabs.sendMessage(activeTabId, {
      action: "execute_rejections",
      candidates,
    });
    alert(`Выполнено: ${result.rejected} из ${result.total} отказов`);
    await loadPendingActions();
  } catch (e) {
    alert("Ошибка: " + e.message);
  } finally {
    $("btn-do-rejections").disabled = false;
    await loadPendingActions();
  }
}

async function openHuntflowTabs() {
  const candidates = pendingActions.to_huntflow || [];
  if (!candidates.length) return;

  chrome.runtime.sendMessage({
    action: "open_tabs",
    urls: candidates.map(c => c.hh_url),
  });

  await Promise.all(
    candidates.map(c =>
      fetch(`${API}/api/candidates/${c.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "huntflow_sent" }),
      })
    )
  );
  await loadPendingActions();
}

// ── Diagnose ─────────────────────────────────────────────────────────────────

async function runDiagnose() {
  if (!activeTabId) { $("diagnose-result").textContent = "Не на HH странице"; return; }
  try {
    const r = await chrome.tabs.sendMessage(activeTabId, { action: "diagnose" });
    $("diagnose-result").textContent = [
      `URL: ${r.url}`,
      `Готово к скринингу: ${r.linksFound} резюме`,
      `Всего ссылок на резюме: ${r.allResumeLinksTotal}`,
    ].join("\n");
  } catch (e) {
    $("diagnose-result").textContent = "Ошибка: " + e.message;
  }
}

// ── Event binding ─────────────────────────────────────────────────────────────

function bindEvents() {
  $("btn-settings").addEventListener("click", openSettings);
  toggleEye("settings-api-key", "btn-eye-settings");
  $("btn-save-settings-key").addEventListener("click", async () => {
    const val = $("settings-api-key").value.trim();
    if (!val) { alert("Введите API ключ"); return; }
    await saveApiKey(val);
    $("settings-panel").classList.add("hidden");
    alert("Ключ сохранён");
  });
  $("btn-close-settings").addEventListener("click", () => {
    $("settings-panel").classList.add("hidden");
  });
  $("btn-clear-key").addEventListener("click", async () => {
    if (!confirm("Удалить API ключ? Расширение попросит ввести новый при следующем открытии.")) return;
    await chrome.storage.local.remove("geminiApiKey");
    $("settings-panel").classList.add("hidden");
    window.location.reload();
  });

  $("vacancy-select").addEventListener("change", e => onVacancyChange(e.target.value));
  $("btn-new-vacancy").addEventListener("click",    openNewVacancyForm);
  $("btn-edit-vacancy").addEventListener("click",   openEditVacancyForm);
  $("btn-save-vacancy").addEventListener("click",   saveVacancy);
  $("btn-cancel-vacancy").addEventListener("click", () => {
    editingVacancyId = null;
    $("new-vacancy-form").classList.add("hidden");
  });
  $("btn-delete-vacancy").addEventListener("click", deleteVacancy);
  $("btn-parse-url").addEventListener("click",      parseVacancyUrl);
  $("btn-regen-summary").addEventListener("click",  () => {
    $("vacancy-requirements").value       = "";
    $("vacancy-requirements").placeholder = "⏳ AI сформирует заново после сохранения...";
  });
  $("btn-start").addEventListener("click",          startScreening);
  $("btn-stop").addEventListener("click",           stopScreening);
  $("btn-dashboard").addEventListener("click",      () => {
    chrome.tabs.create({ url: `${API}/?vacancy=${selectedVacancyId || ""}` });
  });
  $("btn-do-rejections").addEventListener("click",  executeRejections);
  $("reject-check-all").addEventListener("change", e => {
    document.querySelectorAll("#reject-list .reject-item input").forEach(cb => {
      cb.checked = e.target.checked;
    });
    updateRejectCount();
  });
  $("reject-list").addEventListener("change", () => updateRejectCount());
  $("btn-do-huntflow").addEventListener("click",    openHuntflowTabs);
  $("btn-diagnose").addEventListener("click",       runDiagnose);
}

async function onVacancyChange(id) {
  selectedVacancyId = id || null;
  chrome.storage.session.set({ selectedVacancyId: id || null });
  $("screening-section").classList.toggle("hidden", !id);
  $("btn-delete-vacancy").style.display = id ? "" : "none";
  $("btn-edit-vacancy").style.display   = id ? "" : "none";
  if (id) await loadPendingActions();
  else $("actions-section").classList.add("hidden");
}
