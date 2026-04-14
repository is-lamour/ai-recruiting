const API = "";  // same origin
let currentVacancyId = null;
let allCandidates = [];
let activeFilter = "all";

// ── Init ──────────────────────────────────────────────────────────────────────

document.addEventListener("DOMContentLoaded", async () => {
  await loadVacancies();
  setupListeners();

  // Если в URL есть vacancy=ID — автовыбор
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
  const vacancies = await res.json();

  const sel = document.getElementById("vacancy-select");
  vacancies.forEach(v => {
    const opt = document.createElement("option");
    opt.value = v.id;
    opt.textContent = v.title;
    sel.appendChild(opt);
  });
}

async function selectVacancy(id) {
  currentVacancyId = id;
  document.getElementById("no-vacancy-state").classList.add("hidden");
  document.getElementById("app").classList.remove("hidden");
  await refreshData();
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
  const list = document.getElementById("candidates-list");
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

  // Attach listeners
  list.querySelectorAll(".action-btn.to-huntflow").forEach(btn => {
    btn.addEventListener("click", () => setStatus(+btn.dataset.id, "to_huntflow"));
  });
  list.querySelectorAll(".action-btn.to-reject").forEach(btn => {
    btn.addEventListener("click", () => setStatus(+btn.dataset.id, "to_reject"));
  });
  list.querySelectorAll(".action-btn.undo").forEach(btn => {
    btn.addEventListener("click", () => setStatus(+btn.dataset.id, "new"));
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

  const actionBtns = buildActionButtons(c);

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
      <p class="ai-comment">${escHtml(c.ai_comment || "")}</p>
      ${questions.length ? `
        <button class="questions-toggle" data-id="${c.id}">▸ Вопросы по пробелам</button>
        <ul class="questions-list hidden" id="q-${c.id}">
          ${questions.map(q => `<li>${escHtml(q)}</li>`).join("")}
        </ul>
      ` : ""}
    </div>
    <div class="card-actions">${actionBtns}</div>
  </div>`;
}

function buildActionButtons(c) {
  if (c.status === "rejected") {
    return `<span style="font-size:12px;color:var(--text-muted)">Отказ отправлен</span>`;
  }
  if (c.status === "huntflow_sent") {
    return `<span style="font-size:12px;color:var(--text-muted)">В Huntflow ✓</span>`;
  }
  if (c.status === "to_huntflow") {
    return `<button class="action-btn undo" data-id="${c.id}">✕ Отменить</button>`;
  }
  if (c.status === "to_reject") {
    return `<button class="action-btn undo" data-id="${c.id}">✕ Отменить</button>`;
  }
  // status === "new"
  return `
    <button class="action-btn to-huntflow" data-id="${c.id}">→ В Huntflow</button>
    <button class="action-btn to-reject"   data-id="${c.id}">✕ Отказать</button>
  `;
}

// ── Actions ───────────────────────────────────────────────────────────────────

async function setStatus(id, status) {
  await fetch(`${API}/api/candidates/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ status }),
  });
  // Обновить локально без перезагрузки всего списка
  const candidate = allCandidates.find(c => c.id === id);
  if (candidate) candidate.status = status;
  renderCandidates();
  await loadStats();
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
    if (id) {
      await selectVacancy(parseInt(id));
    } else {
      currentVacancyId = null;
      document.getElementById("app").classList.add("hidden");
      document.getElementById("no-vacancy-state").classList.remove("hidden");
    }
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
  document.getElementById("btn-bulk-reject").addEventListener("click", bulkMarkForReject);

  document.getElementById("modal-close").addEventListener("click", () => {
    document.getElementById("modal-overlay").classList.add("hidden");
  });
  document.getElementById("modal-overlay").addEventListener("click", e => {
    if (e.target === e.currentTarget) e.currentTarget.classList.add("hidden");
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
