/**
 * Lalafo → Telegram бот под Deno Deploy.
 *
 * Скрейпит объявления о долгосрочной аренде квартир в Бишкеке и
 * отправляет новые объявления в Telegram. Настройки фильтрации читаются
 * из переменных окружения. По умолчанию бот показывает только
 * одно- и двухкомнатные квартиры, но цену не ограничивает и пытается
 * отправить все найденные объявления.
 *
 * В сообщении используется развернутое обозначение комнат ("одна
 * комната", "две комнаты"), полноценно выводится район и копируется
 * описание объявления. Ссылка на Lalafo не добавляется.
 */

const BOT_TOKEN = Deno.env.get("TELEGRAM_BOT_TOKEN") ?? "";
const CHAT_ID = Deno.env.get("TELEGRAM_CHAT_ID") ?? "";
const CITY_SLUG = Deno.env.get("CITY_SLUG") ?? "bishkek";
// Максимальная цена не применяется по умолчанию. Можно задать через
// переменную окружения MAX_PRICE_KGS для ограничения объявлений.
const MAX_PRICE_KGS = Deno.env.get("MAX_PRICE_KGS")
  ? Number(Deno.env.get("MAX_PRICE_KGS"))
  : null;
// Список допустимых комнат. Строка вида "1,2" превращается в [1, 2].
const ROOMS = (Deno.env.get("ROOMS") ?? "1,2")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean)
  .map((s) => Number(s));
// Если OWNER_ONLY=true, бот пропускает объявления от агентств.
const OWNER_ONLY = (Deno.env.get("OWNER_ONLY") ?? "true").toLowerCase() ===
  "true";
// Ограничение количества объявлений за один проход. Можно увеличить,
// например, до 50–100 для большего охвата.
const ADS_LIMIT = Deno.env.get("ADS_LIMIT")
  ? Number(Deno.env.get("ADS_LIMIT"))
  : 50;
// Количество страниц для скрейпа. Каждая страница обычно содержит ~24
// объявлений. Увеличение числа страниц позволит ботy находить больше
// объявлений.
const PAGES = Deno.env.get("PAGES") ? Number(Deno.env.get("PAGES")) : 10;

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
}

// Хранилище для запоминания уже отправленных объявлений. Deno KV
// автоматически создается на стороне Deno Deploy.
const kv = await Deno.openKv();

