const API = "http://localhost:8000";

let activeTabId = null;
let selectedVacancyId = null;
let pendingActions = { to_reject: [], to_huntflow: [] };

const $ = id => document.getElementById(id);

// ── Init ──────────────────────────────────────────────────────────────────────

document.addEventListener("DOMContentLoaded", async () => {
  await detectTab();
  await checkBackend();
  await loadVacancies();
  bindEvents();
  await restoreState();
});

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

  // 1. Восстанавливаем выбранную вакансию
  const savedVacancyId = stored.selectedVacancyId;
  if (savedVacancyId) {
    $("vacancy-select").value = savedVacancyId;
    // Проверяем что опция реально существует
    if ($("vacancy-select").value == savedVacancyId) {
      selectedVacancyId = String(savedVacancyId);
      $("screening-section").classList.remove("hidden");
      $("btn-delete-vacancy").style.display = "";
      await loadPendingActions();
    }
  }

  // 2. Восстанавливаем состояние скрининга
  const p = stored.screeningProgress;
  if (!p) return;

  // Восстанавливаем вакансию из прогресса (если ещё не установлена)
  if (p.vacancyId && !selectedVacancyId) {
    $("vacancy-select").value = p.vacancyId;
    selectedVacancyId = String(p.vacancyId);
    $("screening-section").classList.remove("hidden");
    $("btn-delete-vacancy").style.display = "";
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

async function saveVacancy() {
  const title = $("vacancy-title").value.trim();
  const desc  = $("vacancy-desc").value.trim();
  if (!title || !desc) { alert("Заполните название и текст вакансии"); return; }

  const res = await fetch(`${API}/api/vacancies`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title, description: desc }),
  });
  const v = await res.json();

  const opt = document.createElement("option");
  opt.value = v.id;
  opt.textContent = v.title;
  $("vacancy-select").appendChild(opt);
  $("vacancy-select").value = v.id;

  $("new-vacancy-form").classList.add("hidden");
  $("vacancy-title").value = "";
  $("vacancy-desc").value  = "";
  onVacancyChange(v.id);
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

// ── Screening ─────────────────────────────────────────────────────────────────

function showProgress(visible) {
  $("progress-wrap").classList.toggle("hidden", !visible);
}

async function startScreening() {
  if (!selectedVacancyId) { alert("Выберите вакансию"); return; }
  if (!activeTabId) { alert("Откройте страницу откликов на hh.kz"); return; }

  // Сначала проверяем что контент-скрипт живой
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

  // Скрининг запущен — переключаем UI и слушаем прогресс через storage
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

    $("btn-do-rejections").classList.toggle("hidden", rejectCount === 0);
    $("reject-count").textContent = rejectCount;

    $("btn-do-huntflow").classList.toggle("hidden", huntflowCount === 0);
    $("huntflow-count").textContent = huntflowCount;
  } catch { /* ignore */ }
}

async function executeRejections() {
  if (!activeTabId) { alert("Откройте страницу откликов hh.kz"); return; }
  const candidates = pendingActions.to_reject || [];
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
  $("vacancy-select").addEventListener("change", e => onVacancyChange(e.target.value));
  $("btn-new-vacancy").addEventListener("click",    () => $("new-vacancy-form").classList.toggle("hidden"));
  $("btn-save-vacancy").addEventListener("click",   saveVacancy);
  $("btn-cancel-vacancy").addEventListener("click", () => $("new-vacancy-form").classList.add("hidden"));
  $("btn-delete-vacancy").addEventListener("click", deleteVacancy);
  $("btn-start").addEventListener("click",          startScreening);
  $("btn-stop").addEventListener("click",           stopScreening);
  $("btn-dashboard").addEventListener("click",      () => {
    chrome.tabs.create({ url: `${API}/?vacancy=${selectedVacancyId || ""}` });
  });
  $("btn-do-rejections").addEventListener("click",  executeRejections);
  $("btn-do-huntflow").addEventListener("click",    openHuntflowTabs);
  $("btn-diagnose").addEventListener("click",       runDiagnose);
}

async function onVacancyChange(id) {
  selectedVacancyId = id || null;
  chrome.storage.session.set({ selectedVacancyId: id || null });
  $("screening-section").classList.toggle("hidden", !id);
  $("btn-delete-vacancy").style.display = id ? "" : "none";
  if (id) await loadPendingActions();
  else $("actions-section").classList.add("hidden");
}
