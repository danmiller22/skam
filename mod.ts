/**
 * Lalafo → Telegram бот под Deno Deploy.
 *
 * Скрейпит объявления о долгосрочной аренде квартир в Бишкеке
 * и отправляет новые объявления в Telegram.
 *
 * Формат сообщения:
 *
 * 🏠 Аренда две комнаты в Бишкеке
 * 💰 50 000 KGS
 * 📍 Бишкек, Тунгуч мкр
 * 🛏 Комнат: 2
 * 👤 Контакт: Baha
 * ℹ️ от собственника • 16.11.2025 / 16:28
 *
 * <описание объявления>
 */

const BOT_TOKEN = Deno.env.get("TELEGRAM_BOT_TOKEN") ?? "";
const CHAT_ID = Deno.env.get("TELEGRAM_CHAT_ID") ?? "";

// по умолчанию: Бишкек, без фильтров по комнатам/собственнику
const CITY_SLUG = Deno.env.get("CITY_SLUG") ?? "bishkek";
const PAGES = Number(Deno.env.get("PAGES") ?? "3");
const ADS_LIMIT = Number(Deno.env.get("ADS_LIMIT") ?? "100");

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
}

const kv = await Deno.openKv();

/* ================= ВСПОМОГАТЕЛЬНЫЙ ПАРСИНГ ================= */

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
 * Ссылки на объявления:
 * /bishkek/ads/...-id-123456789
 */
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
  // Попытка вытащить город/район из структурированных данных
  const mCity = html.match(/"addressLocality"\s*:\s*"([^"]+)"/);
  const mStreet = html.match(/"streetAddress"\s*:\s*"([^"]+)"/);
  if (mCity || mStreet) {
    const parts = [mCity?.[1], mStreet?.[1]].filter(Boolean) as string[];
    const combined = parts.join(", ");
    if (combined) return combined;
  }

  // Fallback — эвристика по дате и слову «Позвонить»
  const re =
    /\d{2}\.\d{2}\.\d{4}\s*\/\s*\d{2}:\d{2}\s*([\s\S]+?)\s*Позвонить/i;
  const m = html.match(re);
  if (!m) return null;
  const loc = m[1].replace(/\s+/g, " ").trim();
  return loc || null;
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

function parseDescription(html: string): string | null {
  // 1) блок описания
  const byDataTestId = extractFirst(
    /<div[^>]+data-testid="ad-description"[^>]*>([\s\S]*?)<\/div>/i,
    html,
  );
  let desc = byDataTestId;

  // 2) itemprop=description
  if (!desc) {
    const pDesc = extractFirst(
      /<p[^>]*itemprop="description"[^>]*>([\s\S]*?)<\/p>/i,
      html,
    );
    desc = pDesc;
  }

  // 3) meta description
  if (!desc) {
    const meta = extractFirst(
      /<meta\s+name="description"\s+content="([\s\S]*?)"/i,
      html,
    );
    desc = meta;
  }

  if (!desc) return null;

  const clean = stripTags(desc);
  if (!clean) return null;

  // Чтобы не упираться в лимит telegram по caption/description
  return clean.slice(0, 1500);
}

function parseOwnerName(html: string): string | null {
  // Попытка вытащить имя из JSON
  const m1 = html.match(/"sellerName"\s*:\s*"([^"]+)"/);
  if (m1 && m1[1]) return m1[1];

  const m2 = html.match(/"userName"\s*:\s*"([^"]+)"/);
  if (m2 && m2[1]) return m2[1];

  // По data-testid
  const byTestId = extractFirst(
    /data-testid="seller-name"[^>]*>([\s\S]*?)<\/[^>]+>/i,
    html,
  );
  if (byTestId) return stripTags(byTestId);

  // Общий fallback
  const byLabel = extractFirst(
    /Владелец[^<]*<\/[^>]+>\s*<[^>]*>([\s\S]*?)<\/[^>]+>/i,
    html,
  );
  if (byLabel) return stripTags(byLabel);

  return null;
}

