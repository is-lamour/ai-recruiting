# Как hh.kz устроен «под капотом»: поиск всех резюме (скрининг и отказы)

> Зачем этот файл: hh периодически меняет структуру своих страниц, и расширение
> приходится чинить заново. Ниже — как именно работает поиск **всех** резюме на
> странице откликов — и для скрининга, и для отказов — чтобы при следующем сбое
> не пришлось заново всё раскапывать.

## Главная идея (корень всех проблем)

**hh.kz рендерит список откликов «виртуально».** Страница откликов вакансии
(`/employer/vacancyresponses?vacancyId=…`) показывает **только ~5–7 карточек,
которые влезли в экран (viewport)**. Остальные кандидаты в DOM **вообще не
попадают** — их нет даже в тексте страницы. Как только скроллишь — карточки
уходят/приходят (переиспользуются).

Поэтому **любой подход, который ищет резюме в DOM, всегда будет «не видеть»
большинство кандидатов** — и на скрининге, и на отказах. Это и была причина
ошибки: «Выполнить отказы» отказывал 2–4 из 12, потому что в DOM были только
первые ~7 карточек, а нужных среди них не оказывалось.

**Правильное решение: не искать карточки в DOM, а тянуть полный список
напрямую из внутреннего JSON-API hh.** Оно одинаково и для скрининга, и для
отказов.

---

## 1. Авторитетный источник — внутренний API hh

Полный список всех откликов вакансии отдаёт внутренний эндпоинт:

```
GET {origin}/shards/employer/vacancyresponses/candidates_list?vacancyId={id}&order=RELEVANCE&limit=50
```

- `origin` — домен, на котором открыта страница (`https://almaty.hh.kz`, `https://hh.ru`…).
- `vacancyId` — числовой ID вакансии из URL страницы откликов.
- Параметры `order=RELEVANCE&limit=50` — как шлёт сама hh; `limit` можно поднять, чтобы гарантированно влезли все.
- Запрос `fetch(…, { credentials: "include" })` — идёт под куками сессии, т.е. только от залогиненного рекрутера.

В ответе важны два блока:

### `contactCenterCandidates.candidates[]` — готовые данные по каждому

Это самый полезный блок: **уже готовый список кандидатов со всеми полями,
которые нужны и для скрининга, и для отказов.** У каждого элемента:

| Поле | Зачем |
|------|-------|
| `topicId` | числовой ID «диалога/темы» — **это то, что hh ждёт в поле `t` при отказе** |
| `resumeId` | числовой ID резюме (совпадает с ключом в `vacancyToResumeSkillMatch`) |
| `state` | текущий статус кандидата (`RESPONSE`, `CONSIDER`…). Отказанные отсюда исчезают |
| `stages[]` | массив всех стадий воронки. В нём живёт стадия отказа `DISCARD_BY_EMPLOYER` с её `funnelStageId` |
| `funnelStageId`, `name` и др. | служебное |

### `vacancyToResumeSkillMatch` — связка resumeId → hash резюме

Объект, где **ключ = `resumeId` (число)**, а в значении лежит `resume_id` — это
**строковый hash резюме** (тот самый, что фигурирует в ссылке `/resume/{hash}`
и в нашей БД). Именно через него мы связываем найденных hh-кандидатов с нашими.

То есть полная цепочка для кандидата:
```
наша БД хранит  /resume/{hash}
   ↓  (связка из vacancyToResumeSkillMatch)
resumeId (число)  +  topicId  +  discardStageId (из stages)
```

---

## 2. Как это используется при скрининге

Функция `collectAllResumeLinks(vacancyId, maxPages)` — `extension/content.js:262`.

1. Берёт `vacancyId` из query-строки страницы откликов.
2. **Шаг 0 (главный):** дёргает `candidates_list`, из `resumes` / `vacancyToResumeSkillMatch`
   собирает **все** hash резюме. Это и есть «видит все резюме на странице» —
   столько, сколько реально откликнулось, без оглядки на DOM. (`+N резюме`)
3. Для каждого hash делает ссылку для fetch: `/resume/{hash}?vacancyId={vid}`
   и сохраняет «чистую» ссылку без query для БД.
4. **Шаг 1 (дополнительно):** собирает ссылки уже из DOM
   (`a[href*="/resume/"]`), чтобы не потерять то, что попало на экран, и подхватить имя из заголовка.
5. **Шаг 2 (пагинация):** если API не сработал — фолбэк: fetch страниц
   `?page=0..N` и парсинг hash regex'ом из HTML.

Дальше скрининг по очереди fetch'ит каждый `/resume/{hash}`, достаёт текст и
отправляет на `POST /api/screen`.

---

## 3. Как это используется при отказах (новая логика)

Функции `rejectByApi` (`extension/content.js:892`), `loadResponsesMap`
(`:814`), `apiRejectOne` (`:845`).

Отказ через API = **три шага на кандидата**, без прокрутки и без DOM:

### Шаг A — CSRF-токен
hh требует заголовок `X-Xsrftoken`, иначе `403 Forbidden`. Токен лежит в
**cookie `_xsrf`**:
```js
(document.cookie.match(/(?:^|;\s*)_xsrf=([^;]+)/) || [])[1]
```

### Шаг B — полный список кандидатов
`loadResponsesMap(vid)`: fetch `candidates_list` → берём
`contactCenterCandidates.candidates[]`, для каждого:
- `topicId` → это будущий `t`;
- hash резюме — через `vacancyToResumeSkillMatch[resumeId].resume_id`;
- стадию отказа: `c.stages.find(s => s.state === "DISCARD_BY_EMPLOYER").funnelStageId`.

