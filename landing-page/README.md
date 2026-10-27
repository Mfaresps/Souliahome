# Soulia — standalone landing page

An Arabic, RTL product presentation with an emerald, ivory and gold palette, scroll-driven order journey, product illustrations, interactive tour and responsive layouts.

## Preview

From this directory:

```sh
npm start
```

Open `http://localhost:4173`. To use another port, set `LANDING_PORT` before starting. The server uses only Node.js built-in modules; no installation is needed.

You can also open `index.html` directly in a browser. All runtime assets, including the Cairo font, are local.

## Independence

- No changes to the existing frontend, backend, login or routing.
- No API calls, credentials, application storage, analytics or external runtime requests.
- All numbers and interface illustrations are clearly labeled examples.
- The feature copy describes modules present in the existing project. Provider integrations require the business's own account setup.
- The interactive tour is a product explanation; it does not perform business operations.

## Files

- `index.html`: content, product illustrations and page structure.
- `styles.css`: layout, responsive styles, animations and reduced-motion support.
- `app.js`: scroll progression, navigation, FAQ and accessible tour dialog.
- `assets/`: copied brand mark and self-hosted Cairo fonts, with their OFL license.
- `server.cjs`: optional local static preview server.
- `review/`: browser verification and screenshots. Development only; omit when publishing.

For static hosting, upload `index.html`, `styles.css`, `app.js` and `assets/`. No build step or server-side application is required.

## Verification

`npm run check` validates JavaScript syntax. `node review/verify.cjs` uses the Puppeteer installation already present in the parent workspace solely for development verification. The published page does not depend on it.

Browser checks cover seven widths (320–1440 px), all four scroll stages, direct stage navigation, mobile navigation, tour tabs and keyboard controls, dialog focus restoration, FAQ behavior, reduced motion, JavaScript errors and external requests. Results and screenshots are saved in `review/`.