async function fetchAd(url: string): Promise<Ad | null> {
  try {
    const html = await fetchHtml(url);
    const id =
      extractFirst(/-id-(\d+)/, url) ??
      new URL(url).pathname.split("/").pop() ??
      url;
    const title = parseTitle(html) ?? "Объявление на Lalafo";
    const price = parsePriceKgs(html);
    const rooms = parseRooms(html);
    const isOwner = parseIsOwner(html);
    const created = parseCreated(html);
    const location = parseLocation(html);
    const images = parseImages(html);
    const description = parseDescription(html);
    const ownerName = parseOwnerName(html);

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
    };
  } catch (e) {
    console.log("fetchAd error", e);
    return null;
  }
}

async function fetchAdsPage(page: number): Promise<Ad[]> {
  const path =
    `/${CITY_SLUG}/kvartiry/arenda-kvartir/dolgosrochnaya-arenda-kvartir?page=${page}`;
  const html = await fetchHtml(new URL(path, BASE_URL).toString());
  const links = extractListingLinks(html, CITY_SLUG);
  const ads: Ad[] = [];
  for (const link of links) {
    const ad = await fetchAd(link);
    if (!ad) continue;

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

/* ================= KV (seen ids) ================= */

async function hasSeen(id: string): Promise<boolean> {
  const res = await kv.get(["seen", id]);
  return Boolean(res.value);
}

async function markSeen(id: string): Promise<void> {
  await kv.set(["seen", id], true);
}

/* ================= TELEGRAM ================= */

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
  if (rooms && rooms > 2) return `${rooms} комнат`;
  return "квартира";
}

function buildCaption(ad: Ad): string {
  const roomsPhrase = roomsToWords(ad.rooms);
  const priceStr = ad.price_kgs != null
    ? `${ad.price_kgs.toLocaleString("ru-RU")} KGS`
    : "Цена не указана";
  const locStr = ad.location || "Бишкек";

  const header = `🏠 <b>Аренда ${roomsPhrase} в Бишкеке</b>\n`;
  const priceLine = `💰 <b>${priceStr}</b>\n`;
  const locLine = `📍 ${locStr}\n`;

  const roomsLine =
    ad.rooms != null ? `🛏 Комнат: ${ad.rooms}\n` : "";

  const contactLine = ad.owner_name
    ? `👤 Контакт: ${ad.owner_name}\n`
    : "";

  const meta: string[] = [];
  if (ad.is_owner === true) meta.push("от собственника");
  else if (ad.is_owner === false) meta.push("от агентства/риэлтора");
  if (ad.created_raw) meta.push(ad.created_raw);
  const metaLine = meta.length ? `ℹ️ ${meta.join(" • ")}\n` : "";

  let descPart = "";
  if (ad.description) {
    descPart = `\n${ad.description}`;
  }

  // НИКАКИХ ссылок на Lalafo — только шапка + описание
  return header + priceLine + locLine + roomsLine + contactLine + metaLine +
    descPart;
}

async function sendAd(ad: Ad): Promise<void> {
  const caption = buildCaption(ad);
  const images = ad.images.slice(0, 10);

  if (!images.length) {
    await tgSend("sendMessage", {
      chat_id: CHAT_ID,
      text: caption,
      parse_mode: "HTML",
      disable_web_page_preview: true,
    });
    return;
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

  await tgSend("sendMediaGroup", {
    chat_id: CHAT_ID,
    media,
  });
}

/* ================= ОДИН ПРОХОД ================= */

async function runOnce(): Promise<void> {
  console.log("Run scrape...");
  const ads = await fetchAds();
  console.log(`Fetched ${ads.length} ads`);

  for (const ad of ads) {
    if (await hasSeen(ad.id)) continue;
    await sendAd(ad);
    await markSeen(ad.id);
    await new Promise((r) => setTimeout(r, 1500));
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
