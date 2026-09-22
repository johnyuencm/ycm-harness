---
name: integrating-google-adsense
description: >-
  Connect a public website to Google AdSense: publisher script, google-adsense-account
  meta, ads.txt, Content-Security-Policy, and manual display units. Use when the user
  pastes an adsbygoogle.js snippet or ca-pub id, asks to connect AdSense, show ads,
  fix ads.txt, or replace ad placeholders after Ads.txt Authorized or Getting ready.
---

# Integrating Google AdSense with a website

Use this for **website** AdSense (`adsense.google.com`, left nav has **Sites**). AdSense for YouTube has no Sites list and cannot approve a website. One publisher account per person; use the same Google account for the site.

Publisher ids are public. Treat only unrelated tokens (Search Console, API keys) as secrets.

## Read the account state before changing code

| What the user sees | Meaning | What to do |
| --- | --- | --- |
| Ads.txt **Authorized** | `ads.txt` contains this publisher id | Leave `ads.txt` alone |
| Approval **Getting ready** | Google is reviewing the site | Do not remove and re-add the site. Finish every Home setup card (payments, address, phone) or the review never starts. Ads do not fill yet |
| **Requires review** | Checks have not been requested | Place the code, then **Request review** on that site |
| **Ready** | Site may show ads | Fill happens only after ad units are on the page; first impressions can take about an hour |
| **Needs attention** | Policy or reachability problem | Read Policy center. Do not add more units to bypass it |

**Authorized** and **Ready** are different. A green ads.txt status does not mean ads will render.

Review usually takes a few days and can take 2–4 weeks. The site must be publicly reachable: no login wall, no deployment protection, one canonical host. Extra projects serving the same repo split the review across hosts.

## Inventory this repo

Discover; do not assume a framework:

- Document shell (root layout, `<head>`, or equivalent)
- Existing Content-Security-Policy
- How a public build-time env var is exposed to client and server
- Production origin the user wants reviewed
- Whether `/ads.txt` already exists

## Accept only these ids

- Publisher: `ca-pub-` plus 10–20 digits. Read it from `client=` on an `adsbygoogle.js` URL, from env, or from the user. Reject anything else.
- Slot: digits only, 6–20 characters, from `data-ad-slot`. Reject `ca-pub-` pasted into a slot.
- On a bad value, skip the script, meta, and `ads.txt` row. Never interpolate an unvalidated id into a URL or `ads.txt` line.

`ads.txt` uses `pub-`, not `ca-pub-`. Strip the `ca-` prefix.

```text
google.com, pub-PUBLISHER_DIGITS, DIRECT, f08c47fec0942fa0
```

That certification-authority id is Google’s standard AdSense `ads.txt` token.

## Ship these together

1. **Loader, once, sitewide.** Async script, `crossorigin="anonymous"`:

   `https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=ca-pub-DIGITS`

   In Next.js App Router, render `next/script` in the root layout with `strategy="afterInteractive"`. Other stacks: the same tag in the document shell, not once per ad slot.

2. **Account meta** on every HTML page:

   `<meta name="google-adsense-account" content="ca-pub-DIGITS">`

3. **`/ads.txt`** at the production origin, `Content-Type: text/plain; charset=utf-8`, `X-Content-Type-Options: nosniff`, exactly one line (trailing newline is fine). No comments, no second seller.

4. **CSP**, when the app already sends one. Add these hosts; do not weaken `object-src`, `base-uri`, or `frame-ancestors`:

   - `script-src`: `pagead2.googlesyndication.com`, `www.google.com`, `www.gstatic.com`, `www.googletagservices.com`, `partner.googleadservices.com`, `googleads.g.doubleclick.net`, `www.googleadservices.com`, `adservice.google.com`, `ep2.adtrafficquality.google`, `fundingchoicesmessages.google.com`
   - `connect-src`: `pagead2.googlesyndication.com`, `googleads.g.doubleclick.net`, `www.google.com`, `www.googleadservices.com`, `partner.googleadservices.com`, `adservice.google.com`, `csi.gstatic.com`, `ep1.adtrafficquality.google`, `fundingchoicesmessages.google.com`
   - `frame-src`: `googleads.g.doubleclick.net`, `tpc.googlesyndication.com`, `www.google.com`, `google.com`, `pagead2.googlesyndication.com`, `www.googleadservices.com`, `ep2.adtrafficquality.google`, `fundingchoicesmessages.google.com`
   - `img-src` must allow `https:` (ad creatives)

5. **Slots.** Reserve layout space before ids exist so the page does not jump later. Render a real `<ins class="adsbygoogle">` only when both a valid publisher id and a valid slot id exist. Otherwise show a labeled placeholder (“Advertisement” plus size), not a broken `ins`.

   ```html
   <ins class="adsbygoogle"
        style="display:block"
        data-ad-client="ca-pub-DIGITS"
        data-ad-slot="SLOT_DIGITS"
        data-ad-format="auto"
        data-full-width-responsive="true"></ins>
   ```

   After the loader, push once per `ins`: `(window.adsbygoogle = window.adsbygoogle || []).push({})`. Catch errors so an ad blocker cannot break the page.

   Match format to the box: `auto` or `horizontal` for a leaderboard, `rectangle` for 300×250. Do not force `horizontal` on a square sidebar.

6. **Manual units only.** Tell the user to leave Auto ads overlays off on pages that already reserve units. Auto ads plus manual units stacks ads.

A validated publisher id may live as a code default after the user pastes it, so production does not depend on a dashboard env write. Slot ids stay empty until the user creates Display units. `NEXT_PUBLIC_*` (and the same class of var on other frameworks) is baked at build time: changing it requires a rebuild and redeploy.

Search Console is a different product. If a verification value is present, store only the token inside `content`. Strip a full `<meta>` tag and a `google-site-verification=` prefix. Never put that token in `ads.txt`.

## Verify production

Fetch the public origin the user submitted to AdSense, not a login-gated preview URL.

- View source contains `adsbygoogle.js?client=ca-pub-DIGITS`
- View source contains `<meta name="google-adsense-account" content="ca-pub-DIGITS">`
- `GET /ads.txt` body is the single `google.com, pub-DIGITS, DIRECT, f08c47fec0942fa0` line
- Before slot ids: placeholders still visible. After a slot deploy: each wired placement has `data-ad-slot` and the placeholder copy is gone

## What to tell the user

- While status is **Getting ready**, the snippet can be live and the boxes stay empty. That is expected.
- Ask them to create **Ads → By ad unit → Display ads**, one unit per placement, and paste only the `data-ad-slot` numbers.
- After **Ready** plus a deploy that contains those numbers, the placeholders become the units.
- Do not ask them to paste the loader `<script>` into the page again once the app injects it.
