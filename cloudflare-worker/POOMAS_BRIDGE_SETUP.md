# Live Agency → POOMAS bridge

The Live Travel Agency UI loads `frontend/live-travel-poomas.js` and talks only to the Leadvyne bridge Worker. The browser never receives the POOMAS integration secret.

## Behaviour

- POOMAS is disabled per client by default.
- A client enables it from Live Agency → Suppliers → POOMAS API.
- When enabled, Flight Search adds live POOMAS fares to the existing supplier results.
- Bookable Duffel/POOMAS fares expose **Continue to checkout** and redirect to `https://flypoomas.com/book?...`.
- Live PNR lookup appears in the Live Agency navigation only when POOMAS is enabled.
- The bridge re-checks the per-client enabled flag on every search and PNR request, so hiding the UI is not the security boundary.

## Cloudflare secret

Create one long random value and store the same value as `POOMAS_INTEGRATION_KEY` in both Workers:

```bash
# Leadvyne bridge
cd cloudflare-worker
wrangler secret put POOMAS_INTEGRATION_KEY --config wrangler.poomas.toml

# POOMAS API (run from the POOMAS apps/api project)
wrangler secret put POOMAS_INTEGRATION_KEY
```

The POOMAS PNR endpoint rejects requests when the secret is missing or does not match.

## Bridge deployment

`.github/workflows/deploy-poomas-bridge.yml` deploys `leadvyne-poomas-bridge` when the bridge files change. The repository needs `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` Actions secrets.

Expected Worker URL:

`https://leadvyne-poomas-bridge.leadvyne.workers.dev`
