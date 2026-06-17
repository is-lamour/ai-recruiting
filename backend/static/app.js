const API = "";  // same origin

const _MON = "Янв|Фев|Мар|Апр|Май|Июн|Июл|Авг|Сен|Окт|Ноя|Дек";
const _MON_RX = new RegExp(`(?:${_MON})\\s+\\d{4}`);
const _SECTION_HEADERS = ["Опыт работы","Навыки","Образование","Языки","Обо мне","Рекомендации","Сопроводительное письмо"];

// Маркеры конца резюме (всё начиная с них — мусор)
const _RESUME_END_MARKERS = [
  "КомментарииИстория",
  "Комментарии\nИстория",
  "О компанииНаши вакансии",
  "О компании\nНаши вакансии",
  "ДополнительноЖелательное время",
  "new Image().src",
  "var _tmr",
  "window.ym(",
  "© 20",
];

// Первый реальный раздел резюме — с него начинается контент
const _CONTENT_START_MARKERS = [
  "Сопроводительное письмо",
  "Опыт работы",
  "ЗП ожид",
  "Желаемая должность",
  "Специализации:",
];

function formatResumeHtml(raw) {
  if (!raw) return "";

  let t = raw;

  // 1. Убираем JS-мусор в самом начале (window.globalVars и т.п.)
  t = t.replace(/^[\s\S]*?(?=\n)/u, s => /window\.|var |function /.test(s) ? "" : s).trim();

  // 2. Вырезаем блок контактов HH: от "Контакты" до первого раздела резюме
  // Паттерн: "Контакты" → телефоны/ссылки → "Написать в чат" / "Показать все контакты"
  t = t.replace(/Контакты[\s\S]{0,300}?(?=Сопроводительное письмо|ЗП ожид|Специализации:|Тип занятости|Опыт работы:|Желаемая должность)/g, "");

  // 3. Если осталась навигация "Пожаловаться на отклик" — режем до неё и берём после
  const navIdx = t.indexOf("Пожаловаться на отклик");
  if (navIdx !== -1 && navIdx < t.length * 0.25) {
    t = t.slice(navIdx + "Пожаловаться на отклик".length);
  }

  // 4. Убираем хвост — служебные данные и JS-трекеры
  for (const marker of _RESUME_END_MARKERS) {
    const idx = t.indexOf(marker);
    if (idx !== -1 && idx > t.length * 0.2) {
      t = t.slice(0, idx);
      break;
    }
  }
  t = t.trim();

  // 5. Нормализуем пробелы, сохраняя переносы
  t = t.replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n");

  // 6. Вставляем разрывы перед ключевыми полями шапки
  const _HEADER_BREAKS = [
    "Сопроводительное письмо",
    "Специализации:",
    "Тип занятости:",
    "Формат работы:",
    "Опыт работы:",
    "Обновлено ",
    "Активно ищет работу",
    "Не ищет работу",
    "ЗП ожид",
  ];
  _HEADER_BREAKS.forEach(s => {
    t = t.replace(new RegExp(`([^\\n])(${s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})`, "g"), "$1\n\n$2");
  });

  // 7. Вставляем разрывы перед датами опыта
  t = t.replace(new RegExp(`([^\\n])((?:${_MON})\\s+\\d{4})`, "g"), "$1\n\n$2");

  // 8. Вставляем разрывы перед заголовками секций
  _SECTION_HEADERS.forEach(s => {
    t = t.replace(new RegExp(`([^\\n])(${s})(?=\\s|$)`, "g"), "$1\n\n$2");
  });

  const blocks = t.split(/\n\n+/).map(b => b.trim()).filter(Boolean);
  if (!blocks.length) return `<div class="rv-line">${escHtml(t)}</div>`;

  let html = "";

  blocks.forEach((block, idx) => {
    const lines = block.split(/\n/).map(l => l.trim()).filter(Boolean);
    if (!lines.length) return;

    const first = lines[0];

    // ── Заголовок секции ──────────────────────────────────────────────────
    if (_SECTION_HEADERS.includes(first)) {
      html += `<div class="rv-section-head">${escHtml(first)}</div>`;
      renderLines(lines.slice(1));
      return;
    }

    // ── Блок опыта (начинается с даты) ───────────────────────────────────
    if (_MON_RX.test(first) || /^\d{4}/.test(first)) {
      html += `<div class="rv-exp-block">`;
      // первые 1-3 строки — мета: дата, компания, должность
      let bodyStart = 0;
      lines.forEach((line, j) => {
        if (j === 0) {
          html += `<div class="rv-exp-date">${escHtml(line)}</div>`;
          bodyStart = 1;
        } else if (j <= 2 && !line.startsWith("-") && line.length < 120) {
          html += `<div class="rv-exp-company">${escHtml(line)}</div>`;
          bodyStart = j + 1;
        } else {
          html += line.startsWith("-")
            ? `<div class="rv-bullet">• ${escHtml(line.slice(1).trim())}</div>`
            : `<div class="rv-line">${escHtml(line)}</div>`;
        }
      });
      html += `</div>`;
      return;
    }

    // ── Первый блок — личная информация ──────────────────────────────────
    if (idx === 0) {
      html += `<div class="rv-personal-block">`;
      html += `<div class="rv-candidate-name">${escHtml(first)}</div>`;
      lines.slice(1).forEach(l => {
        // демография (пол, возраст, дата рождения)
        if (/^(Мужчина|Женщина)/.test(l)) {
          html += `<div class="rv-personal-demo">${escHtml(l)}</div>`;
        // геолокация
        } else if (/готов|переезд|командиров|км\)|Almaty|Алматы|Москв|Санкт/i.test(l)) {
          html += `<div class="rv-personal-geo">${escHtml(l)}</div>`;
        // статус поиска
        } else if (/ищет работу|Не ищет|Обновлено/.test(l)) {
          html += `<div class="rv-personal-status">${escHtml(l)}</div>`;
        // желаемая должность / зп
        } else if (/₽|тенге|тыс\.|000 |на руки|ожид/.test(l)) {
          html += `<div class="rv-personal-salary">${escHtml(l)}</div>`;
        } else {
          html += `<div class="rv-personal-line">${escHtml(l)}</div>`;
        }
      });
      html += `</div>`;
      return;
    }

    // ── Навыки (короткие слова, много штук) ──────────────────────────────
    const allShort = lines.every(l => !l.startsWith("-") && l.length < 60);
    if (allShort && lines.length > 3) {
      html += `<div class="rv-skills">`;
      lines.forEach(l => { html += `<span class="rv-skill-tag">${escHtml(l)}</span>`; });
      html += `</div>`;
      return;
    }

    // ── Обычный блок ──────────────────────────────────────────────────────
    html += `<div class="rv-generic-block">`;
    renderLines(lines);
    html += `</div>`;

    function renderLines(ls) {
      ls.forEach(l => {
        html += l.startsWith("-")
          ? `<div class="rv-bullet">• ${escHtml(l.slice(1).trim())}</div>`
          : `<div class="rv-line">${escHtml(l)}</div>`;
      });
    }
  });

  return html;
}

