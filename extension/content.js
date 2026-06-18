// Content script — hh.kz
// Прогресс передаётся через chrome.storage.session (надёжнее для долгих операций в MV3)

let screeningActive = false;
let cachedLinks = null;
let cachedLinksUrl = null;
let cachedLinksMaxPages = null;

// Сбрасываем зависший прогресс при перезагрузке страницы
chrome.runtime.sendMessage({ action: "save_progress", data: { active: false } }, () => {
  if (chrome.runtime.lastError) { /* ignore */ }
});

// ── API helpers (через background, обход CORS) ────────────────────────────────

function bgGet(path) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ action: "api_get", path }, res => {
      if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
      if (!res?.ok) return reject(new Error(`API ${res?.status}`));
      resolve(res.data);
    });
  });
}

function bgPost(path, body) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ action: "api_post", path, body }, res => {
      if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
      if (!res?.ok) return reject(new Error(`API ${res?.status}: ${JSON.stringify(res?.data)}`));
      resolve(res.data);
    });
  });
}

function bgPatch(path, body) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ action: "api_patch", path, body }, res => {
      if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
      resolve(res?.data);
    });
  });
}

function saveProgress(data) {
  chrome.runtime.sendMessage({ action: "save_progress", data }, () => {
    if (chrome.runtime.lastError) { /* ignore */ }
  });
}

function isCancelled() {
  return new Promise(r =>
    chrome.runtime.sendMessage({ action: "is_cancelled" }, res => {
      if (chrome.runtime.lastError) r(false);
      else r(!!res?.cancelled);
    })
  );
}

function resetCancel() {
  return new Promise(r =>
    chrome.runtime.sendMessage({ action: "reset_cancel" }, () => {
      if (chrome.runtime.lastError) { /* ignore */ }
      r();
    })
  );
}

// ── Сообщения от popup ────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  switch (message.action) {

    case "start_screening":
      if (screeningActive) {
        sendResponse({ error: "Скрининг уже запущен" });
        return;
      }
      // Отвечаем СРАЗУ — не держим канал открытым (MV3 ограничение ~5 мин)
      sendResponse({ status: "started" });
      startScreening(message.vacancyId, message.maxPages); // fire-and-forget, прогресс через storage
      return;

    case "execute_rejections":
      executeRejections(message.candidates, sendResponse);
      return true; // короткая операция, держим канал

    case "diagnose":
      diagnose().then(sendResponse);
      return true;
  }
});

// ── Диагностика ───────────────────────────────────────────────────────────────

async function diagnose() {
  const hashes = new Set();
  document.querySelectorAll('a[href*="/resume/"]').forEach(el => {
    const href = el.getAttribute("href") || "";
    const match = href.match(/\/resume\/([a-f0-9]{32,})/);
    if (match) hashes.add(match[1]);
  });
  const cards = { length: hashes.size };

  // Определяем общее число страниц из пейджера
  let totalPages = 1;
  document.querySelectorAll('[data-qa="pager-page"]').forEach(el => {
    const n = parseInt(el.textContent.trim(), 10);
    if (!isNaN(n) && n > totalPages) totalPages = n;
  });
  // Если пейджер не найден — пробуем через page= в ссылках (нумерация с 0)
  if (totalPages === 1) {
    document.querySelectorAll('a[href*="page="]').forEach(el => {
      const m = el.href.match(/[?&]page=(\d+)/);
      if (m) {
        const n = parseInt(m[1], 10) + 1;
        if (n > totalPages) totalPages = n;
      }
    });
  }
  // Если есть кнопка "следующая" — точно больше 1 страницы
  if (totalPages === 1 && findNextPageButton()) totalPages = 2;

  return {
    url: window.location.href,
    linksFound: cards.length,
    shellsInDOM: cards.length,
    totalPages,
    pageTitle: document.title,
  };
}

// ── Скрининг ──────────────────────────────────────────────────────────────────

class CaptchaError extends Error {
  constructor() { super("captcha"); this.name = "CaptchaError"; }
}

