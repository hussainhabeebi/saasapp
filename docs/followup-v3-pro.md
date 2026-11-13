# Follow-up V3 · Pro add-ons

Five optional switches on top of Follow-up V3. **Every one is off by default**, so an account that
never switches them on keeps exactly the V3 behaviour it had. Switch them on in
🔁 Follow-ups → Settings → ✨ Pro add-ons.

Code: `cloudflare-worker/followup-pro.js` (pure helpers + quote PDF), hooks in
`cloudflare-worker/followup-v3.js`, UI in `frontend/followup-pro-ui.js`.

| Switch | What it does |
|---|---|
| `pro_smart_send` — Smart send time+ | V3 already sends day 1/3/7 templates at the lead's own usual hour once it knows it. With this on, a lead with no history yet uses the **account's** busiest reply hour (needs 20+ messages and a clear peak). **Nudge 2** also waits for that hour, but only when it still lands at least 30 min before the 24-hour WhatsApp window closes. |
| `pro_nba_home` — Next-best-action on Home | Scores every open lead 0-100 (recency, a person owes a reply, replies to follow-ups, message count, win probability, Hot/Warm, quote/payment stage, deal value, sentiment, objection, snooze). Gives one action each, such as "Reply now", "Send the quote with a budget option", "Check back on the date they asked" or "Ask for the decision". Home shows the top 10 as **🎯 Who to contact now**. Staff see only leads they own or that are shared with them. |
| `pro_objections` — Objection-aware follow-ups | Dates in "talk later" messages snooze the whole sequence until that date, and day 1/3/7 restart from it. Recognised: tomorrow, day after, this evening, next week, next month, in N days/weeks, after salary, a weekday name, plus Manglish/Hinglish/Malayalam/Hindi words. Price, family ("ask my wife"), trust, competitor and timing objections get a nudge written for that objection, even when the Objection Playbook has no answer. A Playbook answer still wins when there is one. |
| `pro_quote_pdf` — Quote PDF in one tap | A **📄 Quote PDF** button on the lead's Follow-up card (CRM and Chats). It opens a picker with the lead's chosen products already ticked: LastProductSku first, then InterestedProduct, Brand or ProductCategory. Add quantities, extra lines and a discount, then **Preview** or **Send on WhatsApp**. The A4 PDF carries your logo, product photos (JPEG/PNG), prices, total and validity. If `pro_objections` is also on, a price or family nudge carries the quote automatically, at most once every 3 days per lead. |
| `pro_auto_language` — Reply in the lead's language | Nudges 1-2 are written in the language of the lead's **latest** message (script detection, then the engine classifier's per-message language). Manglish and Hinglish stay in English letters. Day 1/3/7 templates use the same template name approved in the lead's language when your WhatsApp account has one. If not, they use the original language. The quote caption is translated; the PDF itself stays in English (standard PDF fonts are Latin-only). |

## What changed where (all inert while the switches are off)

- `fv3Decide`: account-hour fallback and nudge-2 alignment (`pro_smart_send`), and the snooze (`pro_objections`).
- `fv3OnInbound`: when any of objections / language / Home is on, it stores the latest message, its language and a snooze date in the new
  `followup_v3_leads.last_text / last_lang / snooze_until` columns. The engine webhook now passes the message text and `routing.customerLanguage`.
- Send path: objection text, translation, templates in the lead's language, and the quote attachment.
  `sendFollowupLadderStep` (worker.js) honours `opts.translate`, `opts.lang` and `opts.attachment` only when V3 passes them.
- New routes: `GET /followups/v3/nba`, `GET /followups/v3/quote/catalog?lead_id=`, `POST /followups/v3/quote`
  (`send:false` returns the PDF; `send:true` posts it into the chat and refuses when the 24-hour window is closed).
- New table `followup_v3_quotes`, created lazily like the other V3 tables.
- Client field `followup_pro_nba` mirrors the Home switch, so Home makes **no** extra request for accounts that don't use it.

## Quote catalog

Ecommerce products (`ecom_products_mirror` / Products table, `image_url` … `image_url_5`), plus
Travel Agency packages for travel accounts. With no catalog, add lines by hand in the picker.

## Tests

- `node --test followup-pro.test.js followup-v3.test.js`, run from `cloudflare-worker`.
- `npx playwright test tests/followup-pro.spec.js tests/campaigns-workspaces.spec.js`, run from `frontend`.
