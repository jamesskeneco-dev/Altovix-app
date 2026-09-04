# Altovix — the app

Two pieces:

- **`../index.html`** (with `sw.js`, `manifest.webmanifest`, `icons/` at the repo root) — the Altovix app itself. One HTML page, no server. Everything (runs, claims,
  plans, the book, your ticks) is stored on the device; it ships pre-loaded with every
  committee run so far. The committee runs on your own Anthropic API key, straight from the
  phone to Anthropic. Installs from Safari with the Altovix icon and name ("Add to Home
  Screen"), full-screen, no browser chrome.
- **`ios/`** — a native iOS shell (Expo) that wraps that page for TestFlight / the App Store:
  Altovix icon, splash screen, `altovix://` deep links for the widget, safe areas that follow
  the page's light/dark theme.

Nothing in either piece is investment advice; the app holds no market feed.

---

## Part 1 — Put Altovix on your own domain (free, today)

You need a free GitHub account and the domain you already own. All of this works from a phone.

1. **GitHub account** — github.com → Sign up.
2. **Create a public repository** (free GitHub Pages needs a public repo) and get the
   files in — GitHub Desktop, or the web uploader. Then *Settings* → *Pages* → *Build and
   deployment* → Source **Deploy from a branch**, Branch **main**, folder **/ (root)** →
   *Save*. A minute later the app is live at `https://<username>.github.io/<repo>/`.
   (Live: https://jamesskeneco-dev.github.io/Altovix-app/)
3. **Point a subdomain at it** — at your domain registrar, add a DNS record:
   `CNAME  app  →  <your-github-username>.github.io`. Then *Settings* → *Pages* →
   *Custom domain* → type `app.<your-domain>` → *Save*, and tick *Enforce HTTPS* once the
   check passes (GitHub issues the certificate itself; a few minutes to an hour).
4. **Install** — open `https://app.<your-domain>/` in **Safari** → Share → *Add to Home
   Screen*. That is the Altovix icon and name on your phone, opening full-screen. Remove the
   old claude.ai shortcut.
5. **API key** — console.anthropic.com → *API keys* → create one (billing needs a card or
   prepaid credits). In the app: *Settings* → paste it → *Check key & load models*. A full
   eight-agent run is roughly 20–30¢; a quick four-agent run about half that.
6. **Back up** now and then — *Settings* → *Share backup* (to Files, Notes, or mail it to
   yourself). Restoring onto a new phone is *Settings* → paste → *Restore*.

**Updates:** when the app changes, commit and push the new `index.html` (GitHub Desktop:
Commit → Push), Pages republishes within a minute, and the phone picks the new version up
on its next launch (the second launch, if it was installed from Safari: the offline cache
updates in the background).

---

## Part 2 — A real app on your phone (TestFlight)

What it needs:

| | Cost | Where |
|---|---|---|
| Apple Developer Program | US$99 / year | The **Apple Developer** app on your iPhone → *Account* → *Enroll*. Approval usually takes 24–48 h. |
| Expo account | free (a handful of cloud builds a month; paid tiers if you rebuild a lot) | expo.dev → Sign up |
| One session at any computer with Node.js installed | — | Mac, Windows or Linux; nothing stays installed except Node and the `eas` command |

### The reliable route (any computer, ~20 minutes)

```bash
npm install -g eas-cli
eas login                                  # your Expo account
cd altovix/app/ios
npm install
eas build --platform ios --profile production --auto-submit
```

The first build asks you to sign in with your Apple ID (two-factor code on your phone). EAS
then registers the bundle ID `com.altovixcapital.app`, creates the certificates and the App
Store Connect record, builds the app in the cloud (10–20 minutes) and uploads it to
TestFlight. When it says "Submitted": App Store Connect → *TestFlight* → *Internal Testing*
→ add yourself → install the **TestFlight** app on your phone → install Altovix.

Before the first build, set two things in `app.json`: `extra.eas.projectId` (EAS prints it
during `eas build`, or copy it from the project page on expo.dev) and, in `App.js`, `APP_URL`
to the address from Part 1.

### Phone-only route (possible, fiddlier)

Expo can build straight from GitHub: expo.dev → your project → *GitHub* → connect the
`altovix` repository, base directory `app/ios`. Then *Builds* → *Build from GitHub* →
platform iOS, profile production. For the upload to TestFlight to work without a computer,
Apple's side has to be done by hand first: register the bundle ID and create the app record
in App Store Connect, generate an App Store Connect **API key** (Users and Access →
Integrations → Keys) and store it in the Expo project's credentials. The workflow in
`ios/.eas/workflows/ios-testflight.yml` then builds and submits on every push. I can walk
you through it tap by tap, but the computer route above is the one I would take.

### Things to know

- **TestFlight builds expire after 90 days.** Rebuilding is the same command (or one button
  on expo.dev). To make it permanent you would submit it to the App Store as an *unlisted*
  app, which goes through App Review; Apple sometimes rejects apps that are only a wrapped
  website (guideline 4.2), so that step is a judgement call for later.
- The native app has its own storage, separate from Safari's: after installing it, restore
  your backup once (*Settings* → paste → *Restore*), and paste the API key again.
- Once the native app is installed, give the Scriptable widget the parameter `app` so a tap
  opens the app (`altovix://today`) instead of the web page.
- Building the shell means trusting Expo's cloud with the project source and your Apple
  credentials for the duration of the build; that is how every no-Mac iOS pipeline works.

---

## Layout

```
index.html                    the app (built once from the terminal page; now the source)
manifest.webmanifest          install metadata: name, icons, standalone display
sw.js                         offline cache for the app shell
icons/                        Altovix icons (home screen, PWA, maskable)
app/ios/App.js                the native shell (WebView + deep links + theme-aware safe area)
app/ios/app.json, eas.json    Expo / EAS configuration
app/ios/assets/               1024px icon (navy; icon-paper.png is the white variant), splash lockup
app/ios/.eas/workflows/       build-and-submit workflow for the GitHub route
```