async function startScreening(vacancyId, maxPages) {
  screeningActive = true;
  await resetCancel();

  let processed = 0, errors = 0, skipped = 0;
  const captchaQueue = [];

  try {
    // Уже скринированные — пропускаем
    let alreadyScreened = new Set();
    try {
      const screened = await bgGet(`/api/vacancies/${vacancyId}/screened-urls`);
      alreadyScreened = new Set(screened);
    } catch { /* ignore */ }

    if (!cachedLinks || cachedLinksUrl !== window.location.href || cachedLinksMaxPages !== maxPages) {
      cachedLinks = await collectAllResumeLinks(maxPages);
      cachedLinksUrl = window.location.href;
      cachedLinksMaxPages = maxPages;
    }
    const links = cachedLinks;

    if (links.length === 0) {
      saveProgress({ active: false, done: true, error: "Резюме не найдены", vacancyId });
      return;
    }

    const newLinks = links.filter(l => !alreadyScreened.has(l.storeUrl));
    skipped = links.length - newLinks.length;
    const total = newLinks.length;

    if (total === 0) {
      saveProgress({ active: false, done: true, processed: 0, errors: 0, skipped, total: 0, vacancyId, allSkipped: true });
      return;
    }

    saveProgress({ active: true, current: 0, total, skipped, vacancyId, name: "" });

    // Основной проход: батчи по 3 с stagger 400ms внутри батча
    const BATCH_SIZE = 3;
    const STAGGER_MS = 400;

    for (let i = 0; i < newLinks.length; i += BATCH_SIZE) {
      if (await isCancelled()) {
        console.log("[HH Screen] Остановлено пользователем");
        break;
      }

      const batch = newLinks.slice(i, i + BATCH_SIZE);
      await Promise.all(batch.map(async (link, batchIndex) => {
        if (batchIndex > 0) await sleep(batchIndex * STAGGER_MS);
        try {
          const resumeData = await fetchResumeData(link.fetchUrl);
          await bgPost("/api/screen", {
            vacancy_id: vacancyId,
            name: link.name || resumeData.name || "Кандидат",
            hh_url: link.storeUrl,
            resume_text: resumeData.text,
          });
          processed++;
        } catch (e) {
          if (e.message === "HH требует авторизации") {
            console.warn("[HH Screen] Авторизация истекла:", link.storeUrl);
            errors++;
          } else {
            console.warn("[HH Screen] Откладываем на повтор:", link.storeUrl, e.message);
            captchaQueue.push(link);
          }
        }
        saveProgress({ active: true, current: processed + errors, total, skipped, vacancyId, name: link.name || "" });
      }));
    }

    // Повторный проход для всех неудавшихся кандидатов — последовательно с большим интервалом
    if (captchaQueue.length > 0 && !(await isCancelled())) {
      console.log(`[HH Screen] Повторная обработка: ${captchaQueue.length} кандидатов`);
      await sleep(4000);

      for (const link of captchaQueue) {
        if (await isCancelled()) break;
        try {
          const resumeData = await fetchResumeData(link.fetchUrl);
          await bgPost("/api/screen", {
            vacancy_id: vacancyId,
            name: link.name || resumeData.name || "Кандидат",
            hh_url: link.storeUrl,
            resume_text: resumeData.text,
          });
          processed++;
        } catch (e) {
          console.warn("[HH Screen] Повтор не удался:", link.storeUrl, e.message);
          errors++;
        }
        saveProgress({ active: true, current: processed + errors, total, skipped, vacancyId, name: link.name || "" });
        await sleep(3500);
      }
    }

  } catch (e) {
    console.error("[HH Screen] Критическая ошибка:", e);
  } finally {
    screeningActive = false;
    await resetCancel();
    saveProgress({ active: false, done: true, processed, errors, skipped, total: processed + errors, vacancyId });
  }
}

// ── Сбор ссылок ───────────────────────────────────────────────────────────────

