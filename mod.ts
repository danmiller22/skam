/**
 * Lalafo → Telegram бот под Deno Deploy.
 *
 * Условия:
 *  - город: только Бишкек
 *  - 1–2 комнаты
 *  - цена ≤ 50 000 KGS
 *  - только собственники (отсекаем явные агентства/риэлторов)
 *  - обязательно есть номер телефона
 */

const BOT_TOKEN = Deno.env.get("TELEGRAM_BOT_TOKEN") ?? "";
const CHAT_ID = Deno.env.get("TELEGRAM_CHAT_ID") ?? "";

// Жёстко фиксируем Бишкек
const CITY_SLUG = "bishkek";

// фильтры
const MAX_PRICE = 50000;
const MIN_ROOMS = 1;
const MAX_ROOMS = 2;
const OWNER_ONLY = true;

// лимит объявлений за один прогон
const ADS_LIMIT = Number(Deno.env.get("ADS_LIMIT") ?? "25");

// сколько страниц списка обходим
const PAGES = Number(Deno.env.get("PAGES") ?? "5");

const BASE_URL = "https://lalafo.kg";

export interface Ad {
  id: string;
  url: string;
  title: string;
  price_kgs: number | null;
  location: string | null;
  rooms: number | null;
  is_owner: boolean | null;
  created_raw: string | null;
  images: string[];
  description: string | null;
  owner_name: string | null;
  phone: string | null;
}

const kv = await Deno.openKv();

/* ================= ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ ================= */

function extractFirst(re: RegExp, text: string): string | null {
  const m = text.match(re);
  return m && m[1] ? m[1].trim() : null;
}

async function fetchHtml(url: string): Promise<string> {
  const res = await fetch(url, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome Safari",
      "Accept-Language": "ru,en;q=0.8",
    },
  });

  if (res.status === 404) {
    console.log("Ad not found (404), skip:", url);
    return ""; // вернём пустую строку, чтобы fetchAd вернул null
  }

  if (!res.ok) {
    throw new Error(`HTTP ${res.status} for ${url}`);
  }

  return await res.text();
}

function extractListingLinks(html: string, citySlug: string): string[] {
  const re = new RegExp(`(\\/${citySlug}\\/ads\\/[^"'<>\\s]+-id-\\d+)`, "g");
  const seen = new Set<string>();
  const links: string[] = [];
  let m: RegExpExecArray | null;

  while ((m = re.exec(html)) !== null) {
    const href = new URL(m[1], BASE_URL).toString();
    if (!seen.has(href)) {
      seen.add(href);
      links.push(href);
    }
  }

  console.log("Extracted links:", links.length);
  return links;
}

function stripTags(s: string): string {
  return s.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

/* ================= ПАРСИНГ ПОЛЕЙ ================= */

function parsePriceKgs(html: string): number | null {
  const m = html.match(/([\d\s]{2,})\s*KGS/);
  if (!m) return null;
  const raw = m[1].replace(/\s+/g, "");
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

function parseRooms(html: string): number | null {
  const patterns = [
    /(\d+)\s*комнат[аы]?\b/i,
    /(\d+)[-\s]*комнатн/i,
    /(\d+)\s*комн[.\s,]/i,
    /(\d+)\s*к\b/i,
  ];
  for (const re of patterns) {
    const m = html.match(re);
    if (m && m[1]) {
      const n = Number(m[1]);
      if (Number.isFinite(n)) return n;
    }
  }
  return null;
}

function parseIsOwner(html: string): boolean | null {
  const hasOwner =
    /Собственник/i.test(html) || /Хозяин/i.test(html);
  const hasAgent =
    /Риэлтор/i.test(html) ||
    /Агентств[оа]/i.test(html) ||
    /Агентство недвижимости/i.test(html);

  if (hasOwner && !hasAgent) return true;
  if (hasAgent && !hasOwner) return false;
  return null;
}

function parseCreated(html: string): string | null {
  const m = html.match(/(\d{2}\.\d{2}\.\d{4}\s*\/\s*\d{2}:\d{2})/);
  return m ? m[1] : null;
}

function parseTitle(html: string): string | null {
  const h1 = extractFirst(/<h1[^>]*>([\s\S]*?)<\/h1>/i, html);
  if (h1) return stripTags(h1);
  const t = extractFirst(/<title[^>]*>([\s\S]*?)<\/title>/i, html);
  return t ? stripTags(t) : null;
}

function parseLocationFromJson(html: string): string | null {
  const mCity = html.match(/"addressLocality"\s*:\s*"([^"]+)"/);
  const mStreet = html.match(/"streetAddress"\s*:\s*"([^"]+)"/);
  if (mCity || mStreet) {
    const parts = [mCity?.[1], mStreet?.[1]].filter(Boolean) as string[];
    const combined = parts.join(", ");
    if (combined) return combined;
  }
  return null;
}

