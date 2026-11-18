# Acme Support: Browser AI demo

A mock support inbox that runs Chrome's built-in AI APIs on the device:

- **Language Detector** puts a language badge on each comment
- **Translator** handles "Translate to English", and translates the reply back to the customer's language on send
- **Prompt API** does triage (urgency, category, sentiment, order number) using `responseConstraint` with a JSON Schema
- **Writer** drafts a reply ("Draft it")
- **Rewriter** changes tone or length of your reply ("Rewrite")
- **Proofreader** lists what to fix ("Check"), and you click a fix to apply it

No dependencies and no bundler. Plain HTML, CSS and ES modules.

## Run

The APIs need a secure context, and `localhost` counts. Node 18 or newer:

```
npm start
```

Open http://localhost:8080 in desktop Chrome. Set `PORT` to use another port.

Without Node, `python3 -m http.server 8080` works too.

## Deploy to GitHub Pages

`.github/workflows/pages.yml` publishes the site on every push to `main`. One-time setup: in the repo go to
**Settings → Pages** and set **Source** to **GitHub Actions**. The site ends up at
`https://<user>.github.io/<repo>/`.

`npm run build` copies `index.html`, `css/` and `js/` into `dist/`, which is what gets deployed. Nothing else from
the repo is published.

On github.io the flags below don't help visitors, since each person would have to set them in their own browser.
For Writer, Rewriter and Proofreader, register the github.io origin for each origin trial at
https://developer.chrome.com/origintrials and add the tokens to `index.html`:

```html
<meta http-equiv="origin-trial" content="TOKEN">
```

Language Detector and Translator work without tokens.

## Browser setup

Language Detector and Translator are stable since Chrome 138. The Prompt API on the web is listed for Chrome 148.
Writer, Rewriter and Proofreader are origin trials, so on localhost enable them in `chrome://flags`:

- `#writer-api-for-gemini-nano`
- `#rewriter-api-for-gemini-nano`
- `#proofreader-api`
- `#prompt-api-for-gemini-nano` (only if your Chrome version still needs it)

Flag names change between versions. Search `chrome://flags` for "gemini nano" if one is missing.

Gemini Nano needs a desktop OS (Windows 10/11, macOS 13+, Linux, ChromeOS on Chromebook Plus), about 22 GB of free disk
and an unmetered connection for the first download. Check `chrome://on-device-internals` for the model state.

## First run

The status chips in the top bar show `availability()` for each API. When a model is `downloadable`, click
**Download models**. Browsers allow the download only after a user click, so that button calls every `create()`
at once, synchronously in the click handler. After that, **Analyze inbox** detects languages and triages comments.

On later visits the models are already on disk and the inbox is analyzed on page load.

The **AI call log** at the bottom records how long each call took.

## Files

- `js/ai.js` wrappers around the APIs, one cached instance per model and option set
- `js/app.js` UI and flows
- `js/data.js` mock comments
- `scripts/serve.js` local dev server, `scripts/build.js` copies the site into `dist/`
