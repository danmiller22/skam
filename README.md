# Lalafo → Telegram бот под Deno Deploy

Берёт с lalafo.kg долгосрочную аренду квартир в Бишкеке и шлёт в Telegram:

- 1–2 комнатные
- до 60 000 KGS
- по возможности только от собственников
- с красивой шапкой и всеми фото (до 10 штук)

## Файлы

- `mod.ts` — весь код бота (скрейпер + Telegram + cron + HTTP).
- `deno.json` — конфиг для Deno / Deno Deploy.

## ENV-переменные

Обязательно:

- `TELEGRAM_BOT_TOKEN` — токен бота из BotFather.
- `TELEGRAM_CHAT_ID` — ID чата/канала/группы (строкой).

Опционально:

- `CITY_SLUG` (по умолчанию `bishkek`)
- `MAX_PRICE_KGS` (по умолчанию `60000`)
- `ROOMS` (строка, по умолчанию `1,2`)
- `OWNER_ONLY` (`true` / `false`, по умолчанию `true`)
- `ADS_LIMIT` (по умолчанию `20`)
- `PAGES` (по умолчанию `2`)

## Локальный запуск

```bash
deno task dev
```

(Перед этим поставь ENV-переменные.)

## Deno Deploy

1. Заливаешь этот проект в GitHub.
2. Создаёшь новый проект в Deno Deploy, entrypoint — `mod.ts`.
3. В Deno Deploy настраиваешь ENV, как выше.
4. KV-хранилище: используется `Deno.openKv()`, убедись, что оно включено для проекта.
5. Cron уже прописан в коде:

```ts
Deno.cron("lalafo-bishkek-rent", "*/5 * * * *", async () => {
  await runOnce();
});
```

`runOnce()` запускается раз в 5 минут, бот работает автономно.

Ручной запуск: перейди по `/run` на URL проекта, чтобы принудительно выполнить один проход.