function getApiKey() { return localStorage.getItem("geminiApiKey") || ""; }
function apiHeaders(extra = {}) {
  const h = { "Content-Type": "application/json", ...extra };
  const k = getApiKey();
  if (k) h["X-Gemini-Key"] = k;
  return h;
}
let currentVacancyId = null;
let currentVacancy = null;
let allVacancies = [];
let allCandidates = [];
let activeFilter = "all";
let activeSort = "score_desc";
let editingVacancyId = null;
let summaryPollTimer = null;
let booleanPollTimer = null;
let rescreenPollTimer = null;
let scoreMin = 0;
let scoreMax = 100;
let selectedIds = new Set();
let viewMode = "main"; // "main" | "trash"

// ── Init ──────────────────────────────────────────────────────────────────────

document.addEventListener("DOMContentLoaded", async () => {
  await loadVacancies();
  setupListeners();

  const params = new URLSearchParams(window.location.search);
  const vid = params.get("vacancy");
  if (vid) {
    document.getElementById("vacancy-select").value = vid;
    await selectVacancy(parseInt(vid));
  }
});

// ── Vacancies ─────────────────────────────────────────────────────────────────

async function loadVacancies() {
  const res = await fetch(`${API}/api/vacancies`);
  allVacancies = await res.json();

  const sel = document.getElementById("vacancy-select");
  const cur = sel.value;
  sel.innerHTML = '<option value="">— Выберите вакансию —</option>';
  allVacancies.forEach(v => {
    const opt = document.createElement("option");
    opt.value = v.id;
    opt.textContent = v.title;
    sel.appendChild(opt);
  });
  if (cur) sel.value = cur;
}

async function selectVacancy(id) {
  currentVacancyId = id;
  currentVacancy = allVacancies.find(v => v.id === id) || null;
  viewMode = "main";
  selectedIds.clear();
  currentMetrics = [];
  stopMetricsPoll();
  stopRescreenPoll();
  hideRescreenProgress();
  document.getElementById("metrics-section").classList.add("hidden");

  // Сбросить активный фильтр на "Все"
  document.querySelectorAll(".filter-btn").forEach(b => b.classList.remove("active"));
  document.querySelector(".filter-btn[data-filter='all']").classList.add("active");
  activeFilter = "all";

  if (!currentVacancy) {
    try {
      const res = await fetch(`${API}/api/vacancies`);
      allVacancies = await res.json();
      currentVacancy = allVacancies.find(v => v.id === id) || null;
    } catch { /* ignore */ }
  }

  showVacancyPanel(currentVacancy);
  document.getElementById("no-vacancy-state").classList.add("hidden");
  document.getElementById("app").classList.remove("hidden");
  await refreshData();
}

function showVacancyPanel(v) {
  const panel = document.getElementById("vacancy-panel");
  if (!v) { panel.classList.add("hidden"); return; }

  document.getElementById("vp-title").textContent = v.title;
  const reqEl = document.getElementById("vp-requirements");
  if (v.requirements) {
    reqEl.textContent = v.requirements;
    reqEl.classList.remove("vp-req-pending");
  } else {
    reqEl.textContent = "⏳ Генерируется summary...";
    reqEl.classList.add("vp-req-pending");
  }
  document.getElementById("vp-description").textContent = v.description || "";
  panel.classList.remove("hidden");

  // Boolean: показываем секцию если уже сгенерировано
  const boolSection = document.getElementById("boolean-section");
  if (v.boolean_search) {
    boolSection.classList.remove("hidden");
    renderBooleanResult(v.boolean_search);
    document.getElementById("btn-regen-boolean").disabled = false;
  } else {
    boolSection.classList.add("hidden");
    document.getElementById("boolean-result").classList.add("hidden");
    document.getElementById("boolean-generating").classList.add("hidden");
  }
}

// ── Summary polling ───────────────────────────────────────────────────────────

function startSummaryPoll(vacancyId) {
  stopSummaryPoll();
  summaryPollTimer = setInterval(async () => {
    if (currentVacancyId !== vacancyId) { stopSummaryPoll(); return; }
    try {
      const res = await fetch(`${API}/api/vacancies`);
      const vacancies = await res.json();
      const v = vacancies.find(x => x.id === vacancyId);
      if (v && v.requirements) {
        allVacancies = vacancies;
        currentVacancy = v;
        showVacancyPanel(v);
        stopSummaryPoll();
      }
    } catch { /* ignore */ }
  }, 2000);
}

function stopSummaryPoll() {
  if (summaryPollTimer) { clearInterval(summaryPollTimer); summaryPollTimer = null; }
}

// ── Boolean search ────────────────────────────────────────────────────────────

async function generateBoolean() {
  if (!currentVacancyId) return;
  const btn = document.getElementById("btn-regen-boolean");
  btn.disabled = true;

  document.getElementById("boolean-section").classList.remove("hidden");
  document.getElementById("boolean-result").classList.add("hidden");
  document.getElementById("boolean-generating").classList.remove("hidden");

  try {
    await fetch(`${API}/api/vacancies/${currentVacancyId}/generate-boolean`, {
      method: "POST",
      headers: apiHeaders(),
    });
    startBooleanPoll(currentVacancyId);
  } catch {
    document.getElementById("boolean-generating").classList.add("hidden");
    btn.disabled = false;
  }
}

function startBooleanPoll(vacancyId) {
  stopBooleanPoll();
  booleanPollTimer = setInterval(async () => {
    if (currentVacancyId !== vacancyId) { stopBooleanPoll(); return; }
    try {
      const res = await fetch(`${API}/api/vacancies`);
      const vacancies = await res.json();
      const v = vacancies.find(x => x.id === vacancyId);
      if (v && v.boolean_search) {
        allVacancies = vacancies;
        currentVacancy = v;
        renderBooleanResult(v.boolean_search);
        stopBooleanPoll();
        document.getElementById("btn-regen-boolean").disabled = false;
      }
    } catch { /* ignore */ }
  }, 2000);
}

