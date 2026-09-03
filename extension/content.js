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
    const hash = extractResumeHash(el.getAttribute("href") || "");
    if (hash) hashes.add(hash);
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

// Источник кандидата по URL текущей страницы
//   vacancyresponses → "response" (отклик), search/resume → "cold" (холодный поиск), иначе ""
function detectSource() {
  const p = window.location.pathname || "";
  if (/vacancyresponses/i.test(p)) return "response";
  if (/\/search\/resume/i.test(p)) return "cold";
  return "";
}

async function startScreening(vacancyId, maxPages) {
  screeningActive = true;
  await resetCancel();

  const source = detectSource();
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
            source,
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
            source,
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

// Извлекает id резюме из ссылки: путь /resume/{hash} либо параметр resumeId=/hash=.
// Толерантен к новым форматам HH (hash может содержать не только hex, но и др. символы).
function extractResumeHash(href) {
  if (!href) return null;
  const m = href.match(/\/resume\/([a-zA-Z0-9_-]{32,})/);
  if (m) return m[1];
  // Fallback: id в query-параметре (новые ссылки вида /resume/…?…&resumeId=…)
  try {
    const q = new URLSearchParams(href.split("?")[1] || "");
    return q.get("resumeId") || q.get("hash") || null;
  } catch {
    return null;
  }
}

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

  // Шаг 0 (страница откликов): hh.kz грузит кандидатов лениво — в DOM отрисовано
  // только ~7 карточек, остальные приходят JSON-запросом candidates_list.
  // Тянем ПОЛНЫЙ список хэшей напрямую из этого API, не дожидаясь отрисовки.
  let apiCollectedFull = false;
  if (vacancyId) {
    try {
      const apiUrl = `${window.location.origin}/shards/employer/vacancyresponses/candidates_list?` +
        new URLSearchParams({ vacancyId, order: "RELEVANCE", limit: "50" });
      const res = await fetch(apiUrl, {
        credentials: "include",
        headers: { Accept: "application/json, text/plain, */*" },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();

      // Имена и хэши из массива resumes (если endpoint его отдаёт)
      const nameByHash = {};
      for (const r of json.resumes || []) {
        const hash = r?._attributes?.hash;
        if (!hash) continue;
        const first = r?.firstName?.[0]?.string || "";
        const last  = r?.lastName?.[0]?.string  || "";
        nameByHash[hash] =
          [first, last].filter(Boolean).join(" ") || r?.title?.[0]?.string || "";
      }
      // Маппинг applicant -> hash (содержит всех заявителей этой вакансии)
      for (const v of Object.values(json.vacancyToResumeSkillMatch || {})) {
        if (v?.resume_id && !(v.resume_id in nameByHash)) nameByHash[v.resume_id] = "";
      }

      let added = 0;
      for (const [hash, name] of Object.entries(nameByHash)) {
        if (seen.has(hash)) continue;
        seen.add(hash);
        links.push({
          fetchUrl: `${window.location.origin}/resume/${hash}?vacancyId=${vacancyId}`,
          storeUrl: `${window.location.origin}/resume/${hash}`,
          name,
        });
        added++;
      }
      if (added > 0) {
        apiCollectedFull = true;
        console.log(`[HH Screen] candidates_list API: +${added} резюме`);
      }
    } catch (e) {
      console.warn("[HH Screen] candidates_list API не сработал, используется DOM+fetch:", e);
    }
  }

  // Шаг 1: берём ссылки с текущей страницы из DOM.
  // Сначала проходим по заголовкам (data-qa="serp-item__title") — они несут имя кандидата,
  // затем по всем остальным ссылкам (аватар и т.д.) чтобы не пропустить резюме без заголовка.
  const nameMap = {};
  document.querySelectorAll('[data-qa="serp-item__title"]').forEach(el => {
    const hash = extractResumeHash(el.getAttribute("href") || "");
    if (!hash) return;
    nameMap[hash] = el.textContent?.trim() || "";
  });

  document.querySelectorAll('a[href*="/resume/"]').forEach(el => {
    if (divider && !isBeforeDivider(el, divider)) return;
    const hash = extractResumeHash(el.getAttribute("href") || "");
    if (!hash) return;
    if (seen.has(hash)) return;
    seen.add(hash);
    const cleanUrl = `${window.location.origin}/resume/${hash}`;
    const fetchUrl = vacancyId ? `${cleanUrl}?vacancyId=${vacancyId}` : cleanUrl;
    const name = nameMap[hash] || el.textContent?.trim() || "";
    links.push({ fetchUrl, storeUrl: cleanUrl, name });
  });

  console.log(`[HH Screen] DOM собрал ${links.length} резюме с текущей страницы`);

  // Шаг 2: fetch остальных страниц (page=0 ... pageLimit-1), пропуская текущую.
  // Это основной путь для пагинации — DOM даёт только видимую страницу.
  const pageLimit = (maxPages && maxPages > 0) ? maxPages : 1;
  const currentPage = parseInt(params.get("page") || "0", 10);

  if (!apiCollectedFull && (pageLimit > 1 || links.length === 0)) {
    const effectiveLimit = links.length === 0 ? Math.max(pageLimit, 20) : pageLimit;
    const base = new URL(window.location.href);
    for (let page = 0; page < effectiveLimit; page++) {
      if (page === currentPage && links.length > 0) continue; // уже есть из DOM
      base.searchParams.set('page', page);
      try {
        const html = await fetch(base.toString(), { credentials: 'include' }).then(r => r.text());
        const hashes = [...html.matchAll(/href="\/resume\/([a-zA-Z0-9_-]{32,})/g)].map(m => m[1]);
        if (hashes.length === 0) break; // страниц больше нет
        let added = 0;
        hashes.forEach(hash => {
          if (seen.has(hash)) return;
          seen.add(hash);
          const cleanUrl = `${window.location.origin}/resume/${hash}`;
          const fetchUrl = vacancyId ? `${cleanUrl}?vacancyId=${vacancyId}` : cleanUrl;
          links.push({ fetchUrl, storeUrl: cleanUrl, name: "" });
          added++;
        });
        console.log(`[HH Screen] fetch страница ${page}: +${added} резюме`);
      } catch (e) {
        console.error(`[HH Screen] fetch страница ${page} упала:`, e);
      }
    }
  }

  console.log(`[HH Screen] Итого: ${links.length} резюме`);
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
  // ── Основной путь: отказ напрямую через API hh (механика скрининга).
  //    DOM-карточек в откликах может просто не быть (hh рендерит ~7 из 30+),
  //    поэтому API — надёжный способ увидеть/отказать всех сразу.
  const apiRes = await rejectByApi(candidates);
  if (apiRes && apiRes.ok) {
    console.log(`[HH Reject] API-отказы: attempted=${apiRes.attempted}, rejected=${apiRes.rejected}`);
    const total = candidates.length;
    const remaining = total - apiRes.rejected;
    sendResponse({
      rejected: apiRes.rejected,
      total,
      remaining: Math.max(0, remaining),
      notFound: Math.max(0, remaining),
      attempted: apiRes.attempted,
      coldSkipped: apiRes.coldSkipped || 0,
      notFoundNames: [],
    });
    return;
  }

  // ── Fallback: старый DOM-путь (вкладка "Подумать" и прочие случаи) ──────────
  const isConsider = /collection=consider/i.test(window.location.href);

  // hh.kz рендерит список откликов «виртуально»: в DOM есть только карточки,
  // попавшие в viewport, остальные подгружаются по мере прокрутки. При этом
  // выделение чекбоксов в списке сохраняется при прокрутке.
  // Поэтому: прокручиваем весь список, отмечая целевых по мере их появления,
  // затем одним нажатием bulk-кнопки отклоняем всех сразу.

  let rejected = 0;
  const total = candidates.length;
  const pending = candidates.slice();   // ещё не отмеченные
  const ticked = new Set();             // id, чьи чекбоксы уже отмечены
  const scroller = getResponseScroller();

  let noProgress = 0;                   // подряд прокруток без новых найденных
  const maxNoProgress = 20;             // страховка от бесконечной прокрутки

  while (pending.length > 0 && noProgress < maxNoProgress) {
    const foundThisRound = pending.filter(c => !ticked.has(c.id) && cardInDOM(c.hh_url));
    console.log(`[HH Reject] pending=${pending.length}, нашлось в DOM=${foundThisRound.length}`);

    let madeProgress = false;
    for (const c of foundThisRound) {
      if (isConsider) {
        // Вкладка "Подумать" — нет bulk-кнопки, отказ по каждой карточке
        const ok = await rejectCandidatePerCard(c.hh_url);
        if (ok) {
          ticked.add(c.id);
          madeProgress = true;
          try {
            await bgPatch(`/api/candidates/${c.id}`, { status: "rejected" });
            rejected++;
          } catch (e) {
            console.warn("[HH Reject] patch error:", e.message);
          }
        }
        await sleep(400);
      } else {
        // Вкладка "Отклики" — отмечаем чекбокс
        const ok = await tickCandidateCheckbox(c.hh_url);
        if (ok) {
          ticked.add(c.id);
          madeProgress = true;
        }
        await sleep(120);
      }
    }

    const before = pending.length;
    const remaining = pending.filter(c => !ticked.has(c.id));
    if (remaining.length < before) madeProgress = true;
    pending.length = 0;
    pending.push(...remaining);

    if (!madeProgress) {
      // Новых не нашли — прокручиваем, чтобы hh подгрузил следующие карточки
      const moved = await scrollListDown(scroller);
      if (!moved) noProgress++;
      await sleep(350);
    } else {
      noProgress = 0;
      await sleep(400);
    }
  }

  if (isConsider) {
    // Уже отказали по-карточкам (патчи выше)
  } else {
    // Отклики — жмём bulk-кнопку по всем отмеченным
    if (ticked.size > 0) {
      const bulkOk = await clickBulkDiscard();
      if (bulkOk) {
        for (const c of candidates) {
          if (!ticked.has(c.id)) continue;
          try {
            await bgPatch(`/api/candidates/${c.id}`, { status: "rejected" });
            rejected++;
          } catch (e) {
            console.warn("[HH Reject] patch error:", e.message);
          }
        }
      }
    }
  }

  console.log(`[HH Reject] ГОТОВО: rejected=${rejected}, total=${total}, отмечено=${ticked.size}`);
  const notFound = candidates.filter(c => !ticked.has(c.id));
  sendResponse({
    rejected,
    total,
    remaining: notFound.length,
    notFound: notFound.length,
    attempted: ticked.size - rejected,
    notFoundNames: notFound.slice(0, 10).map(c => c.name || c.hh_url),
  });
}

// Есть ли карточка кандидата в текущем DOM
function cardInDOM(resumeUrl) {
  const resumeId = resumeIdFromUrl(resumeUrl);
  return !!resumeId && !!document.querySelector(`a[href*="${resumeId}"]`);
}

function resumeIdFromUrl(resumeUrl) {
  return (resumeUrl || "").split("/resume/")[1]?.split("?")[0]?.split("/")[0];
}

// Ищем реально скроллящийся элемент списка (может быть сам window или вложенный контейнер)
function getResponseScroller() {
  const candidates = [document.scrollingElement, document.documentElement, document.body];
  document.querySelectorAll('[data-qa*="vacancy-respons"], [data-qa*="response"], [class*="respond"], main, [class*="scroll"]').forEach(el => {
    if (el && el.scrollHeight > el.clientHeight + 30) candidates.push(el);
  });
  for (let i = candidates.length - 1; i >= 0; i--) {
    const el = candidates[i];
    if (el && el.scrollHeight > el.clientHeight + 30) return el;
  }
  return document.scrollingElement || document.documentElement;
}

// Прокручиваем список вниз; возвращаем true, если получилось подвинуть скролл
async function scrollListDown(scroller) {
  const before = scroller.scrollTop;
  scroller.scrollTop = scroller.scrollHeight;
  for (let i = 0; i < 15; i++) {
    await sleep(200);
    if (scroller.scrollTop > before) return true;
  }
  return false;
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

// ── Отказы через API hh (та же механика, что и скрининг: полный список из
//    candidates_list, отказ напрямую в change_topic — без поиска карточек в DOM,
//    который hh рендерит лишь частично и которых в DOM может просто не быть) ────

// CSRF-токен hh живёт в cookie _xsrf
function getXsrf() {
  return (document.cookie.match(/(?:^|;\s*)_xsrf=([^;]+)/) || [])[1] || "";
}

// Получить vacancyId из URL страницы откликов (или из query кандидата)
function getVacancyId(url) {
  const m = (url || window.location.href).match(/[?&]vacancyId=(\d+)/);
  return m ? m[1] : "";
}

// Тянем полный список откликов вакансии из внутреннего API hh (как в скрининге)
// и строим карту: hash резюме -> { topicId, resumeId, discardStageId, name }
async function loadResponsesMap(vacancyId) {
  const apiUrl = `${window.location.origin}/shards/employer/vacancyresponses/candidates_list?` +
    new URLSearchParams({ vacancyId, order: "RELEVANCE", limit: "50" });
  const res = await fetch(apiUrl, { credentials: "include" });
  if (!res.ok) throw new Error(`candidates_list HTTP ${res.status}`);
  const j = await res.json();

  const cands = j.contactCenterCandidates?.candidates || [];
  const m = j.vacancyToResumeSkillMatch || {};
  const hashByRid = {};
  for (const [rid, v] of Object.entries(m)) {
    if (v && v.resume_id) hashByRid[rid] = v.resume_id;
    else if (v && typeof v === "string") hashByRid[rid] = v;
  }

  const map = new Map();
  for (const c of cands) {
    const hash = hashByRid[c.resumeId] || c.resumeHash;
    if (!hash) continue;
    const discard = (c.stages || []).find(s => s.state === "DISCARD_BY_EMPLOYER");
    map.set(hash, {
      topicId: c.topicId,
      resumeId: c.resumeId,
      discardStageId: discard ? discard.funnelStageId : null,
      name: c.name || "",
    });
  }
  return map;
}

// Сама отправка отказа по одному кандидату; возвращает true при успехе
async function apiRejectOne(vacancyId, xsrf, info, hash, mailText) {
  if (!info || !info.topicId || !info.discardStageId) {
    console.log(`[HH Reject] нет данных для отказа: ${hash}`);
    return false;
  }
  const headers = {
    "X-hhtmSource": "employer_vacancy_responses",
    "X-hhtmFrom": "employer_vacancies",
    "Accept": "application/json",
    "X-Requested-With": "XMLHttpRequest",
    "X-Xsrftoken": xsrf,
  };
  const fd = new FormData();
  fd.set("vacancyId", String(vacancyId));
  fd.set("state", "discard_by_employer");
  fd.set("funnelStageId", String(info.discardStageId));
  fd.set("funnelStageKey", "null");
  fd.set("messageGroupVisible", "true");
  fd.set("employerManagerTemplateId", "response_discard_mail_15609192_primary");
  fd.set("mailText", mailText);
  fd.set("quickTransferToStageEnabled", "false");
  fd.set("resumeHash", hash);
  fd.set("t", String(info.topicId));

  const res = await fetch(`${window.location.origin}/employer/negotiations/change_topic`, {
    method: "POST",
    credentials: "include",
    headers,
    body: fd,
  });
  if (!res.ok) {
    console.warn(`[HH Reject] отказ не прошёл (HTTP ${res.status}): ${hash}`);
    return false;
  }
  try {
    const data = await res.json();
    if (data.state !== "discard_by_employer") {
      console.warn(`[HH Reject] неожиданный ответ hh для ${hash}:`, data);
      return false;
    }
  } catch (e) { /* ответ не JSON — считаем успехом, т.к. 2xx */ }
  console.log(`[HH Reject] API-отказ отправлен: ${hash} (topic ${info.topicId})`);
  return true;
}

// Отказать списку кандидатов напрямую через API hh.
// candidates: [{id, hh_url}]. Возвращает {ok} — true, если API-путь применим.
async function rejectByApi(candidates) {
  const vacancyId = getVacancyId(window.location.href);
  const onResponsesPage = /vacancyresponses/i.test(window.location.pathname) && vacancyId;
  // fallback: vacancyId может прийти в hh_url кандидата
  const hrefVacancyId = candidates.length
    ? getVacancyId(candidates[0].hh_url || "")
    : "";
  const vid = vacancyId || hrefVacancyId;
  if (!vid) return false;

  // Резолвим хэши
  const hashes = candidates.map(c => {
    const u = c.hh_url || "";
    return u.split("/resume/")[1]?.split("?")[0]?.split("/")[0] || null;
  }).filter(Boolean);

  const xsrf = getXsrf();
  if (!xsrf) return false;

  let map;
  try {
    map = await loadResponsesMap(vid);
  } catch (e) {
    console.warn("[HH Reject] candidates_list не сработал, переходим к DOM:", e);
    return false;
  }

  let attempted = 0, rejected = 0, coldSkipped = 0;
  for (const c of candidates) {
    const hash = (c.hh_url || "").split("/resume/")[1]?.split("?")[0]?.split("/")[0];
    if (!hash) continue;

    // Кандидаты из холодного поиска не откликались — на странице откликов их нет.
    // Не пытаемся отклонить и не считаем ошибкой; просто помечаем отдельно.
    if (c.source === "cold") {
      coldSkipped++;
      console.log(`[HH Reject] холодный кандидат, не трогаем на откликах: ${hash}`);
      continue;
    }

    const info = map.get(hash);
    attempted++;
    const mailText =
      "Здравствуйте! Благодарим за интерес к нашей вакансии. " +
      "К сожалению, мы не готовы продолжить рассмотрение вашего резюме.";
    const ok = await apiRejectOne(vid, xsrf, info, hash, mailText);
    if (ok) {
      rejected++;
      try { await bgPatch(`/api/candidates/${c.id}`, { status: "rejected" }); }
      catch (e) { console.warn("[HH Reject] patch error:", e.message); }
    }
    await sleep(350);
  }
  return { ok: true, attempted, rejected, coldSkipped, loadedCount: map.size };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
