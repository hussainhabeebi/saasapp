# Leadvyne Android app (TWA)

A Trusted Web Activity: a small Android app that opens `https://app.leadvyne.com/m.html?src=twa`
full-screen in Chrome — no address bar, its own icon, its own entry in the app switcher. It is the
same phone app the website already serves (`frontend/m.html`), so every website deploy reaches the
app at once; the APK only needs rebuilding to change the icon, name, colours or start page.

Generated with Bubblewrap (`@bubblewrap/core` 1.24.1), settings in `twa-manifest.json`. Package id
`com.leadvyne.app`.

## What it changes for existing users

Nothing. Browser and installed-PWA users get the same pages as before. The only shared pieces are:

- `frontend/.well-known/assetlinks.json` — tells Chrome this app may show app.leadvyne.com without
  an address bar. A new file; browsers never read it.
- `frontend/twa.js` — loaded by m.html, dashboard.html and chats.html, but it returns immediately
  unless the page was opened by the app (`?src=twa`, kept in that tab's sessionStorage).

## Pop-ups inside the app (`frontend/twa.js`)

Every `window.open` ends up on screen inside the app:

| Pop-up | In the app |
|---|---|
| Print / report windows (`window.open('')` + `document.write`) | an in-app sheet with Print and Close |
| `blob:` previews (quote PDF, scheduled-report preview) | HTML in the sheet; PDF/CSV downloaded |
| `tel:` / `mailto:` / `sms:` / `whatsapp:` links | handed to Android (dialer, mail, WhatsApp) |
| Our own pages (Projects, Email Marketing…) | opened in the app; Android Back returns |
| Other sites (wa.me, Chatwoot, payment pages) | Chrome tab; if Chrome blocks it, an **Open** bar appears |

Alerts, confirms, the file/photo picker, camera, microphone and downloads work as in Chrome.
Notifications: Android asks once for permission for the app.

Sign-in goes through `secure.leadvyne.com` (Authentik). That page is on another domain, so it shows
with a small address bar while signing in, then the app returns full-screen to Home. The app shares
Chrome's sign-in on the phone, so someone already signed in to Leadvyne in Chrome is signed in here.

## Building

GitHub Actions builds it: **Actions → Android app (APK) → Run workflow** (it also runs on any push
that changes `android/`). The APK is in the run's **leadvyne-apk** artifact; a push to `main` also
creates a GitHub Release with the APK attached.

### One-time: the signing key (GitHub secrets)

Android only installs an update signed with the same key as the installed app, and
`frontend/.well-known/assetlinks.json` lists that key's SHA-256. Add these repository secrets
(**Settings → Secrets and variables → Actions → New repository secret**):

| Secret | Value |
|---|---|
| `ANDROID_KEYSTORE_BASE64` | the keystore file, base64 (one line) |
| `ANDROID_KEYSTORE_PASSWORD` | its password (the key password is the same) |

Key alias `leadvyne`. Fingerprint in `assetlinks.json` and `twa-manifest.json`:
`53:67:C5:B1:91:4C:CF:DC:20:AF:A0:87:EC:03:43:6D:37:5B:47:A1:C2:39:5E:AD:F5:71:70:92:EA:93:7A:20`.

Keep a copy of the keystore and password somewhere safe outside GitHub. If they are lost, a new
key means a new app: everyone uninstalls and reinstalls, and `assetlinks.json` gets the new
fingerprint.

Until the secrets exist the workflow still builds, with a throwaway key, and names the file
`leadvyne-TEST-…apk`: it installs but shows an address bar. Don't hand that one out.

### Publishing on Google Play later

Play re-signs apps with its own key. Add Play's "App signing key certificate" SHA-256 (Play Console
→ Setup → App integrity) as a second entry in `assetlinks.json` — keep the current one.

## Installing on a phone

Once installed, app.leadvyne.com links on that phone (a hot-lead WhatsApp alert, an invite) open in
the app instead of Chrome. Phones without the app are unaffected.

Send the APK (WhatsApp, Drive, email) and open it on the phone; Android asks to allow installing
from that app once. Updates: install the newer APK over the old one.

Check the full-screen link after a deploy: `https://app.leadvyne.com/.well-known/assetlinks.json`
must return the JSON above (Google's checker:
`https://digitalassetlinks.googleapis.com/v1/statements:list?source.web.site=https://app.leadvyne.com&relation=delegate_permission/common.handle_all_urls`).