function stopBooleanPoll() {
  if (booleanPollTimer) { clearInterval(booleanPollTimer); booleanPollTimer = null; }
}

function renderBooleanResult(rawJson) {
  let data;
  try { data = typeof rawJson === "string" ? JSON.parse(rawJson) : rawJson; } catch { return; }

  document.getElementById("boolean-generating").classList.add("hidden");

  if (data.position || data.stack) {
    const meta = [];
    if (data.position) meta.push(`<b>Должность:</b> ${escHtml(data.position)}`);
    if (data.stack)    meta.push(`<b>Стек:</b> ${escHtml(data.stack)}`);
    document.getElementById("boolean-meta").innerHTML = meta.join(" &nbsp;|&nbsp; ");
  } else {
    document.getElementById("boolean-meta").innerHTML = "";
  }

  document.getElementById("bq-wide").textContent   = data.wide   || "";
  document.getElementById("bq-medium").textContent = data.medium || "";
  document.getElementById("bq-narrow").textContent = data.narrow || "";

  const commentEl = document.getElementById("boolean-comment");
  if (data.comment) {
    commentEl.textContent = data.comment;
    commentEl.classList.remove("hidden");
  } else {
    commentEl.classList.add("hidden");
  }

  document.getElementById("boolean-result").classList.remove("hidden");
}

function copyBoolean(elementId) {
  const text = document.getElementById(elementId)?.textContent || "";
  if (!text) return;
  navigator.clipboard.writeText(text).then(() => {
    const btn = document.querySelector(`[onclick="copyBoolean('${elementId}')"]`);
    if (btn) {
      const orig = btn.textContent;
      btn.textContent = "Скопировано!";
      setTimeout(() => { btn.textContent = orig; }, 1500);
    }
  });
}

// ── Metrics ───────────────────────────────────────────────────────────────────

let currentMetrics = [];
let metricsPollTimer = null;

function stopMetricsPoll() {
  if (metricsPollTimer) { clearInterval(metricsPollTimer); metricsPollTimer = null; }
}

function startMetricsPoll(vacancyId) {
  stopMetricsPoll();
  metricsPollTimer = setInterval(async () => {
    if (currentVacancyId !== vacancyId) { stopMetricsPoll(); return; }
    try {
      const res = await fetch(`${API}/api/vacancies/${vacancyId}/metrics`);
      if (!res.ok) return;
      const metrics = await res.json();
      if (metrics && metrics.length > 0) {
        currentMetrics = metrics;
        renderMetrics(metrics);
        document.getElementById("metrics-generating").classList.add("hidden");
        document.getElementById("btn-regen-metrics").disabled = false;
        stopMetricsPoll();
      }
    } catch { /* ignore */ }
  }, 2000);
}

async function loadMetrics(vacancyId) {
  try {
    const res = await fetch(`${API}/api/vacancies/${vacancyId}/metrics`);
    if (!res.ok) return;
    currentMetrics = await res.json();
    renderMetrics(currentMetrics);
  } catch { /* ignore */ }
}

function renderMetrics(metrics) {
  const list = document.getElementById("metrics-list");
  if (!metrics || metrics.length === 0) {
    list.innerHTML = '<div class="metrics-empty">Метрики не заданы</div>';
    return;
  }
  list.innerHTML = metrics.map((m, i) => `
    <div class="metric-row" data-index="${i}">
      <span class="metric-name" contenteditable="true" data-index="${i}">${escHtml(m.name)}</span>
      <div class="metric-slider-wrap">
        <input type="range" class="metric-slider" data-index="${i}"
          min="0" max="10" step="0.5" value="${m.weight}" />
        <span class="metric-weight-val" id="mw-${i}">${m.weight}</span>
      </div>
      <button class="metric-del-btn" data-index="${i}" title="Удалить">✕</button>
    </div>
  `).join("");

  list.querySelectorAll(".metric-slider").forEach(slider => {
    const idx = +slider.dataset.index;
    slider.addEventListener("input", () => {
      const val = parseFloat(slider.value);
      currentMetrics[idx].weight = val;
      document.getElementById(`mw-${idx}`).textContent = val;
    });
  });

  list.querySelectorAll(".metric-name[contenteditable]").forEach(el => {
    el.addEventListener("blur", () => {
      const idx = +el.dataset.index;
      currentMetrics[idx].name = el.textContent.trim();
    });
  });

  list.querySelectorAll(".metric-del-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      const idx = +btn.dataset.index;
      currentMetrics.splice(idx, 1);
      renderMetrics(currentMetrics);
    });
  });
}

async function saveMetrics() {
  if (!currentVacancyId) return;
  const btn = document.getElementById("btn-save-metrics");
  btn.textContent = "Сохраняем...";
  btn.disabled = true;
  try {
    const res = await fetch(`${API}/api/vacancies/${currentVacancyId}/metrics`, {
      method: "PUT",
      headers: apiHeaders(),
      body: JSON.stringify(currentMetrics),
    });
    if (res.ok) {
      currentMetrics = await res.json();
      renderMetrics(currentMetrics);
      showMetricsStatus("Сохранено ✓");
    }
  } finally {
    btn.textContent = "Сохранить";
    btn.disabled = false;
  }
}

async function regenMetrics() {
  if (!currentVacancyId) return;
  const btn = document.getElementById("btn-regen-metrics");
  btn.disabled = true;
  document.getElementById("metrics-generating").classList.remove("hidden");
  document.getElementById("metrics-list").innerHTML = "";
  try {
    await fetch(`${API}/api/vacancies/${currentVacancyId}/generate-metrics`, {
      method: "POST",
      headers: apiHeaders(),
    });
    startMetricsPoll(currentVacancyId);
  } catch {
    document.getElementById("metrics-generating").classList.add("hidden");
    btn.disabled = false;
  }
}

function addMetric() {
  const input = document.getElementById("metrics-new-name");
  const name = input.value.trim();
  if (!name) return;
  currentMetrics.push({ name, weight: 5.0 });
  renderMetrics(currentMetrics);
  input.value = "";
  document.getElementById("metrics-add-row").classList.add("hidden");
  document.getElementById("btn-show-add-metric").classList.remove("hidden");
}

function showMetricsStatus(msg) {
  const el = document.getElementById("metrics-status");
  el.textContent = msg;
  el.classList.remove("hidden");
  setTimeout(() => el.classList.add("hidden"), 2000);
}

