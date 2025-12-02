/**
 * Lalafo → Telegram бот под Deno Deploy.
 * Скрейпит долгосрочную аренду квартир в Бишкеке
 * и шлёт новые объявления в Telegram с шапкой и всеми фото.
 */

const BOT_TOKEN = Deno.env.get("TELEGRAM_BOT_TOKEN") ?? "";
const CHAT_ID = Deno.env.get("TELEGRAM_CHAT_ID") ?? "";
const CITY_SLUG = Deno.env.get("CITY_SLUG") ?? "bishkek";
const MAX_PRICE_KGS = Number(Deno.env.get("MAX_PRICE_KGS") ?? "60000");
const ROOMS = (Deno.env.get("ROOMS") ?? "1,2")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean)
  .map((s) => Number(s));
const OWNER_ONLY = (Deno.env.get("OWNER_ONLY") ?? "true") === "true";
const ADS_LIMIT = Number(Deno.env.get("ADS_LIMIT") ?? "20");
const PAGES = Number(Deno.env.get("PAGES") ?? "2");

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
}

const kv = await Deno.openKv();

/* ========= ВСПОМОГАТЕЛЬНЫЙ ПАРСИНГ HTML ========= */

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

function extractListingLinks(html: string, citySlug: string): string[] {
  const re = new RegExp(`"(/${citySlug}/ads/[^"<>]+-id-\d+)"`, "g");
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
  const re =
    /\d{2}\.\d{2}\.\d{4}\s*\/\s*\d{2}:\d{2}\s*([\s\S]+?)\s*Позвонить/i;
  const m = html.match(re);
  if (!m) return null;
  const loc = m[1].replace(/\s+/g, " ").trim();
  return loc || null;
}

function parseImages(html: string): string[] {
  const re = /https:\/\/img\d+\.lalafo\.com\/[^\"'>\s]+/g;
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
    if (opts.roomsAllowed && ad.rooms !== null &&
      !opts.roomsAllowed.includes(ad.rooms)) {
      continue;
    }
    if (opts.ownerOnly && ad.is_owner === false) {
      continue;
    }
    if (opts.maxPriceKgs !== null && ad.price_kgs !== null &&
      ad.price_kgs > opts.maxPriceKgs) {
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
      maxPriceKgs: MAX_PRICE_KGS || null,
      roomsAllowed: ROOMS.length ? ROOMS : null,
      ownerOnly: OWNER_ONLY,
    });
    for (const ad of pageAds) {
      out.push(ad);
      if (out.length >= ADS_LIMIT) return out;
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  return out;
}

/* ========= KV (сохранённые объявления) ========= */

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

function buildCaption(ad: Ad): string {
  const roomsStr = ad.rooms ? `${ad.rooms}к` : "квартира";
  const priceStr = ad.price_kgs != null
    ? `${ad.price_kgs.toLocaleString("ru-RU")} KGS`
    : "Цена не указана";
  const locStr = ad.location || "Бишкек";

  const header = `🏠 <b>Аренда ${roomsStr} в Бишкеке</b>\n`;
  const priceLine = `💰 <b>${priceStr}</b>\n`;
  const locLine = `📍 ${locStr}\n`;

  const meta: string[] = [];
  if (ad.is_owner === true) meta.push("от собственника");
  else if (ad.is_owner === false) meta.push("от агентства/риэлтора");
  if (ad.created_raw) meta.push(ad.created_raw);
  const metaLine = meta.length ? `ℹ️ ${meta.join(" • ")}\n` : "";

  const linkLine =
    `\n🔗 <a href="${ad.url}">Открыть объявление на Lalafo</a>`;

  return header + priceLine + locLine + metaLine + linkLine;
}

async function sendAd(ad: Ad): Promise<void> {
  const caption = buildCaption(ad);
  const images = ad.images.slice(0, 10);

  if (!images.length) {
    await tgSend("sendMessage", {
      chat_id: CHAT_ID,
      text: caption,
      parse_mode: "HTML",
      disable_web_page_preview: false,
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

/* ========= Один проход ========= */

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

/* ========= Cron для Deno Deploy ========= */

Deno.cron("lalafo-bishkek-rent", "*/5 * * * *", async () => {
  try {
    await runOnce();
  } catch (e) {
    console.error("Cron error", e);
  }
});

/* ========= HTTP-сервер ========= */

Deno.serve(async (req) => {
  const url = new URL(req.url);
  if (url.pathname === "/run") {
    await runOnce();
    return new Response("ok\n");
  }
  return new Response("alive\n");
});