Результат — `Map<hash, {topicId, resumeId, discardStageId}>`.

### Шаг C — сам отказ
Для каждого кандидата отправляем:

```
POST {origin}/employer/negotiations/change_topic
headers:
  X-hhtmSource: employer_vacancy_responses
  X-hhtmFrom: employer_vacancies
  Accept: application/json
  X-Requested-With: XMLHttpRequest
  X-Xsrftoken: {_xsrf}
body (FormData):
  vacancyId={vid}
  state=discard_by_employer
  funnelStageId={discardStageId}      ← из шага B
  funnelStageKey=null
  messageGroupVisible=true
  employerManagerTemplateId=response_discard_mail_15609192_primary
  mailText={непустой текст отказа}    ← обязателен, иначе MAIL_TEXT_EMPTY
  quickTransferToStageEnabled=false
  resumeHash={hash}
  t={topicId}                          ← из шага B
```

Успех = `HTTP 200` и ответ `{"state":"discard_by_employer", …}`.

После успеха патчим нашу БД: `PATCH /api/candidates/{id}` → `{status:"rejected"}`.

### Почему это чинит ошибку
- Раньше «Выполнить отказы» искал карточку по hash в DOM
  (`cardInDOM`, `extension/content.js:624`) и кликал UI. Но в DOM было только ~7
  карточек из 30+, а нужных среди видимых не было → отказывалось 2–4.
- Теперь список берётся из API (видны **все**), а отказ — прямой POST без
  поиска карточек. DOM-путь оставлен как fallback (вкладка «Подумать» и пр.).

---

## 4. Как это чинить, когда hh снова что-то поменяет

Пошаговый план на будущее:

1. **Сначала воспроизведи симптом.** Открой страницу откликов, в консоли
   посчитай, сколько ссылок резюме в DOM и сколько из «наших» hash в тексте
   страницы. Если `0/12` — это снова виртуализация, не лезь в DOM-логику
   скролла, а иди в API.

2. **Проверь, что `candidates_list` жив.** В консоли страницы:
   ```js
   fetch('/shards/employer/vacancyresponses/candidates_list?'+new URLSearchParams({vacancyId:'...',order:'RELEVANCE',limit:'50'}),{credentials:'include'}).then(r=>r.json()).then(j=>console.log(Object.keys(j)))
   ```
   Если в ответе нет `contactCenterCandidates.candidates` или
   `vacancyToResumeSkillMatch` — hh переименовал/перенёс поля. Ищи новые имена
   свежим запросом и прави их в `loadResponsesMap` (и в `collectAllResumeLinks`).

3. **Проверь отказ.** Если появилось `403` — чужой CSRF: токен больше не в
   cookie `_xsrf`, найди новый источник. Если `404 TOPIC_NOT_FOUND` — поле `t`
   больше не равно `topicId`; перепроверь, откуда брать `t`. Если
   `MAIL_TEXT_EMPTY` — не забудь непустой `mailText`.

4. **Как вообще «вычислить» новую структуру, если данных нет:**
   - Открой **Network** (вкладка Сеть) → фильтр `Fetch/XHR`.
   - Сделай **вручную** одно действие (скринить один кандидат → это
     `candidates_list`; отказать одного через UI → это `change_topic`).
   - Глянь, какой URL и тело запроса ушли. Это и есть актуальный API.
   - В нужный момент её можно перехватить в консоли, обернув `fetch`/`XHR`
     (см. ниже мини-сниппет), чтобы увидеть заголовки и тело.

Мини-сниппет для перехвата (вставить в консоль до действия):
```js
const f=window.fetch;
window.fetch=function(u,o){console.log((o?.method||'GET')+' '+String(u).slice(0,120), o?.body?('BODY:'+String(o.body).slice(0,300)):'');return f.apply(this,arguments)};
```

---

## 5. Ключевые места в коде (карта)

| Что | Где |
|-----|-----|
| Полный список из API (скрининг) | `collectAllResumeLinks` — `extension/content.js:262` |
| Парсинг hash из ссылки | `extractResumeHash` — `content.js:249` |
| Fallback: сбор из DOM | `getLinksFromDOM` — `content.js:399` |
| Отказ: точка входа | `executeRejections` — `content.js:505` |
| Отказ: карта кандидатов из API | `loadResponsesMap` — `content.js:814` |
| Отказ: один прямой POST | `apiRejectOne` — `content.js:845` |
| Отказ: драйвер по списку | `rejectByApi` — `content.js:892` |
| Старая DOM-логика (fallback) | `cardInDOM` — `content.js:624` |

---

## 6. Психологический мини-чеклист при поломке

- [ ] Проблема в том, что «не видит всех», и есть прокрутка? → **виртуализация**.
      Не чини прокрутку — иди в API `candidates_list`.
- [ ] `403 Forbidden` → CSRF-токен (`_xsrf` cookie / заголовок `X-Xsrftoken`).
- [ ] `404 TOPIC_NOT_FOUND` → поле `t` = `topicId` (из `contactCenterCandidates`).
- [ ] `500 / 400` → смотри тело ответа; часто hh пишет, чего не хватает
      (например, `MAIL_TEXT_EMPTY`).
- [ ] Всё сломалось разом → скорее всего поменялись **имена полей/блоков**,
      а не сам принцип. Принцип один: `candidates_list` + `change_topic`.