// ── Vacancy CRUD ──────────────────────────────────────────────────────────────

function openNewVacancyForm() {
  editingVacancyId = null;
  document.getElementById("vf-heading").textContent = "Новая вакансия";
  document.getElementById("vf-url").value          = "";
  document.getElementById("vf-title").value        = "";
  document.getElementById("vf-desc").value         = "";
  document.getElementById("vf-requirements").value = "";
  document.getElementById("vf-url-row").classList.remove("hidden");
  document.getElementById("vacancy-form-wrap").classList.remove("hidden");
  document.getElementById("vf-url").focus();
}

function openEditVacancyForm() {
  if (!currentVacancy) return;
  editingVacancyId = currentVacancy.id;
  document.getElementById("vf-heading").textContent = "Редактировать вакансию";
  document.getElementById("vf-url").value          = "";
  document.getElementById("vf-title").value        = currentVacancy.title;
  document.getElementById("vf-desc").value         = currentVacancy.description;
  document.getElementById("vf-requirements").value = currentVacancy.requirements || "";
  document.getElementById("vf-url-row").classList.remove("hidden");
  document.getElementById("vacancy-form-wrap").classList.remove("hidden");
  document.getElementById("vf-title").focus();
}

function closeVacancyForm() {
  editingVacancyId = null;
  document.getElementById("vacancy-form-wrap").classList.add("hidden");
}

async function loadVacancyFromUrl() {
  const url = document.getElementById("vf-url").value.trim().replace(/^<|>$/g, "");
  if (!url) return;
  const btn = document.getElementById("btn-load-url");
  btn.textContent = "Загружаем...";
  btn.disabled = true;
  try {
    const res = await fetch(`${API}/api/parse-hh-vacancy?url=${encodeURIComponent(url)}`);
    if (!res.ok) {
      const err = await res.json();
      alert(err.detail || "Не удалось загрузить вакансию");
      return;
    }
    const data = await res.json();
    document.getElementById("vf-title").value = data.title;
    document.getElementById("vf-desc").value  = data.description;
    document.getElementById("vf-requirements").value = "";
  } finally {
    btn.textContent = "Загрузить";
    btn.disabled = false;
  }
}

async function saveVacancy() {
  const title        = document.getElementById("vf-title").value.trim();
  const desc         = document.getElementById("vf-desc").value.trim();
  const requirements = document.getElementById("vf-requirements").value.trim();
  if (!title || !desc) { alert("Заполните название и текст вакансии"); return; }

  const btn = document.getElementById("btn-save-vacancy");
  btn.textContent = "Сохраняем...";
  btn.disabled = true;

  const body = { title, description: desc, requirements: requirements || null };
  const isEditing = !!editingVacancyId;

  try {
    let res;
    if (isEditing) {
      res = await fetch(`${API}/api/vacancies/${editingVacancyId}`, {
        method: "PUT",
        headers: apiHeaders(),
        body: JSON.stringify(body),
      });
    } else {
      res = await fetch(`${API}/api/vacancies`, {
        method: "POST",
        headers: apiHeaders(),
        body: JSON.stringify(body),
      });
    }
    const v = await res.json();

    await loadVacancies();
    document.getElementById("vacancy-select").value = v.id;
    currentVacancy = v;
    currentVacancyId = v.id;
    showVacancyPanel(v);
    closeVacancyForm();

    // Если summary не было — запустить поллинг
    if (!v.requirements) startSummaryPoll(v.id);

    if (!isEditing) {
      document.getElementById("no-vacancy-state").classList.add("hidden");
      document.getElementById("app").classList.remove("hidden");
      await refreshData();
    }
  } finally {
    btn.textContent = "Сохранить";
    btn.disabled = false;
  }
}

async function deleteVacancy() {
  if (!currentVacancy) return;
  if (!confirm(`Удалить вакансию «${currentVacancy.title}» и всех её кандидатов?`)) return;

  stopSummaryPoll();
  stopBooleanPoll();
  stopMetricsPoll();
  await fetch(`${API}/api/vacancies/${currentVacancy.id}`, { method: "DELETE" });
  currentVacancyId = null;
  currentVacancy = null;
  await loadVacancies();
  document.getElementById("vacancy-select").value = "";
  document.getElementById("vacancy-panel").classList.add("hidden");
  document.getElementById("app").classList.add("hidden");
  document.getElementById("no-vacancy-state").classList.remove("hidden");
}

// ── Data loading ──────────────────────────────────────────────────────────────

async function refreshData() {
  if (!currentVacancyId) return;
  await Promise.all([loadStats(), loadCandidates()]);
}

async function loadStats() {
  const res = await fetch(`${API}/api/vacancies/${currentVacancyId}/stats`);
  const stats = await res.json();

  document.getElementById("stat-total").textContent    = stats.total;
  document.getElementById("stat-suitable").textContent = stats.suitable;
  document.getElementById("stat-consider").textContent = stats.consider;
  document.getElementById("stat-reject").textContent   = stats.reject;
  const trashCount = stats.trashed ?? 0;
  const trashEl = document.getElementById("stat-trash");
  trashEl.textContent = trashCount > 0 ? `(${trashCount})` : "";
  trashEl.classList.toggle("hidden", trashCount === 0);
}

async function loadCandidates() {
  const trashed = viewMode === "trash";
  const res = await fetch(`${API}/api/vacancies/${currentVacancyId}/candidates?trashed=${trashed}`);
  allCandidates = await res.json();
  selectedIds.clear();
  updateBulkPanel();
  renderCandidates();
}

// ── Render ────────────────────────────────────────────────────────────────────