function parseLocationFallback(html: string): string | null {
  const re =
    /\d{2}\.\d{2}\.\d{4}\s*\/\s*\d{2}:\d{2}\s*([\s\S]+?)\s*Позвонить/i;
  const m = html.match(re);
  if (!m) return null;
  const loc = m[1].replace(/\s+/g, " ").trim();
  return loc || null;
}

function cleanDescription(raw: string): string {
  let s = raw;

  s = s.replace(/https?:\/\/\S+/gi, "");
  s = s.replace(/lalafo\.kg/gi, "");
  s = s.replace(/【[^】]*】/g, " ");
  s = s.replace(/ᐈ/g, " ");

  const parts = s.split(/[\r\n]+/);
  const filtered = parts.filter((p) => !/lalafo/i.test(p));
  s = filtered.join("\n");

  s = s.replace(/\s{2,}/g, " ").trim();
  return s;
}

function parseDescription(html: string): string | null {
  const byDataTestId = extractFirst(
    /<div[^>]+data-testid="ad-description"[^>]*>([\s\S]*?)<\/div>/i,
    html,
  );
  let desc = byDataTestId;

  if (!desc) {
    const pDesc = extractFirst(
      /<p[^>]*itemprop="description"[^>]*>([\s\S]*?)<\/p>/i,
      html,
    );
    desc = pDesc;
  }

  if (!desc) {
    const meta = extractFirst(
      /<meta\s+name="description"\s+content="([\s\S]*?)"/i,
      html,
    );
    desc = meta;
  }

  if (!desc) return null;

  const clean = cleanDescription(stripTags(desc));
  if (!clean) return null;

  return clean.slice(0, 1500);
}

function parseOwnerName(html: string): string | null {
  const m1 = html.match(/"sellerName"\s*:\s*"([^"]+)"/);
  if (m1 && m1[1]) return m1[1];

  const m2 = html.match(/"userName"\s*:\s*"([^"]+)"/);
  if (m2 && m2[1]) return m2[1];

  const byTestId = extractFirst(
    /data-testid="seller-name"[^>]*>([\s\S]*?)<\/[^>]+>/i,
    html,
  );
  if (byTestId) return stripTags(byTestId);

  const byLabel = extractFirst(
    /Владелец[^<]*<\/[^>]+>\s*<[^>]*>([\s\S]*?)<\/[^>]+>/i,
    html,
  );
  if (byLabel) return stripTags(byLabel);

  return null;
}

/**
 * Парсим телефон:
 *  - ищем последовательности вида +996 700 744 274 или 0700 744 274 и т.п.
 *  - берём только то, что похоже на киргизский номер:
 *      * 12 цифр и начинается с 9967 (мобильный)
 *      * 10 цифр и начинается с 0
 *  - короткие id (8 цифр и т.п.) отсекаем.
 */
function parsePhoneFromText(text: string): string | null {
  const phoneRegex = /(\+?\d[\d \-\(\)]{7,20})/g;
  let match: RegExpExecArray | null;

  while ((match = phoneRegex.exec(text)) !== null) {
    const raw = match[1];
    const digits = raw.replace(/\D/g, "");

    if (digits.length < 9 || digits.length > 12) continue;

    const isKgMobile =
      (digits.length === 12 && digits.startsWith("9967")) ||
      (digits.length === 10 && digits.startsWith("0"));

    if (!isKgMobile) continue;

    const normalized = raw.replace(/\s+/g, " ").trim();
    return normalized;
  }

  return null;
}

function enrichLocation(
  rawLocation: string | null,
  description: string | null,
): string {
  let loc = rawLocation || "";

  if ((!loc || loc.toLowerCase() === "бишкек") && description) {
    const mNumMkr = description.match(/(\d+\s*мкр)/i);
    if (mNumMkr && mNumMkr[1]) {
      const area = mNumMkr[1].trim();
      return `Бишкек, ${area}`;
    }

    const mJk = description.match(/ЖК\s+([А-ЯЁA-Z0-9][^,.\n]+)/i);
    if (mJk && mJk[1]) {
      const area = `ЖК ${mJk[1].trim()}`;
      return `Бишкек, ${area}`;
    }

    const mNameMkr = description.match(
      /([А-ЯЁA-Z][^,\n]{0,30}\s+мкр)/i,
    );
    if (mNameMkr && mNameMkr[1]) {
      const area = mNameMkr[1].trim();
      return `Бишкек, ${area}`;
    }

    const patterns: RegExp[] = [
      /микрорайон\s+([А-ЯЁA-Z][^,\n]{0,30})/i,
      /район\s+([А-ЯЁA-Z][^,\n]{0,30})/i,
      /Рабочий Городок/i,
    ];
    for (const re of patterns) {
      const m = description.match(re);
      if (m && m[0]) {
        const area = m[0].trim();
        return `Бишкек, ${area}`;
      }
    }
  }

  if (!loc) return "Бишкек, район не указан";
  if (!loc.toLowerCase().includes("бишкек")) {
    return `Бишкек, ${loc}`;
  }
  if (!/,/.test(loc)) {
    return `${loc}, район не указан`;
  }
  return loc;
}

