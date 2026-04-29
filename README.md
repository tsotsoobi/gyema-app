# Gyema — P2P Delivery on Pi

Built to match the [Railway design preview](https://gyema-backend-production.up.railway.app/), structured exactly like PiLApp so Pi App Studio accepts it, with a working Pi SDK integration that PiLApp itself is missing.

## What's in this build (v1)

**Real, working features:**

- ✅ **Sign in with Pi** — uses the official Pi SDK, no mocks. Loads via `<Script src="https://sdk.minepi.com/pi-sdk.js" strategy="beforeInteractive">` in `app/layout.tsx`.
- ✅ Continue as Guest — for previewing the UI outside Pi Browser.
- ✅ Two roles: **Traveller** and **Sender** (toggle in header).
- ✅ Post a Trip (Traveller) and Post a Delivery (Sender).
- ✅ Available Jobs feed.
- ✅ My Trips / My Activity with status badges.
- ✅ Tracking lookup by `GYM-XXXXXX` ID.
- ✅ Profile with stats, KYC link to `minepi.com/kyc`, sign-out.
- ✅ All four tabs: Home, My Trips, Track, Profile.
- ✅ Listings persist between sessions (localStorage).

**Honest "Coming soon" markers (v2):**

- ⏳ Pi Escrow Payment modal — clearly labeled "v2", button is disabled. Real escrow needs a backend server holding the Pi API key.
- ⏳ Cross-device listing sync — v1 listings are device-local. Pioneer A's posts aren't visible to Pioneer B until v2 backend (Supabase) is added.
- ⏳ Live GPS tracking.
- ⏳ Dispute Center.

These are visible in the UI as "Coming soon" rather than fake buttons that disappoint Pioneers and tank your engagement threshold.

## Why your previous Pi App Studio submission failed

Pi App Studio's export gave you a project missing: `package.json`, `app/page.tsx`, `next.config.mjs`, `tsconfig.json`, and `lib/pi-network.ts`. Without these, there's no app to render and no `npm run build` for Pi App Studio's validator to run.

This rebuild has all of those.

## Why PiLApp's "Sign in with Pi" doesn't work either

I noticed this while comparing your two projects. PiLApp is missing the Pi SDK script tag in `app/layout.tsx`. Without it, `window.Pi` is `undefined` when the sign-in button is clicked, and PiLApp's `lib/pi-network.ts` silently substitutes a mock — so you get fake users instead of real Pi authentication.

**To fix PiLApp**, add this to PiLApp's `app/layout.tsx` body, right before `{children}`:

```tsx
<Script src="https://sdk.minepi.com/pi-sdk.js" strategy="beforeInteractive" />
<Script id="pi-init" strategy="beforeInteractive">
  {`try { if (typeof Pi !== 'undefined') Pi.init({ version: "2.0", sandbox: true }); } catch(e){}`}
</Script>
```

And add `import Script from "next/script"` at the top of that file. That single change should make PiLApp's sign-in actually authenticate.

## Deploying from your Android phone (no terminal)

Pi App Studio's build needs a `dist/` or `.next/` output directory, which means running `npm install` and `npm run build` somewhere first.

### Option A — StackBlitz (works in your phone browser)

1. Go to https://stackblitz.com on your phone, sign in (free)
2. Tap "Create new" → "Next.js" template, then upload this zip's contents (or drag-drop)
3. StackBlitz auto-installs and runs `npm run dev` — you can preview live
4. Tap "Download" to get the built version

### Option B — Vercel (recommended, set up once)

1. Push this folder to a new GitHub repo (use the GitHub mobile app)
2. Go to https://vercel.com on your phone, sign in with GitHub
3. "Add New Project" → import your repo
4. Vercel auto-detects Next.js, builds, and gives you a `*.vercel.app` URL
5. Every push to GitHub re-deploys automatically

Vercel is the easiest long-term because future edits via GitHub mobile auto-deploy.

### Option C — Netlify (your existing setup)

Netlify also works for Next.js but needs the `@netlify/plugin-nextjs` plugin. If you stick with Netlify:

1. Push this folder to GitHub
2. In Netlify, "Import from Git" → connect the repo
3. Netlify reads `next.config.mjs` and builds with the Next.js plugin

## Connecting to Pi App Studio

Once deployed at a URL (e.g. `gyema.vercel.app` or your existing Netlify URL):

1. Open Pi Browser → `develop.pi`
2. Find the Gyema app entry → set:
   - **Development URL** = your deploy URL (e.g. `https://gyema.vercel.app`)
   - **Production URL** = `https://gyema.pinet.com`
3. Place the validation string Pi gives you into a file in `public/` named exactly what Pi specifies (replaces my placeholder)
4. Click "Verify domain" in the portal

## Going to production

When you're ready to ship to mainnet, change one line in `app/layout.tsx`:

```js
Pi.init({ version: "2.0", sandbox: true });   // ← change to:
Pi.init({ version: "2.0" });
```

Then redeploy.

## File structure

```
gyema/
├── app/
│   ├── layout.tsx        ← Pi SDK script lives here (THE fix)
│   ├── page.tsx          ← Main routing & state
│   └── globals.css       ← Purple Pi-branded theme
├── components/
│   ├── sign-in.tsx       ← Real Pi auth
│   ├── app-header.tsx    ← Traveller/Sender toggle + π balance
│   ├── bottom-nav.tsx    ← 4 tabs
│   ├── home-tab.tsx      ← Available Jobs / Post a Delivery
│   ├── trips-tab.tsx     ← My Activity + Register a Trip
│   ├── track-tab.tsx     ← Tracking ID lookup
│   ├── profile-tab.tsx   ← KYC link, stats, sign-out
│   ├── listing-detail-sheet.tsx  ← With "Coming soon" escrow modal
│   └── ui/               ← shadcn primitives (from PiLApp scaffold)
├── lib/
│   ├── pi-network.ts     ← Real SDK calls, no silent mocks
│   └── listings.ts       ← localStorage v1 (TODO: backend in v2)
└── package.json          ← Same Next.js stack as PiLApp
```

## What to do next

1. **Deploy** (StackBlitz or Vercel, instructions above).
2. **Test in Pi Browser** — tap "Sign in with Pi", verify it actually prompts for permissions (it should, unlike PiLApp).
3. **Verify domain** in Pi Developer Portal.
4. **Get 5 KYC-verified Pioneers to test it** — required for your December 19 threshold.
5. **Then** start v2: backend (Supabase), real escrow, GPS tracking.