function renderCandidates() {
  const list  = document.getElementById("candidates-list");
  const empty = document.getElementById("empty-filter-state");

  let filtered = allCandidates;
  if (viewMode === "main" && activeFilter !== "all") {
    filtered = allCandidates.filter(c => c.category === activeFilter);
  }
  if (viewMode === "main") {
    filtered = filtered.filter(c => (c.score ?? 0) >= scoreMin && (c.score ?? 0) <= scoreMax);
  }

  filtered = [...filtered].sort((a, b) => {
    if (activeSort === "score_desc") return (b.score ?? 0) - (a.score ?? 0);
    if (activeSort === "score_asc")  return (a.score ?? 0) - (b.score ?? 0);
    if (activeSort === "time_desc")  return new Date(b.created_at) - new Date(a.created_at);
    if (activeSort === "time_asc")   return new Date(a.created_at) - new Date(b.created_at);
    return 0;
  });

  if (filtered.length === 0) {
    list.innerHTML = "";
    empty.classList.remove("hidden");
    return;
  }
  empty.classList.add("hidden");
  list.innerHTML = filtered.map(buildCard).join("");

  list.querySelectorAll(".action-btn.to-huntflow").forEach(btn => {
    btn.addEventListener("click", () => setStatus(+btn.dataset.id, "to_huntflow"));
  });
  list.querySelectorAll(".action-btn.to-reject").forEach(btn => {
    btn.addEventListener("click", () => setStatus(+btn.dataset.id, "to_reject"));
  });
  list.querySelectorAll(".action-btn.undo").forEach(btn => {
    btn.addEventListener("click", () => setStatus(+btn.dataset.id, "new"));
  });
  list.querySelectorAll(".action-btn.delete-candidate").forEach(btn => {
    btn.addEventListener("click", () => deleteCandidate(+btn.dataset.id));
  });
  list.querySelectorAll(".action-btn.restore-candidate").forEach(btn => {
    btn.addEventListener("click", () => restoreCandidate(+btn.dataset.id));
  });
  list.querySelectorAll(".action-btn.delete-permanent").forEach(btn => {
    btn.addEventListener("click", () => deletePermanent(+btn.dataset.id));
  });
  list.querySelectorAll(".candidate-cb").forEach(cb => {
    cb.addEventListener("change", () => {
      const id = +cb.dataset.id;
      if (cb.checked) selectedIds.add(id);
      else selectedIds.delete(id);
      const card = cb.closest(".candidate-card");
      if (card) card.classList.toggle("selected", cb.checked);
      updateBulkPanel();
    });
  });
  list.querySelectorAll(".questions-toggle").forEach(btn => {
    btn.addEventListener("click", () => {
      const qList = document.getElementById(`q-${btn.dataset.id}`);
      const hidden = qList.classList.toggle("hidden");
      btn.textContent = hidden ? "▸ Вопросы по пробелам" : "▾ Вопросы по пробелам";
    });
  });
  list.querySelectorAll(".breakdown-toggle").forEach(btn => {
    btn.addEventListener("click", () => {
      const bd = document.getElementById(`bd-${btn.dataset.id}`);
      const hidden = bd.classList.toggle("hidden");
      btn.textContent = hidden ? "▸ Разбивка баллов" : "▾ Разбивка баллов";
    });
  });
  list.querySelectorAll(".resume-toggle").forEach(btn => {
    btn.addEventListener("click", () => {
      const rt = document.getElementById(`rt-${btn.dataset.id}`);
      const hidden = rt.classList.toggle("hidden");
      btn.textContent = hidden ? "▸ Полное резюме" : "▾ Полное резюме";
    });
  });
}

function buildCard(c) {
  const cat       = c.category || "pending";
  const questions = Array.isArray(c.questions) ? c.questions : [];
  const pros      = Array.isArray(c.pros) ? c.pros : [];
  const cons      = Array.isArray(c.cons) ? c.cons : [];
  const breakdown = Array.isArray(c.score_breakdown) ? c.score_breakdown : [];
  const statusLabel = {
    new: "", to_reject: "Помечен на отказ", to_huntflow: "Помечен в Huntflow",
    rejected: "Отказ отправлен", huntflow_sent: "Отправлен в Huntflow"
  }[c.status] || "";
  const checked = selectedIds.has(c.id) ? "checked" : "";

  const pcHtml = (pros.length || cons.length) ? (() => {
    const len = Math.max(pros.length, cons.length);
    const rows = Array.from({length: len}, (_, i) => `
      <div class="pct-row">
        <span class="pct-pro">${pros[i] ? escHtml(pros[i]) : ""}</span>
        <span class="pct-con">${cons[i] ? escHtml(cons[i]) : ""}</span>
      </div>`).join("");
    return `<div class="pros-cons-table">
      <div class="pct-header">
        <span class="pct-head-pro">+ Плюсы</span>
        <span class="pct-head-con">− Минусы</span>
      </div>
      ${rows}
    </div>`;
  })() : "";

  const breakdownHtml = breakdown.length ? `
    <button class="breakdown-toggle" data-id="${c.id}">▸ Разбивка баллов</button>
    <div class="breakdown-table hidden" id="bd-${c.id}">
      ${breakdown.map(b => {
        const pct = Math.round(b.score * 10);
        const cls = pct >= 70 ? "bd-good" : pct >= 40 ? "bd-mid" : "bd-bad";
        return `<div class="bd-row ${cls}">
          <span class="bd-criterion">${escHtml(b.criterion)}</span>
          <div class="bd-bar-wrap"><div class="bd-bar" style="width:${pct}%"></div></div>
          <span class="bd-score-badge">${b.score}<span class="bd-of">/10</span></span>
          <span class="bd-weight">×${b.weight}</span>
          ${b.note ? `<span class="bd-note">${escHtml(b.note)}</span>` : ""}
        </div>`;
      }).join("")}
    </div>` : "";

  return `
  <div class="candidate-card status-${c.status}${selectedIds.has(c.id) ? " selected" : ""}" data-id="${c.id}">
    <div class="card-select">
      <input type="checkbox" class="candidate-cb" data-id="${c.id}" ${checked} />
      <div class="score-badge ${cat}">${c.score ?? "—"}</div>
    </div>
    <div class="card-body">
      <div class="card-header">
        <span class="candidate-name">
          <a href="${escHtml(c.hh_url)}" target="_blank">${escHtml(c.name || "Кандидат")}</a>
        </span>
        <span class="category-badge ${cat}">${catLabel(cat)}</span>
        ${statusLabel ? `<span class="status-badge">${escHtml(statusLabel)}</span>` : ""}
        ${c.created_at ? `<span class="screened-at">🕐 ${formatDateTime(c.created_at)}</span>` : ""}
      </div>
      <div class="ai-assessment">
        ${c.summary ? `<p class="resume-summary">${escHtml(c.summary)}</p>` : ""}
        ${c.ai_comment ? `<p class="ai-comment">${escHtml(c.ai_comment)}</p>` : ""}
      </div>
      ${pcHtml}
      ${breakdownHtml}
      ${questions.length ? `
        <button class="questions-toggle" data-id="${c.id}">▸ Вопросы по пробелам</button>
        <ul class="questions-list hidden" id="q-${c.id}">
          ${questions.map(q => `<li>${escHtml(q)}</li>`).join("")}
        </ul>
      ` : ""}
      ${c.resume_text ? `
        <button class="resume-toggle" data-id="${c.id}">▸ Полное резюме</button>
        <div class="resume-full hidden" id="rt-${c.id}">${formatResumeHtml(c.resume_text)}</div>
      ` : ""}
    </div>
    <div class="card-actions">${buildActionButtons(c)}</div>
  </div>`;
}

