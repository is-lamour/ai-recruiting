// Content script — hh.kz
// Прогресс передаётся через chrome.storage.session (надёжнее для долгих операций в MV3)

let screeningActive = false;

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
      startScreening(message.vacancyId); // fire-and-forget, прогресс через storage
      return;

    case "execute_rejections":
      executeRejections(message.candidates, sendResponse);
      return true; // короткая операция, держим канал

    case "diagnose":
      sendResponse(diagnose());
      return;
  }
});

// ── Диагностика ───────────────────────────────────────────────────────────────

function diagnose() {
  const links = getLinksFromDOM();
  const allResumeEls = document.querySelectorAll("a[href*='/resume/']");
  return {
    url: window.location.href,
    linksFound: links.length,
    allResumeLinksTotal: allResumeEls.length,
    pageTitle: document.title,
  };
}

// ── Скрининг ──────────────────────────────────────────────────────────────────

async function startScreening(vacancyId) {
  screeningActive = true;
  await resetCancel();

  let processed = 0, errors = 0, skipped = 0;

  try {
    // Уже скринированные — пропускаем
    let alreadyScreened = new Set();
    try {
      const screened = await bgGet(`/api/vacancies/${vacancyId}/screened-urls`);
      alreadyScreened = new Set(screened);
    } catch { /* ignore */ }

    const links = await collectAllResumeLinks();

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

    for (const link of newLinks) {
      if (await isCancelled()) {
        console.log("[HH Screen] Остановлено пользователем");
        break;
      }

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
        console.warn("[HH Screen] Ошибка:", link.storeUrl, e.message);
        errors++;
      }

      const name = link.name || "";
      saveProgress({ active: true, current: processed + errors, total, skipped, vacancyId, name });
      await sleep(1200);
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

async function collectAllResumeLinks() {
  const links = [];
  let page = 0;

  while (page < 20) {
    const pageLinks = getLinksFromDOM();
    pageLinks.forEach(l => {
      if (!links.find(x => x.storeUrl === l.storeUrl)) links.push(l);
    });

    const nextBtn = findNextPageButton();
    if (!nextBtn) break;
    nextBtn.click();
    await sleep(2000);
    page++;
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
    "[data-qa='resume-serp__title-link']",
    "[data-qa='vacancy-response-item__candidate-link']",
    "[data-qa='resume__name']",
    "a[href*='/resume/']",
  ];

  for (const sel of selectors) {
    document.querySelectorAll(sel).forEach(el => {
      const href = el.getAttribute("href") || "";
      if (!href.includes("/resume/")) return;
      if (!isBeforeDivider(el, divider)) return; // пропускаем "подходящие"

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

  if (text.length > 10000) text = text.slice(0, 10000) + "...";
  return { name, text };
}

// ── Отказы на HH ─────────────────────────────────────────────────────────────

async function executeRejections(candidates, sendResponse) {
  let rejected = 0;

  for (const candidate of candidates) {
    try {
      const ok = await rejectCandidateOnPage(candidate.hh_url);
      if (ok) {
        rejected++;
        await bgPatch(`/api/candidates/${candidate.id}`, { status: "rejected" });
      }
    } catch (e) {
      console.warn("[HH Screen] Ошибка отказа:", e.message);
    }
    await sleep(900);
  }

  sendResponse({ rejected, total: candidates.length });
}

async function rejectCandidateOnPage(resumeUrl) {
  const resumeId = resumeUrl.split("/resume/")[1]?.split("?")[0]?.split("/")[0];
  if (!resumeId) return false;

  // Ищем карточку кандидата с этим резюме
  const links = document.querySelectorAll(`a[href*="${resumeId}"]`);
  for (const link of links) {
    const card =
      link.closest("[data-qa='vacancy-response-item']") ||
      link.closest("[data-qa='resume-serp-item']")       ||
      link.closest("[class*='applicant']")               ||
      link.closest("[class*='response']")                ||
      link.closest("article")                            ||
      link.closest("li");

    if (!card) continue;

    // Кнопка "Отказать" — может быть dropdown trigger
    const rejectTrigger =
      card.querySelector("[data-qa*='discard']")   ||
      card.querySelector("[data-qa*='reject']")    ||
      card.querySelector("[data-qa*='decline']")   ||
      Array.from(card.querySelectorAll("button, [role='button']")).find(
        el => /^отказать/i.test(el.textContent.trim())
      );

    if (!rejectTrigger) continue;

    rejectTrigger.click();
    await sleep(600);

    // Ищем "Не подходит" в открывшемся dropdown
    const dropdownItems = document.querySelectorAll(
      "[role='menu'] [role='menuitem'], [role='menu'] button, " +
      "[role='listbox'] [role='option'], " +
      "[class*='dropdown'] button, [class*='popup'] button, " +
      "[class*='menu-item'], [class*='bloko-menu'] button"
    );

    const notSuitable = Array.from(dropdownItems).find(
      el => /не подходит/i.test(el.textContent)
    );

    if (notSuitable) {
      notSuitable.click();
      await sleep(600);
      return true;
    }

    // Если dropdown не нашли — закрываем нажатием Escape
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    return false;
  }

  return false;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