async function collectAllResumeLinks(maxPages) {
  const params = new URLSearchParams(window.location.search);
  // Страница откликов: vacancyId; холодный поиск: context_predicted_vacancy_id
  const vacancyId =
    params.get("vacancyId") ||
    params.get("context_predicted_vacancy_id") ||
    "";
  const links = [];
  const seen = new Set();
  const divider = findSuggestedDivider();

  // Основной путь: берём все <a href="/resume/{hash}..."> без скролла.
  // Сначала проходим по заголовкам (data-qa="serp-item__title") — они несут имя кандидата,
  // затем по всем остальным ссылкам (аватар и т.д.) чтобы не пропустить резюме без заголовка.
  const nameMap = {};
  document.querySelectorAll('[data-qa="serp-item__title"]').forEach(el => {
    const href = el.getAttribute("href") || "";
    const match = href.match(/\/resume\/([a-f0-9]{32,})/);
    if (!match) return;
    nameMap[match[1]] = el.textContent?.trim() || "";
  });

  document.querySelectorAll('a[href*="/resume/"]').forEach(el => {
    if (divider && !isBeforeDivider(el, divider)) return;
    const href = el.getAttribute("href") || "";
    const match = href.match(/\/resume\/([a-f0-9]{32,})/);
    if (!match) return;
    const hash = match[1];
    if (seen.has(hash)) return;
    seen.add(hash);
    const cleanUrl = `${window.location.origin}/resume/${hash}`;
    const fetchUrl = vacancyId ? `${cleanUrl}?vacancyId=${vacancyId}` : cleanUrl;
    const name = nameMap[hash] || el.textContent?.trim() || "";
    links.push({ fetchUrl, storeUrl: cleanUrl, name });
  });

  console.log(`[HH Screen] DOM собрал ${links.length} резюме`);

  // Fallback: fetch по страницам если DOM ничего не дал
  if (links.length === 0) {
    const pageLimit = (maxPages && maxPages > 0) ? maxPages : 20;
    console.warn("[HH Screen] DOM пустой, пробуем fetch по страницам");
    try {
      const base = new URL(window.location.href);
      let page = 0;
      while (page < pageLimit) {
        base.searchParams.set('page', page);
        const html = await fetch(base.toString(), { credentials: 'include' }).then(r => r.text());
        const hashes = [...html.matchAll(/href="\/resume\/([a-f0-9]{32,})/g)].map(m => m[1]);
        if (hashes.length === 0) break;
        let added = 0;
        hashes.forEach(hash => {
          if (seen.has(hash)) return;
          seen.add(hash);
          const cleanUrl = `${window.location.origin}/resume/${hash}`;
          const fetchUrl = vacancyId ? `${cleanUrl}?vacancyId=${vacancyId}` : cleanUrl;
          links.push({ fetchUrl, storeUrl: cleanUrl, name: "" });
          added++;
        });
        if (added === 0) break;
        page++;
      }
      console.log(`[HH Screen] fetch собрал ${links.length} резюме`);
    } catch (e) {
      console.error("[HH Screen] fetch тоже упал:", e);
    }
  }

  return links;
}

function findSuggestedDivider() {
  // Ищем заголовок "Подходящие резюме, подобранные по параметрам вакансии"
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) {
    if (/подходящие резюме.*параметрам/i.test(walker.currentNode.textContent)) {
      return walker.currentNode.parentElement;
    }
  }
  return null;
}

function isBeforeDivider(el, divider) {
  if (!divider) return true;
  // DOCUMENT_POSITION_PRECEDING (2) — el стоит раньше divider в DOM
  return !!(divider.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_PRECEDING);
}

function getLinksFromDOM() {
  const links = [];
  const seen  = new Set();
  const divider = findSuggestedDivider();

  const selectors = [
    "[data-qa~='serp-item__title']",
    "[data-qa='resume-serp__title-link']",
    "[data-qa='vacancy-response-item__candidate-link']",
    "[data-qa='resume__name']",
    "a[href*='/resume/']",
  ];

  for (const sel of selectors) {
    document.querySelectorAll(sel).forEach(el => {
      const href = el.getAttribute("href") || "";
      if (!href.includes("/resume/")) return;
      if (!isBeforeDivider(el, divider)) return;

      const fullUrl  = href.startsWith("http") ? href : window.location.origin + href;
      const cleanUrl = fullUrl.split("?")[0].split("#")[0];
      if (seen.has(cleanUrl)) return;
      seen.add(cleanUrl);

      links.push({ fetchUrl: fullUrl, storeUrl: cleanUrl, name: el.textContent?.trim() || "" });
    });
    if (links.length > 0) break;
  }
  return links;
}


function findNextPageButton() {
  return (
    document.querySelector("[data-qa='pager-next']") ||
    document.querySelector(".pager__item_next a")     ||
    document.querySelector("a[rel='next']")            ||
    null
  );
}

// ── Загрузка резюме ───────────────────────────────────────────────────────────

async function fetchResumeData(url) {
  const res = await fetch(url, { credentials: "include" });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);

  const html = await res.text();
  const doc  = new DOMParser().parseFromString(html, "text/html");

  if (doc.querySelector('form[action*="login"]') || doc.title.includes("Вход")) {
    throw new Error("HH требует авторизации");
  }

  const bodyText = doc.body?.textContent || "";
  if (
    /не[\s ]+робот/i.test(doc.title) ||
    /captcha/i.test(doc.title) ||
    doc.querySelector('form[action*="captcha"]') ||
    /подтвердите.*не[\s ]+робот/i.test(bodyText)
  ) {
    throw new CaptchaError();
  }

  return extractResumeData(doc);
}

