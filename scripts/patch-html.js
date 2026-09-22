// Post-export step: Expo's web export doesn't link the PWA manifest or set a
// theme color, so inject them into dist/index.html. Idempotent.
const fs = require('fs');
const path = require('path');

const htmlPath = path.join(__dirname, '..', 'dist', 'index.html');
if (!fs.existsSync(htmlPath)) {
  console.error('dist/index.html not found — run `expo export -p web` first.');
  process.exit(1);
}

let html = fs.readFileSync(htmlPath, 'utf8');
if (!/rel="manifest"/.test(html)) {
  html = html.replace(
    '</head>',
    '<link rel="manifest" href="/manifest.json"><meta name="theme-color" content="#20331f"></head>'
  );
  fs.writeFileSync(htmlPath, html);
  console.log('Injected PWA manifest link + theme-color into dist/index.html');
} else {
  console.log('Manifest link already present — nothing to do.');
}
