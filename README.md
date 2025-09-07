# Wiederkehrende To‑Do Listen – Pro

Features: Templates, Bulk‑Add, Tags/Filter/Prioritäten, PWA (offline + Web Push scaffold),
Siri‑Shortcut‑Intents (URL), Supabase Live‑Sync (optional), Vercel CI.

## Local Dev
```bash
npm install
npm run dev
```

## PWA
- Vite PWA plugin ist integriert (offlinefähig, autoUpdate).
- Icons/Manifest liegen in `public/`.
- iOS: Über Safari „Zum Home-Bildschirm“ hinzufügen.

## Push (optional)
1) Generiere VAPID Keys:
   ```bash
   npx web-push generate-vapid-keys
   ```
2) In Vercel (Project Settings → Environment Variables) setzen:
   - `VAPID_PUBLIC_KEY`
   - `VAPID_PRIVATE_KEY`
   - `SUPABASE_URL`
   - `SUPABASE_SERVICE_ROLE` (nur Server)
3) In `.env.local` für das Frontend:
   - `VITE_VAPID_PUBLIC_KEY`
   - `VITE_SUPABASE_URL`
   - `VITE_SUPABASE_ANON_KEY`
4) Deploy. In der App: „Push aktivieren“. Zum Testen: `POST /api/push-send { user_id, title, body }`

## Supabase (Sync & Kollaboration)
1) Supabase Projekt anlegen, URL & Keys kopieren.
2) `supabase_schema.sql` in SQL Editor ausführen.
3) `.env.local` befüllen (siehe oben). App neu starten.
4) Mit Magic Link einloggen → Listen/Tasks werden upserted (naive Sync).
   In Produktion: Konfliktlösung/Batching sinnvoll erweitern.

## Siri Shortcuts
- Erstelle in „Kurzbefehle“ einen Befehl, der eine URL öffnet:
  `https://DEINE-URL/?intent=add&list=Inbox&task=Milch%20#einkauf%20!high`
- Der MVP liest `intent=add` und fügt die Aufgabe der passenden Liste hinzu (wird bei Bedarf erstellt).

## Vercel CI
- `vercel.json` vorhanden.
- `.github/workflows/deploy.yml` nutzt `VERCEL_TOKEN`, `VERCEL_ORG_ID`, `VERCEL_PROJECT_ID` (als GitHub Secrets setzen).

## Hinweis
- Der Sync ist bewusst einfach gehalten. Für echte Kollaboration nutze Supabase Realtime Channels und Row‑Level‑Security (im Schema eingeschaltet). PRs willkommen.