/* ========= ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ ========= */

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
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} for ${url}`);
  }
  return await res.text();
}

/**
 * Ищет ссылки на объявления на странице выдачи.
 * Ссылки имеют формат /bishkek/ads/...-id-123456789. Мы не
 * полагаемся на кавычки вокруг ссылок, а вытаскиваем любой
 * подходящий фрагмент пути.
 */
function extractListingLinks(html: string, citySlug: string): string[] {
  const re = new RegExp(
    `(\\/${citySlug}\\/ads\\/[^"'<>\\s]+-id-\\d+)`,
    "g",
  );
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

function parsePriceKgs(html: string): number | null {
  const m = html.match(/([\d\s]{2,})\s*KGS/);
  if (!m) return null;
  const raw = m[1].replace(/\s+/g, "");
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

function parseRooms(html: string): number | null {
  const m = html.match(/(\d)\s+комнат[аы]/i);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : null;
}

function parseIsOwner(html: string): boolean | null {
  const hasOwner = html.includes("Собственник");
  const hasAgent = html.includes("Риэлтор") || html.includes("Агентств");
  if (hasOwner && !hasAgent) return true;
  if (hasAgent) return false;
  return null;
}

function parseCreated(html: string): string | null {
  const m = html.match(/(\d{2}\.\d{2}\.\d{4}\s*\/\s*\d{2}:\d{2})/);
  return m ? m[1] : null;
}

function stripTags(s: string): string {
  return s.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

function parseTitle(html: string): string | null {
  const h1 = extractFirst(/<h1[^>]*>([\s\S]*?)<\/h1>/i, html);
  if (h1) return stripTags(h1);
  const t = extractFirst(/<title[^>]*>([\s\S]*?)<\/title>/i, html);
  return t ? stripTags(t) : null;
}

function parseLocation(html: string): string | null {
  // Ищем участок после даты/времени и до слова "Позвонить". Это
  // поле обычно содержит район и условия (например, "Восток-5 мкр,Без
  // подселения,Собственник"). Если не найдено — возвращаем null.
  const re =
    /\d{2}\.\d{2}\.\d{4}\s*\/\s*\d{2}:\d{2}\s*([\s\S]+?)\s*Позвонить/i;
  const m = html.match(re);
  if (!m) return null;
  const loc = m[1].replace(/\s+/g, " ").trim();
  return loc || null;
}

function parseImages(html: string): string[] {
  // Ищем ссылку на изображение из блока posters. Если нужно больше
  // фотографий, ограничиваемся 10.
  const re = /https:\\/\\/img\d+\.lalafo\.com\\/[^\s"'<>]+/g;
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

/**
 * Извлекает основное описание объявления. Сначала пытаемся найти
 * контейнер с классом descriptionWrap, который содержит весь текст
 * описания. Если не удаётся, пытаемся взять meta description.
 */
function parseDescription(html: string): string | null {
  // Некоторые объявления хранят описание внутри descriptionWrap
  let m = html.match(
    /<div class="descriptionWrap[^>]*>([\s\S]*?)<\/div>/i,
  );
  if (m) {
    const raw = m[1];
    const text = stripTags(raw);
    return text || null;
  }
  // Fallback: meta description
  m = html.match(/<meta[^>]+name="description"[^>]+content="([^"]+)"/i);
  if (m) {
    const text = m[1];
    return text || null;
  }
  return null;
}

async function fetchAd(url: string): Promise<Ad | null> {
  try {
    const html = await fetchHtml(url);
    const id =
      extractFirst(/-id-(\d+)/, url) ||
      new URL(url).pathname.split("/").pop() ||
      url;
    const title = parseTitle(html) ?? "Объявление на Lalafo";
    const price = parsePriceKgs(html);
    const rooms = parseRooms(html);
    const isOwner = parseIsOwner(html);
    const created = parseCreated(html);
    const location = parseLocation(html);
    const images = parseImages(html);
    const description = parseDescription(html);
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
    };
  } catch (e) {
    console.log("fetchAd error", e);
    return null;
  }
}

async function fetchAdsPage(
  page: number,
  opts: {
    maxPriceKgs: number | null;
    roomsAllowed: number[] | null;
    ownerOnly: boolean;
  },
): Promise<Ad[]> {
  const path =
    `/${CITY_SLUG}/kvartiry/arenda-kvartir/dolgosrochnaya-arenda-kvartir?page=${page}`;
  const html = await fetchHtml(new URL(path, BASE_URL).toString());
  const links = extractListingLinks(html, CITY_SLUG);
  const ads: Ad[] = [];
  for (const link of links) {
    const ad = await fetchAd(link);
    if (!ad) continue;
    if (
      opts.roomsAllowed && ad.rooms !== null &&
      !opts.roomsAllowed.includes(ad.rooms)
    ) {
      continue;
    }
    if (opts.ownerOnly && ad.is_owner === false) {
      continue;
    }
    if (
      opts.maxPriceKgs !== null && ad.price_kgs !== null &&
      ad.price_kgs > opts.maxPriceKgs
    ) {
      continue;
    }
    ads.push(ad);
  }
  return ads;
}

async function fetchAds(): Promise<Ad[]> {
  const out: Ad[] = [];
  for (let page = 1; page <= PAGES; page++) {
    const pageAds = await fetchAdsPage(page, {
      maxPriceKgs: MAX_PRICE_KGS,
      roomsAllowed: ROOMS.length ? ROOMS : null,
      ownerOnly: OWNER_ONLY,
    });
    for (const ad of pageAds) {
      out.push(ad);
      if (out.length >= ADS_LIMIT) return out;
    }
    // небольшая пауза между страницами, чтобы не нагружать сервер
    await new Promise((r) => setTimeout(r, 1000));
  }
  return out;
}

/* ========= KV ========= */

async function hasSeen(id: string): Promise<boolean> {
  const res = await kv.get(["seen", id]);
  return Boolean(res.value);
}

async function markSeen(id: string): Promise<void> {
  await kv.set(["seen", id], true);
}

/* ========= Telegram ========= */

async function tgSend(
  method: string,
  payload: Record<string, unknown>,
): Promise<void> {
  if (!BOT_TOKEN || !CHAT_ID) {
    console.log("TELEGRAM_BOT_TOKEN/CHAT_ID not set, skip send");
    return;
  }
  const url = `https://api.telegram.org/bot${BOT_TOKEN}/${method}`;
  const form = new FormData();
  for (const [k, v] of Object.entries(payload)) {
    if (k === "media") {
      form.append(k, JSON.stringify(v));
    } else {
      form.append(k, String(v));
    }
  }
  const res = await fetch(url, { method: "POST", body: form });
  if (!res.ok) {
    const txt = await res.text();
    console.log("Telegram error", res.status, txt);
  }
}

function roomsToWords(rooms: number | null): string {
  if (rooms === 1) return "одна комната";
  if (rooms === 2) return "две комнаты";
  return "квартира";
}

function buildCaption(ad: Ad): string {
  const roomsWord = roomsToWords(ad.rooms);
  const header = `🏠 <b>Аренда ${roomsWord} в Бишкеке</b>\n`;
  const priceStr = ad.price_kgs != null
    ? `${ad.price_kgs.toLocaleString("ru-RU")} KGS`
    : "Цена не указана";
  const priceLine = `💰 <b>${priceStr}</b>\n`;
  // Используем распарсенный район, если он есть, иначе просто "Бишкек"
  const locStr = ad.location || "Бишкек";
  const locLine = `📍 ${locStr}\n`;
  const meta: string[] = [];
  if (ad.is_owner === true) meta.push("от собственника");
  else if (ad.is_owner === false) meta.push("от агентства/риэлтора");
  if (ad.created_raw) meta.push(ad.created_raw);
  const metaLine = meta.length ? `ℹ️ ${meta.join(" • ")}\n` : "";
  const description = ad.description ? `\n${ad.description}` : "";
  return header + priceLine + locLine + metaLine + description;
}

async function sendAd(ad: Ad): Promise<void> {
  const caption = buildCaption(ad);
  const images = ad.images.slice(0, 10);
  // Если нет изображений, отправляем как обычное сообщение
  if (!images.length) {
    await tgSend("sendMessage", {
      chat_id: CHAT_ID,
      text: caption,
      parse_mode: "HTML",
      disable_web_page_preview: false,
    });
    return;
  }
  // Отправляем в виде медиагруппы: caption добавляем только к первой фотографии
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
  await tgSend("sendMediaGroup", {
    chat_id: CHAT_ID,
    media,
  });
}

/* ========= Один проход ========= */

async function runOnce(): Promise<void> {
  console.log("Run scrape...");
  const ads = await fetchAds();
  console.log(`Fetched ${ads.length} ads`);
  for (const ad of ads) {
    if (await hasSeen(ad.id)) continue;
    await sendAd(ad);
    await markSeen(ad.id);
    // Пауза между отправками, чтобы не превысить лимиты Telegram
    await new Promise((r) => setTimeout(r, 1500));
  }
}

/* ========= Cron и HTTP-сервер ========= */

// Автозапуск каждые пять минут на Deno Deploy
Deno.cron("lalafo-bishkek-rent", "*/5 * * * *", async () => {
  try {
    await runOnce();
  } catch (e) {
    console.error("Cron error", e);
  }
});

// HTTP endpoint: GET /run выполняет проход сразу
Deno.serve(async (req) => {
  const url = new URL(req.url);
  if (url.pathname === "/run") {
    await runOnce();
    return new Response("ok\n");
  }
  return new Response("alive\n");
});