function extractResumeData(doc) {
  const name =
    doc.querySelector("[data-qa='resume-personal-name']")?.textContent?.trim() ||
    doc.querySelector(".resume-header__name")?.textContent?.trim()             ||
    doc.querySelector("h1")?.textContent?.trim()                               ||
    "";

  const blockSelectors = [
    "[data-qa='resume-block-title-block']",
    "[data-qa='resume-block-experience']",
    "[data-qa='resume-block-education']",
    "[data-qa='resume-block-skills-item']",
    "[data-qa='resume-block-languages']",
    "[data-qa='resume-block-additional']",
    ".resume-block",
  ];

  let text = "";
  for (const sel of blockSelectors) {
    doc.querySelectorAll(sel).forEach(el => {
      const t = el.textContent?.replace(/\s+/g, " ").trim();
      if (t) text += t + "\n\n";
    });
  }

  if (!text.trim()) {
    text = (
      doc.querySelector("[data-qa='resume']")?.textContent ||
      doc.querySelector(".resume")?.textContent             ||
      doc.body.textContent || ""
    ).replace(/\s+/g, " ").trim();
  }

  if (text.length > 30000) text = text.slice(0, 30000);
  return { name, text };
}

// ── Отказы на HH ─────────────────────────────────────────────────────────────

async function executeRejections(candidates, sendResponse) {
  const isConsider = /collection=consider/i.test(window.location.href);

  // Фаза 1: отмечаем чекбоксы на карточках
  const selected = [];
  for (const candidate of candidates) {
    const ok = await tickCandidateCheckbox(candidate.hh_url);
    if (ok) selected.push(candidate);
    await sleep(150);
  }

  if (!selected.length) {
    sendResponse({ rejected: 0, total: candidates.length });
    return;
  }

  let rejected = 0;

  if (isConsider) {
    // Вкладка "Подумать" — нет bulk-кнопки, кликаем "Отказать" на каждой карточке
    for (const c of selected) {
      const ok = await rejectCandidatePerCard(c.hh_url);
      if (ok) {
        try {
          await bgPatch(`/api/candidates/${c.id}`, { status: "rejected" });
          rejected++;
        } catch (e) {
          console.warn("[HH Reject] patch error:", e.message);
        }
      }
      await sleep(400);
    }
  } else {
    // Вкладка "Отклики" — bulk кнопка responses-batch-reject
    const bulkOk = await clickBulkDiscard();
    if (bulkOk) {
      for (const c of selected) {
        try {
          await bgPatch(`/api/candidates/${c.id}`, { status: "rejected" });
          rejected++;
        } catch (e) {
          console.warn("[HH Reject] patch error:", e.message);
        }
      }
    }
  }

  sendResponse({ rejected, total: candidates.length });
}

async function tickCandidateCheckbox(resumeUrl) {
  const resumeId = resumeUrl.split("/resume/")[1]?.split("?")[0]?.split("/")[0];
  if (!resumeId) return false;

  const link = document.querySelector(`a[href*="${resumeId}"]`);
  if (!link) { console.log(`[HH Reject] ссылка не найдена: ${resumeId}`); return false; }

  // Поднимаемся вверх до карточки с чекбоксом
  let el = link.parentElement;
  while (el && el !== document.body) {
    if (el.querySelector('[data-qa="responses-auto-sort"]')) break;
    const cb = el.querySelector('input[type="checkbox"]');
    if (cb) {
      if (!cb.checked) cb.click();
      console.log(`[HH Reject] checkbox отмечен: ${resumeId}`);
      return true;
    }
    el = el.parentElement;
  }
  console.log(`[HH Reject] checkbox не найден: ${resumeId}`);
  return false;
}