/* ================= ОДНО ОБЪЯВЛЕНИЕ ================= */

async function fetchAd(url: string): Promise<Ad | null> {
  try {
    const html = await fetchHtml(url);
    if (!html) return null; // 404 и подобные — пропускаем

    const id =
      extractFirst(/-id-(\d+)/, url) ??
      new URL(url).pathname.split("/").pop() ??
      url;
    const title = parseTitle(html) ?? "Объявление на Lalafo";
    const price = parsePriceKgs(html);
    const rooms = parseRooms(html);
    const isOwner = parseIsOwner(html);
    const created = parseCreated(html);
    const rawLocation = parseLocationFromJson(html) ?? parseLocationFallback(html);
    const description = parseDescription(html);
    const location = enrichLocation(rawLocation, description);
    const images = parseImages(html);
    const ownerName = parseOwnerName(html);

    // 1) пробуем вытащить телефон из всей HTML-страницы (как на скрине с кнопкой)
    // 2) fallback — из текста описания
    const phone =
      parsePhoneFromText(html) ||
      (description ? parsePhoneFromText(description) : null);

    return {
      id,
      url,
      title,
      price_kgs: price,
      rooms,
      is_owner: isOwner,
      created_raw: created,
      location,
      images,
      description,
      owner_name: ownerName,
      phone,
    };
  } catch (e) {
    console.log("fetchAd error", e);
    return null;
  }
}

function parseImages(html: string): string[] {
  const re = /https:\/\/img\d+\.lalafo\.com\/[^\s"'<>]+/g;
  const seen = new Set<string>();
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const u = m[0];
    if (!u.includes("/posters/")) continue;
    if (seen.has(u)) continue;
    seen.add(u);
    out.push(u);
    if (out.length >= 10) break;
  }
  return out;
}

/* ================= ЛОГИКА ФИЛЬТРОВ ================= */

function isRoomsAllowed(ad: Ad): boolean {
  if (ad.rooms != null) {
    return ad.rooms >= MIN_ROOMS && ad.rooms <= MAX_ROOMS;
  }

  const text = `${ad.title ?? ""} ${ad.description ?? ""}`.toLowerCase();

  if (
    /\b[3-9]\s*комн/.test(text) ||
    /\b[3-9][-\s]*комнатн/.test(text) ||
    /трехкомнатн|трёхкомнатн|четырехкомнатн|4к\b|4-к\b|3к\b|3-к\b/i.test(text)
  ) {
    return false;
  }

  if (
    /\b1\s*комн/.test(text) ||
    /\b1[-\s]*комнатн/i.test(text) ||
    /однокомнатн|1к\b|1-к\b|одна комната/i.test(text)
  ) {
    return true;
  }

  if (
    /\b2\s*комн/.test(text) ||
    /\b2[-\s]*комнатн/i.test(text) ||
    /двухкомнатн|2к\b|2-к\b|две комнаты/i.test(text)
  ) {
    return true;
  }

  return false;
}

/* ================= СПИСОК ОБЪЯВЛЕНИЙ ================= */

async function fetchAdsPage(page: number): Promise<Ad[]> {
  const path =
    `/${CITY_SLUG}/kvartiry/arenda-kvartir/dolgosrochnaya-arenda-kvartir?page=${page}`;
  const html = await fetchHtml(new URL(path, BASE_URL).toString());
  const links = extractListingLinks(html, CITY_SLUG);
  const ads: Ad[] = [];
  for (const link of links) {
    const ad = await fetchAd(link);
    if (!ad) continue;

    // 1–2 комнаты
    if (!isRoomsAllowed(ad)) continue;

    // цена: обязательно и ≤ MAX_PRICE
    if (ad.price_kgs == null || ad.price_kgs > MAX_PRICE) continue;

    // только собственники: отбрасываем только явные агентства/риэлторов
    if (OWNER_ONLY && ad.is_owner === false) continue;

    // обязателен номер телефона
    if (!ad.phone) continue;

    ads.push(ad);
  }
  return ads;
}