function buildActionButtons(c) {
  if (viewMode === "trash") {
    return `
      <button class="action-btn restore-candidate" data-id="${c.id}">↩ Восстановить</button>
      <button class="action-btn delete-permanent" data-id="${c.id}">🗑 Удалить навсегда</button>
    `;
  }
  const deleteBtn = `<button class="action-btn delete-candidate" data-id="${c.id}">🗑 В корзину</button>`;
  if (c.status === "rejected")      return `<span style="font-size:12px;color:var(--text-muted)">Отказ отправлен</span>${deleteBtn}`;
  if (c.status === "huntflow_sent") return `<span style="font-size:12px;color:var(--text-muted)">В Huntflow ✓</span>${deleteBtn}`;
  if (c.status === "to_huntflow")   return `<button class="action-btn undo" data-id="${c.id}">✕ Отменить</button>${deleteBtn}`;
  if (c.status === "to_reject")     return `<button class="action-btn undo" data-id="${c.id}">✕ Отменить</button>${deleteBtn}`;
  return `
    <button class="action-btn to-huntflow" data-id="${c.id}">→ В Huntflow</button>
    <button class="action-btn to-reject"   data-id="${c.id}">✕ Отказать</button>
    ${deleteBtn}
  `;
}

// ── Actions ───────────────────────────────────────────────────────────────────

