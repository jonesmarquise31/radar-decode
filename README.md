# The Radar Decode

Source for [radar-decode.netlify.app](https://radar-decode.netlify.app) — a $47 standalone product in the [Workforce Radar](https://workforceradar.com) line. One-page operator brief, written by hand, anchored to a buyer's actual LinkedIn and resume. Entry tier of the Radar pricing ladder.

## What's in this repo

- `index.html` — landing page (single-file, all CSS and JS inline, no build step, page weight under 6KB before fonts)
- `thanks.html` — post-payment intake form (reads `?session_id` from Stripe redirect, multipart upload to function)
- `og-image.png` — 1200×630 OG card
- `netlify.toml` — Netlify config: publish dir, functions path, `/thanks` rewrite
- `netlify/functions/`
  - `submit-decode.js` — receives the intake form; verifies the Stripe session is paid and matches the configured price before any write; uploads resume to a private Supabase Storage bucket; inserts row to `decode_submissions`. Idempotent on `stripe_session_id`.
  - `stripe-webhook.js` — receives `checkout.session.completed` events with signed payloads; posts a one-line buy alert to Telegram. Returns 200 to Stripe regardless of Telegram success.

## Architecture and decisions

The full V41 build log is in the [Radar-Platform repo](https://github.com/jonesmarquise31/Radar-Platform/blob/main/build-log/v41-radar-decode.md): the decision (concurrent LinkedIn distribution surge + beta-tester critique of the main platform), the architecture (separate domain, two functions, additive Supabase table, real-time alerts), the five-phase build, and trade-offs (live mode from day one, smoke-test-as-substitute-for-E2E, the operator-only error vocabulary).

Engineering patterns extracted from this build, documented for reuse and review:

- [**Verify-before-write with Stripe**](https://github.com/jonesmarquise31/Radar-Platform/blob/main/patterns/stripe-verify-before-write.md) — re-verify payment server-side at every payment-gated write; client-side validation does not substitute
- [**Idempotent submissions**](https://github.com/jonesmarquise31/Radar-Platform/blob/main/patterns/idempotent-submissions.md) — pre-check + unique-constraint catch + `upsert: true` on file uploads
- [**Real-time buy alerts**](https://github.com/jonesmarquise31/Radar-Platform/blob/main/patterns/realtime-buy-alerts.md) — Stripe webhook to Telegram, fire-and-forget with 200-to-Stripe regardless of chat success

## Stack

Static HTML, vanilla JavaScript, inline CSS. Netlify Functions (Node.js 18+). `busboy` for multipart parsing. `@supabase/supabase-js` for database + storage. `stripe` for verification + webhooks. Google Fonts (Bebas Neue, Cormorant Garamond, DM Mono) is the only external dependency on the frontend.

## Brand system

Visual treatment follows the documented [Radar brand system](https://github.com/jonesmarquise31/Radar-Platform/blob/main/design/brand-system.md): four-color palette (navy, gold, white, cream), three-family typography (Bebas Neue display, Cormorant Garamond body, DM Mono metadata), V39.1 stat block component treatment, no stock photos, no icons, no badges, no animation that isn't functional.

## License

The contents of this public repo are © 2026 Marquise Jones. The Radar product, diagnostic engine, archetype framework, and all proprietary methodology are not licensed for external use.
