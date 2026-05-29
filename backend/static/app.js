const API = "";  // same origin

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
let editingVacancyId = null;
let summaryPollTimer = null;

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
}

async function loadCandidates() {
  const res = await fetch(`${API}/api/vacancies/${currentVacancyId}/candidates`);
  allCandidates = await res.json();
  renderCandidates();
}

// ── Render ────────────────────────────────────────────────────────────────────

function renderCandidates() {
  const list  = document.getElementById("candidates-list");
  const empty = document.getElementById("empty-filter-state");

  let filtered = allCandidates;
  if (activeFilter !== "all") {
    filtered = allCandidates.filter(c => c.category === activeFilter);
  }

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
  list.querySelectorAll(".questions-toggle").forEach(btn => {
    btn.addEventListener("click", () => {
      const qList = document.getElementById(`q-${btn.dataset.id}`);
      const hidden = qList.classList.toggle("hidden");
      btn.textContent = hidden ? "▸ Вопросы по пробелам" : "▾ Вопросы по пробелам";
    });
  });
}

function buildCard(c) {
  const cat = c.category || "pending";
  const questions = Array.isArray(c.questions) ? c.questions : [];
  const statusLabel = {
    new: "", to_reject: "Помечен на отказ", to_huntflow: "Помечен в Huntflow",
    rejected: "Отказ отправлен", huntflow_sent: "Отправлен в Huntflow"
  }[c.status] || "";

  return `
  <div class="candidate-card status-${c.status}" data-id="${c.id}">
    <div class="score-badge ${cat}">${c.score ?? "—"}</div>
    <div class="card-body">
      <div class="card-header">
        <span class="candidate-name">
          <a href="${escHtml(c.hh_url)}" target="_blank">${escHtml(c.name || "Кандидат")}</a>
        </span>
        <span class="category-badge ${cat}">${catLabel(cat)}</span>
        ${statusLabel ? `<span class="status-badge">${escHtml(statusLabel)}</span>` : ""}
      </div>
      ${c.summary ? `<p class="resume-summary">${escHtml(c.summary)}</p>` : ""}
      <p class="ai-comment">${escHtml(c.ai_comment || "")}</p>
      ${questions.length ? `
        <button class="questions-toggle" data-id="${c.id}">▸ Вопросы по пробелам</button>
        <ul class="questions-list hidden" id="q-${c.id}">
          ${questions.map(q => `<li>${escHtml(q)}</li>`).join("")}
        </ul>
      ` : ""}
    </div>
    <div class="card-actions">${buildActionButtons(c)}</div>
  </div>`;
}

function buildActionButtons(c) {
  const deleteBtn = `<button class="action-btn delete-candidate" data-id="${c.id}">🗑 Удалить</button>`;
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
  const candidate = allCandidates.find(c => c.id === id);
  const name = candidate?.name || "кандидата";
  if (!confirm(`Удалить ${name}?`)) return;
  await fetch(`${API}/api/candidates/${id}`, { method: "DELETE" });
  allCandidates = allCandidates.filter(c => c.id !== id);
  renderCandidates();
  await loadStats();
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

  document.getElementById("btn-toggle-desc").addEventListener("click", () => {
    const wrap = document.getElementById("vp-desc-wrap");
    const btn  = document.getElementById("btn-toggle-desc");
    const hidden = wrap.classList.toggle("hidden");
    btn.textContent = hidden ? "▾ Описание" : "▴ Описание";
  });

  document.querySelectorAll(".filter-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".filter-btn").forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      activeFilter = btn.dataset.filter;
      renderCandidates();
    });
  });

  document.getElementById("btn-bulk-huntflow").addEventListener("click", bulkMarkForHuntflow);
  document.getElementById("btn-bulk-reject").addEventListener("click",   bulkMarkForReject);
  document.getElementById("btn-export").addEventListener("click",        exportToExcel);

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

// ── Utils ─────────────────────────────────────────────────────────────────────

function escHtml(str) {
  return String(str ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function catLabel(cat) {
  return { suitable: "Подходит", consider: "Подумать", reject: "Отказ", pending: "Ожидание" }[cat] || cat;
}