async function setStatus(id, status) {
  await fetch(`${API}/api/candidates/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ status }),
  });
  const candidate = allCandidates.find(c => c.id === id);
  if (candidate) candidate.status = status;
  renderCandidates();
  await loadStats();
}

async function deleteCandidate(id) {
  await fetch(`${API}/api/candidates/${id}`, { method: "DELETE" });
  allCandidates = allCandidates.filter(c => c.id !== id);
  selectedIds.delete(id);
  updateBulkPanel();
  renderCandidates();
  await loadStats();
}

async function restoreCandidate(id) {
  await fetch(`${API}/api/candidates/${id}/restore`, { method: "POST" });
  allCandidates = allCandidates.filter(c => c.id !== id);
  selectedIds.delete(id);
  updateBulkPanel();
  renderCandidates();
  await loadStats();
}

async function deletePermanent(id) {
  if (!confirm("Удалить кандидата навсегда? Это действие нельзя отменить.")) return;
  await fetch(`${API}/api/candidates/${id}/permanent`, { method: "DELETE" });
  allCandidates = allCandidates.filter(c => c.id !== id);
  selectedIds.delete(id);
  updateBulkPanel();
  renderCandidates();
}

async function bulkActionSelected(action) {
  const ids = [...selectedIds];
  if (!ids.length) return;
  await fetch(`${API}/api/candidates/bulk`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ids, action }),
  });
  await loadCandidates();
  if (action !== "delete") await loadStats();
}

function updateBulkPanel() {
  const panel = document.getElementById("bulk-panel");
  const count = document.getElementById("bulk-count");
  const n = selectedIds.size;
  panel.classList.toggle("hidden", n === 0);
  count.textContent = `Выбрано: ${n}`;

  const inTrash = viewMode === "trash";
  document.getElementById("btn-bulk-to-reject").classList.toggle("hidden", inTrash);
  document.getElementById("btn-bulk-trash").classList.toggle("hidden", inTrash);
  document.getElementById("btn-bulk-rescreen").classList.toggle("hidden", inTrash);
  document.getElementById("btn-empty-trash").classList.toggle("hidden", !inTrash);
}

async function exportToExcel() {
  if (!currentVacancyId) return;
  const btn = document.getElementById("btn-export");
  btn.textContent = "Готовим...";
  btn.disabled = true;
  try {
    const res = await fetch(`${API}/api/vacancies/${currentVacancyId}/export`);
    if (!res.ok) { alert("Ошибка при экспорте"); return; }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    const title = (currentVacancy?.title || `вакансия_${currentVacancyId}`)
      .replace(/[\\/:*?"<>|]/g, "_");
    a.href = url;
    a.download = `Скрининг_${title}.xlsx`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  } finally {
    btn.textContent = "↓ Экспорт в Excel";
    btn.disabled = false;
  }
}

async function bulkMarkForHuntflow() {
  if (!currentVacancyId) return;
  const count = allCandidates.filter(c => c.category === "suitable" && c.status === "new").length;
  if (count === 0) { alert("Нет новых кандидатов категории «Подходят»"); return; }
  if (!confirm(`Пометить ${count} кандидата(ов) для добавления в Huntflow?`)) return;
  await fetch(`${API}/api/vacancies/${currentVacancyId}/mark-for-huntflow`, { method: "POST" });
  await refreshData();
}

async function bulkTrashAllReject() {
  if (!currentVacancyId) return;
  const ids = allCandidates
    .filter(c => c.category === "reject" && c.status === "new")
    .map(c => c.id);
  if (ids.length === 0) { alert("Нет новых кандидатов категории «Отказ»"); return; }
  if (!confirm(`Отправить ${ids.length} кандидата(ов) категории «Отказ» в корзину?`)) return;
  await fetch(`${API}/api/candidates/bulk`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ids, action: "delete" }),
  });
  await refreshData();
}

async function bulkMarkForReject() {
  if (!currentVacancyId) return;
  const count = allCandidates.filter(c => c.category === "reject" && c.status === "new").length;
  if (count === 0) { alert("Нет новых кандидатов категории «Отказ»"); return; }
  if (!confirm(`Пометить ${count} кандидата(ов) на отказ в HH?`)) return;
  await fetch(`${API}/api/vacancies/${currentVacancyId}/mark-for-reject`, { method: "POST" });
  await refreshData();
}

// ── Listeners ─────────────────────────────────────────────────────────────────

function setupListeners() {
  document.getElementById("vacancy-select").addEventListener("change", async e => {
    const id = e.target.value;
    stopSummaryPoll();
    stopBooleanPoll();
    stopMetricsPoll();
    if (id) {
      await selectVacancy(parseInt(id));
    } else {
      currentVacancyId = null;
      currentVacancy = null;
      document.getElementById("vacancy-panel").classList.add("hidden");
      document.getElementById("app").classList.add("hidden");
      document.getElementById("no-vacancy-state").classList.remove("hidden");
    }
  });

  document.getElementById("btn-new-vacancy").addEventListener("click",    openNewVacancyForm);
  document.getElementById("btn-edit-vacancy").addEventListener("click",   openEditVacancyForm);
  document.getElementById("btn-delete-vacancy").addEventListener("click", deleteVacancy);
  document.getElementById("btn-save-vacancy").addEventListener("click",   saveVacancy);
  document.getElementById("btn-cancel-vacancy").addEventListener("click", closeVacancyForm);
  document.getElementById("btn-load-url").addEventListener("click",       loadVacancyFromUrl);
  document.getElementById("btn-regen-summary").addEventListener("click",  () => {
    document.getElementById("vf-requirements").value = "";
    document.getElementById("vf-requirements").placeholder = "⏳ AI сформирует заново после сохранения...";
  });

  document.getElementById("btn-toggle-desc").addEventListener("click", () => {
    const wrap = document.getElementById("vp-desc-wrap");
    const btn  = document.getElementById("btn-toggle-desc");
    const hidden = wrap.classList.toggle("hidden");
    btn.textContent = hidden ? "▾ Описание" : "▴ Описание";
  });

  document.getElementById("btn-metrics-info").addEventListener("click", () => {
    document.getElementById("metrics-info-modal").classList.remove("hidden");
  });
  document.getElementById("metrics-info-close").addEventListener("click", () => {
    document.getElementById("metrics-info-modal").classList.add("hidden");
  });
  document.getElementById("metrics-info-modal").addEventListener("click", e => {
    if (e.target === e.currentTarget) e.currentTarget.classList.add("hidden");
  });

  document.getElementById("btn-toggle-metrics").addEventListener("click", async () => {
    const section = document.getElementById("metrics-section");
    const wasHidden = section.classList.contains("hidden");
    section.classList.toggle("hidden");
    if (wasHidden && currentVacancyId) {
      await loadMetrics(currentVacancyId);
      if (currentMetrics.length === 0) {
        regenMetrics();
      }
    }
  });
  document.getElementById("btn-regen-metrics").addEventListener("click", regenMetrics);
  document.getElementById("btn-save-metrics").addEventListener("click", saveMetrics);
  document.getElementById("btn-show-add-metric").addEventListener("click", () => {
    document.getElementById("metrics-add-row").classList.remove("hidden");
    document.getElementById("btn-show-add-metric").classList.add("hidden");
    document.getElementById("metrics-new-name").focus();
  });
  document.getElementById("btn-add-metric").addEventListener("click", addMetric);
  document.getElementById("metrics-new-name").addEventListener("keydown", e => {
    if (e.key === "Enter") addMetric();
    if (e.key === "Escape") {
      document.getElementById("metrics-add-row").classList.add("hidden");
      document.getElementById("btn-show-add-metric").classList.remove("hidden");
    }
  });

  document.getElementById("btn-toggle-boolean").addEventListener("click", () => {
    const section = document.getElementById("boolean-section");
    const wasHidden = section.classList.contains("hidden");
    section.classList.toggle("hidden");
    if (wasHidden && currentVacancy && !currentVacancy.boolean_search) {
      generateBoolean();
    }
  });

  document.getElementById("btn-regen-boolean").addEventListener("click", generateBoolean);

  document.querySelectorAll(".filter-btn").forEach(btn => {
    btn.addEventListener("click", async () => {
      document.querySelectorAll(".filter-btn").forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      const filter = btn.dataset.filter;
      if (filter === "trash") {
        viewMode = "trash";
        activeFilter = "all";
        await loadCandidates();
      } else {
        if (viewMode === "trash") {
          viewMode = "main";
          await loadCandidates();
        }
        activeFilter = filter;
        renderCandidates();
      }
    });
  });

  document.getElementById("score-min").addEventListener("input", e => {
    scoreMin = parseInt(e.target.value) || 0;
    renderCandidates();
  });
  document.getElementById("score-max").addEventListener("input", e => {
    scoreMax = parseInt(e.target.value) ?? 100;
    renderCandidates();
  });

  document.getElementById("sort-select").addEventListener("change", e => {
    activeSort = e.target.value;
    renderCandidates();
  });

  document.getElementById("btn-bulk-huntflow").addEventListener("click", bulkMarkForHuntflow);
  document.getElementById("btn-bulk-reject").addEventListener("click",   bulkMarkForReject);
  document.getElementById("btn-export").addEventListener("click",        exportToExcel);
  document.getElementById("btn-rescreen-all").addEventListener("click", () => {
    if (!currentVacancyId) return;
    const n = allCandidates.filter(c => !c.is_trashed).length;
    if (n === 0) { alert("Нет кандидатов для перескрининга"); return; }
    if (!confirm(`Переоценить всех ${n} кандидатов по текущим метрикам?`)) return;
    startRescreen(null);
  });
  document.getElementById("btn-bulk-rescreen").addEventListener("click", () => {
    const ids = [...selectedIds];
    if (!ids.length) return;
    if (!confirm(`Переоценить ${ids.length} выбранных кандидатов по текущим метрикам?`)) return;
    startRescreen(ids);
  });
  document.getElementById("btn-refresh").addEventListener("click", async () => {
    const btn = document.getElementById("btn-refresh");
    btn.textContent = "↻ Загрузка...";
    btn.disabled = true;
    try { await refreshData(); } finally {
      btn.textContent = "↻ Обновить";
      btn.disabled = false;
    }
  });

  document.getElementById("btn-select-all").addEventListener("click", () => {
    const list = document.getElementById("candidates-list");
    list.querySelectorAll(".candidate-cb").forEach(cb => {
      cb.checked = true;
      selectedIds.add(+cb.dataset.id);
      cb.closest(".candidate-card")?.classList.add("selected");
    });
    updateBulkPanel();
  });
  document.getElementById("btn-bulk-to-reject").addEventListener("click", () => bulkActionSelected("to_reject"));
  document.getElementById("btn-bulk-trash").addEventListener("click",     () => bulkActionSelected("delete"));
  document.getElementById("btn-bulk-trash-all").addEventListener("click", bulkTrashAllReject);
  document.getElementById("btn-bulk-deselect").addEventListener("click",  () => {
    selectedIds.clear();
    updateBulkPanel();
    renderCandidates();
  });
  document.getElementById("btn-empty-trash").addEventListener("click", async () => {
    if (!confirm("Навсегда удалить всех кандидатов из корзины?")) return;
    await fetch(`${API}/api/vacancies/${currentVacancyId}/trash`, { method: "DELETE" });
    await loadCandidates();
  });

  document.getElementById("modal-close").addEventListener("click", () => {
    document.getElementById("modal-overlay").classList.add("hidden");
  });
  document.getElementById("modal-overlay").addEventListener("click", e => {
    if (e.target === e.currentTarget) e.currentTarget.classList.add("hidden");
  });

  // API key modal
  document.getElementById("btn-api-settings").addEventListener("click", () => {
    const key = getApiKey();
    const input = document.getElementById("api-key-input");
    input.type = "password";
    input.value = key || "";
    document.getElementById("btn-eye-api").textContent = "👁";
    document.getElementById("api-key-modal").classList.remove("hidden");
  });
  document.getElementById("api-key-modal-close").addEventListener("click", () => {
    document.getElementById("api-key-modal").classList.add("hidden");
  });
  document.getElementById("btn-cancel-api-key").addEventListener("click", () => {
    document.getElementById("api-key-modal").classList.add("hidden");
  });
  document.getElementById("btn-eye-api").addEventListener("click", () => {
    const input = document.getElementById("api-key-input");
    const btn   = document.getElementById("btn-eye-api");
    const isHidden = input.type === "password";
    input.type = isHidden ? "text" : "password";
    btn.textContent = isHidden ? "🙈" : "👁";
  });
  document.getElementById("btn-save-api-key").addEventListener("click", () => {
    const val = document.getElementById("api-key-input").value.trim();
    if (!val) { alert("Введите API ключ"); return; }
    localStorage.setItem("geminiApiKey", val);
    document.getElementById("api-key-modal").classList.add("hidden");
    alert("Ключ сохранён");
  });
  document.getElementById("btn-clear-api-key").addEventListener("click", () => {
    if (!confirm("Удалить API ключ?")) return;
    localStorage.removeItem("geminiApiKey");
    document.getElementById("api-key-modal").classList.add("hidden");
  });
}

// ── Toast ─────────────────────────────────────────────────────────────────────

function showToast(msg, type = "success") {
  const el = document.createElement("div");
  el.className = `toast toast-${type}`;
  el.textContent = msg;
  document.body.appendChild(el);
  requestAnimationFrame(() => el.classList.add("show"));
  setTimeout(() => {
    el.classList.remove("show");
    setTimeout(() => el.remove(), 350);
  }, 3500);
}

// ── Rescreen ──────────────────────────────────────────────────────────────────

function stopRescreenPoll() {
  if (rescreenPollTimer) { clearInterval(rescreenPollTimer); rescreenPollTimer = null; }
}

async function startRescreen(candidateIds) {
  if (!currentVacancyId) return;

  const body = candidateIds ? { candidate_ids: candidateIds } : {};
  const expectedTotal = candidateIds ? candidateIds.length : allCandidates.length;

  const res = await fetch(`${API}/api/vacancies/${currentVacancyId}/rescreen`, {
    method: "POST",
    headers: apiHeaders(),
    body: JSON.stringify(body),
  });

  if (res.status === 409) {
    showToast("Перескрининг уже запущен, подождите.", "warn");
    return;
  }
  if (!res.ok) {
    showToast("Не удалось запустить перескрининг", "error");
    return;
  }

  const data = await res.json();
  if (data.total === 0) { showToast("Нет кандидатов для перескрининга", "warn"); return; }

  showRescreenProgress(0, data.total || expectedTotal);
  startRescreenPoll(currentVacancyId, data.total || expectedTotal);
}

function showRescreenProgress(done, total) {
  const wrap = document.getElementById("rescreen-progress");
  const bar  = document.getElementById("rescreen-bar");
  const pct  = document.getElementById("rescreen-progress-pct");
  const txt  = document.getElementById("rescreen-progress-text");

  wrap.classList.remove("hidden");
  const p = total > 0 ? Math.round(done / total * 100) : 0;
  bar.style.width = p + "%";
  pct.textContent = p + "%";
  txt.textContent = `Перескрининг: ${done} / ${total}`;
}

function hideRescreenProgress() {
  document.getElementById("rescreen-progress").classList.add("hidden");
}

function startRescreenPoll(vacancyId, expectedTotal) {
  stopRescreenPoll();
  let lastDone = 0;
  let staleCount = 0;

  rescreenPollTimer = setInterval(async () => {
    if (currentVacancyId !== vacancyId) { stopRescreenPoll(); hideRescreenProgress(); return; }
    try {
      const res = await fetch(`${API}/api/vacancies/${vacancyId}/rescreen/status`);
      if (!res.ok) return;
      const s = await res.json();

      // Пока задача ещё не инициализировала прогресс — показываем ожидание
      const total = s.total > 0 ? s.total : expectedTotal;
      showRescreenProgress(s.done, total);

      // Детектируем завершение: running=false И total>0
      if (!s.running && s.total > 0) {
        stopRescreenPoll();
        hideRescreenProgress();
        await refreshData();
        const updated = s.done - s.errors;
        if (s.errors > 0) {
          showToast(`Перескрининг завершён: обновлено ${updated}, ошибок ${s.errors}`, "warn");
        } else {
          showToast(`✓ Перескрининг завершён: обновлено ${updated} кандидатов`);
        }
        return;
      }

      // Защита от зависания: если done не растёт 30 секунд — принудительно обновляем
      if (s.done === lastDone) {
        staleCount++;
        if (staleCount >= 15) {
          stopRescreenPoll();
          hideRescreenProgress();
          await refreshData();
          showToast("Перескрининг завершён (таймаут)", "warn");
        }
      } else {
        lastDone = s.done;
        staleCount = 0;
      }
    } catch { /* ignore */ }
  }, 2000);
}

// ── Utils ─────────────────────────────────────────────────────────────────────

function escHtml(str) {
  return String(str ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function catLabel(cat) {
  return { suitable: "Подходит", consider: "Подумать", reject: "Отказ", pending: "Ожидание" }[cat] || cat;
}

function formatDateTime(str) {
  if (!str) return "";
  const d = new Date(str.includes("T") || str.includes("Z") ? str : str + "Z");
  if (isNaN(d)) return str;
  return d.toLocaleString("ru-RU", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });
}