async function clickBulkDiscard() {
  // Ждём появления тулбара массовых действий (до 3 сек)
  // data-qa="responses-batch-reject" — точный селектор тулбара на вкладке Отклики
  let bulkBtn = null;
  for (let i = 0; i < 10 && !bulkBtn; i++) {
    await sleep(300);
    bulkBtn =
      document.querySelector('[data-qa="responses-batch-reject"]') ||
      document.querySelector('[data-qa*="bulk"][data-qa*="discard"]') ||
      document.querySelector('[data-qa*="discard"][data-qa*="bulk"]') ||
      document.querySelector('[data-qa*="bulk-action"][data-qa*="discard"]');
  }

  console.log(`[HH Reject] bulk кнопка найдена: ${!!bulkBtn} / qa=${bulkBtn?.dataset?.qa}`);
  if (!bulkBtn) return false;

  bulkBtn.click();

  // Ждём дропдаун "Не подходит"
  let notSuitable = null;
  for (let i = 0; i < 8 && !notSuitable; i++) {
    await sleep(250);
    notSuitable =
      document.querySelector('[data-qa*="discard_by_employer_one-click"]') ||
      document.querySelector('[data-qa*="discard_by_employer"]') ||
      Array.from(document.querySelectorAll("[role='button'], button, li, [role='menuitem'], [role='option']"))
        .find(e => /не[\s ]+подходит/i.test(e.textContent));
  }

  console.log(`[HH Reject] "Не подходит" найдено: ${!!notSuitable} / "${notSuitable?.textContent?.trim().slice(0, 30)}"`);

  if (notSuitable) {
    notSuitable.click();

    // Иногда появляется дополнительное подтверждение "Изменить статус"
    let confirmBtn = null;
    for (let i = 0; i < 6 && !confirmBtn; i++) {
      await sleep(250);
      confirmBtn =
        document.querySelector('[data-qa*="status-change-confirm"]') ||
        document.querySelector('[data-qa*="confirm"]') ||
        Array.from(document.querySelectorAll('[role="button"], button'))
          .find(e => /изменить[\s ]+статус/i.test(e.textContent?.trim()));
    }
    if (confirmBtn) {
      console.log(`[HH Reject] "Изменить статус" найдено, кликаем`);
      confirmBtn.click();
      await sleep(400);
    }

    return true;
  }

  document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  return false;
}

// Для вкладки "Подумать" — кликаем "Отказать" напрямую на карточке кандидата
async function rejectCandidatePerCard(resumeUrl) {
  const resumeId = resumeUrl.split("/resume/")[1]?.split("?")[0]?.split("/")[0];
  if (!resumeId) return false;

  const link = document.querySelector(`a[href*="${resumeId}"]`);
  if (!link) { console.log(`[HH Reject] ссылка не найдена: ${resumeId}`); return false; }

  // Находим карточку кандидата
  let card = link.parentElement;
  while (card && card !== document.body) {
    if (card.querySelector('[data-qa="employee-discard-on-topic"]')) break;
    card = card.parentElement;
  }
  if (!card || card === document.body) {
    console.log(`[HH Reject] карточка не найдена: ${resumeId}`);
    return false;
  }

  const discardBtn = card.querySelector('[data-qa="employee-discard-on-topic"]');
  if (!discardBtn) return false;

  discardBtn.click();
  console.log(`[HH Reject] кликнули "Отказать" на карточке: ${resumeId}`);

  // Ждём дропдаун/модал с вариантами статуса, выбираем "Не подходит"
  let notSuitable = null;
  for (let i = 0; i < 10 && !notSuitable; i++) {
    await sleep(250);
    notSuitable =
      document.querySelector('[data-qa*="discard_by_employer_one-click"]') ||
      document.querySelector('[data-qa*="discard_by_employer"]') ||
      Array.from(document.querySelectorAll("[role='button'], button, li, [role='menuitem'], [role='option']"))
        .find(e => /не[\s ]+подходит/i.test(e.textContent));
  }

  console.log(`[HH Reject] "Не подходит" найдено: ${!!notSuitable}`);
  if (!notSuitable) return false;

  notSuitable.click();

  // Подтверждение "Изменить статус"
  let confirmBtn = null;
  for (let i = 0; i < 8 && !confirmBtn; i++) {
    await sleep(250);
    confirmBtn =
      document.querySelector('[data-qa*="status-change-confirm"]') ||
      document.querySelector('[data-qa*="confirm"]') ||
      Array.from(document.querySelectorAll('[role="button"], button'))
        .find(e => /изменить[\s ]+статус/i.test(e.textContent?.trim()));
  }
  if (confirmBtn) {
    console.log(`[HH Reject] "Изменить статус" найдено, кликаем`);
    confirmBtn.click();
    await sleep(500);
  }

  return true;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
