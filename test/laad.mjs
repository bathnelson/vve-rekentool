// Laadt index.html in jsdom zodat de rekenlogica zonder browser te testen is.
// JSZip komt uit node_modules in plaats van de CDN; netwerk en localStorage blijven buiten beeld.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { JSDOM, VirtualConsole } from 'jsdom';

const require = createRequire(import.meta.url);
const JSZip = require('jszip');
const HTML = readFileSync(new URL('../index.html', import.meta.url), 'utf8')
  .replace(/<script src="[^"]*jszip[^"]*"><\/script>/, '');

export function laad({ vve = null } = {}) {
  const html = vve ? HTML.replace('<script type="application/json" id="vve-data">null</script>',
    `<script type="application/json" id="vve-data">${JSON.stringify(vve)}</script>`) : HTML;
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', e => { throw e; });
  const dom = new JSDOM(html, {
    runScripts: 'dangerously',
    url: 'https://bathnelson.github.io/vve-rekentool/',
    virtualConsole,
    beforeParse(window) {
      window.JSZip = JSZip;
      window.fetch = () => Promise.reject(new Error('geen netwerk in tests'));
      window.print = () => {};
      window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
      window.scrollTo = () => {};
    },
  });
  const w = dom.window;
  // Top-level let/const uit het script zijn alleen via eval in de globale scope bereikbaar.
  return { window: w, run: code => w.eval(code), JSZip };
}

// Een VvE met n woningen, allemaal onder de WOZ-grens tenzij anders opgegeven.
export function woningen(n, extra = () => ({})) {
  return Array.from({ length: n }, (_, i) => ({
    straat: 'Teststraat', huisnummer: String(i + 1), woonplaats: 'Haarlem',
    wozWaarde: 300000, eigenaar: i % 2 ? 'eigenaar-verhuurder' : 'eigenaar-bewoner',
    energielabel: 'D', ...extra(i),
  }));
}