async function fetchAds(): Promise<Ad[]> {
  const out: Ad[] = [];
  for (let page = 1; page <= PAGES; page++) {
    const pageAds = await fetchAdsPage(page);
    for (const ad of pageAds) {
      out.push(ad);
      if (out.length >= ADS_LIMIT) return out;
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  return out;
}

/* ================= KV ================= */

async function hasSeen(id: string): Promise<boolean> {
  const res = await kv.get(["seen_v3", id]);
  return Boolean(res.value);
}

async function markSeen(id: string): Promise<void> {
  await kv.set(["seen_v3", id], true);
}

/* ================= TELEGRAM ================= */

async function tgSend(
  method: string,
  payload: Record<string, unknown>,
): Promise<boolean> {
  if (!BOT_TOKEN || !CHAT_ID) {
    console.log("TELEGRAM_BOT_TOKEN/CHAT_ID not set, skip send");
    return false;
  }

  const url = `https://api.telegram.org/bot${BOT_TOKEN}/${method}`;

  async function doRequest(): Promise<Response> {
    const form = new FormData();
    for (const [k, v] of Object.entries(payload)) {
      if (k === "media") {
        form.append(k, JSON.stringify(v));
      } else {
        form.append(k, String(v));
      }
    }
    return await fetch(url, { method: "POST", body: form });
  }

  // максимум 2 попытки с учётом retry_after
  for (let attempt = 1; attempt <= 2; attempt++) {
    const res = await doRequest();
    const txt = await res.text();

    if (res.status === 429) {
      console.log("Telegram error 429", txt);
      try {
        const data = JSON.parse(txt);
        const retry =
          data.parameters?.retry_after ?? data.retry_after;
        if (typeof retry === "number" && retry > 0 && retry < 60) {
          await new Promise((r) => setTimeout(r, retry * 1000));
          continue; // повторяем ту же отправку
        }
      } catch {
        // ignore
      }
      return false;
    }

    if (!res.ok) {
      console.log("Telegram error", res.status, txt);
      return false;
    }

    return true;
  }

  return false;
}

function buildCaption(ad: Ad): string {
  const locStr = ad.location || "Бишкек, район не указан";
  const priceStr = ad.price_kgs != null
    ? `${ad.price_kgs.toLocaleString("ru-RU")} KGS`
    : "Цена не указана";
  const roomsStr =
    ad.rooms != null ? String(ad.rooms) : "—";

  const lines: string[] = [];

  lines.push(locStr);
  lines.push("");
  lines.push(`Количество комнат: ${roomsStr}`);
  lines.push("Тип недвижимости: Квартира");
  lines.push("Тип предложения: Собственник");
  lines.push("");
  lines.push(`Цена: ${priceStr}`);
  if (ad.owner_name) {
    lines.push(`Контакт: ${ad.owner_name}`);
  }
  lines.push(`Телефон: ${ad.phone ?? "не указан"}`);
  if (ad.created_raw) {
    lines.push(`Объявление от: ${ad.created_raw}`);
  }

  // без описания снизу
  return lines.join("\n");
}

async function sendAd(ad: Ad): Promise<boolean> {
  const caption = buildCaption(ad);
  const images = ad.images.slice(0, 10);

  if (!images.length) {
    const ok = await tgSend("sendMessage", {
      chat_id: CHAT_ID,
      text: caption,
      parse_mode: "HTML",
      disable_web_page_preview: true,
    });
    return ok;
  }

  const media = images.map((url, idx) => {
    const obj: Record<string, unknown> = {
      type: "photo",
      media: url,
    };
    if (idx === 0) {
      obj.caption = caption;
      obj.parse_mode = "HTML";
    }
    return obj;
  });

  const ok = await tgSend("sendMediaGroup", {
    chat_id: CHAT_ID,
    media,
  });
  return ok;
}

/* ================= ОДИН ПРОХОД ================= */

async function runOnce(): Promise<void> {
  console.log("Run scrape...");
  const ads = await fetchAds();
  console.log(`Fetched ${ads.length} ads`);

  for (const ad of ads) {
    if (await hasSeen(ad.id)) continue;

    const sent = await sendAd(ad);
    if (sent) {
      await markSeen(ad.id);
    }

    // пауза между объявлениями, чтобы меньше ловить 429
    await new Promise((r) => setTimeout(r, 2500));
  }
}

/* ================= CRON + HTTP ================= */

Deno.cron("lalafo-bishkek-rent", "*/5 * * * *", async () => {
  try {
    await runOnce();
  } catch (e) {
    console.error("Cron error", e);
  }
});

Deno.serve(async (req) => {
  const url = new URL(req.url);
  if (url.pathname === "/run") {
    await runOnce();
    return new Response("ok\n");
  }
  return new Response("alive\n");
});
