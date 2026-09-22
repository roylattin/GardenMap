# GardenMap 🌱

**See your backyard's sun, shade, and what will thrive there — a "ShadeMap for gardeners."**

GardenMap drops you onto a satellite view of your yard, sweeps real sun-shadows across it through any time of day and season, and then tells you which plants will flourish in each sun/shade zone for your USDA hardiness zone.

**▶️ Live demo:** https://purple-ocean-065e1490f.5.azurestaticapps.net
*(Runs in any mobile or desktop browser — no install. Tap 📤 Share for a QR code.)*

---

## Features

- **☀️ Moving shadows** — a satellite map of your yard with live shadow simulation. Drag the time-of-day slider from sunrise to sunset and watch shadows sweep and stretch. Switch seasons to see how the sun changes.
- **🏠 Automatic buildings** — nearby building footprints (with heights) are pulled from OpenStreetMap and cast real shadows. When that service is busy, add your own house and trees in ✏️ Edit mode.
- **🌱 Plant zones** — an all-day sun-hours heatmap classifies every part of the yard as full sun, part sun, part shade, or full shade.
- **🔍 Plant recommendations** — tap any zone to get plants that thrive there for your hardiness zone, with type and water needs.
- **📍 Your location** — center on your own yard and auto-detect your hardiness zone.
- **📤 Share** — built-in QR code and share/copy link.

## Tech stack

- [Expo](https://expo.dev/) / React Native (exported to a web PWA)
- [Leaflet](https://leafletjs.com/) + [react-leaflet](https://react-leaflet.js.org/) for the map
- [SunCalc](https://github.com/mourner/suncalc) for solar position math
- Esri World Imagery tiles + [OpenStreetMap](https://www.openstreetmap.org/) building data
- Hosted on [Azure Static Web Apps](https://azure.microsoft.com/products/app-service/static/)

## Run locally

```bash
npm install
npm run web        # dev server (Expo)
```

## Build & deploy (web)

```bash
npm run build:web  # expo export -p web  +  PWA manifest patch  ->  ./dist
```

Deploy `./dist` to Azure Static Web Apps. CI/CD is wired up in
[`.github/workflows/azure-static-web-apps.yml`](.github/workflows/azure-static-web-apps.yml):
every push to `main` builds the web bundle and deploys it. It needs one repo
secret, `AZURE_STATIC_WEB_APPS_API_TOKEN` (the deployment token from your Static
Web App).

## Attribution & data

GardenMap is distributed under the [MIT License](LICENSE). It relies on
third-party data and libraries whose terms require attribution — see
[NOTICE](NOTICE). In short:

- **Buildings:** © OpenStreetMap contributors, [ODbL](https://opendatacommons.org/licenses/odbl/).
- **Imagery:** © Esri, Maxar, Earthstar Geographics (Esri World Imagery).

Shadows are modeled from building heights and sun angle — a planning aid, not a survey.
