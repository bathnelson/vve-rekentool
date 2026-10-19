import { test } from 'node:test';
import assert from 'node:assert/strict';
import { laad, woningen } from './laad.mjs';

const json = (run, expr) => JSON.parse(run(`JSON.stringify(${expr})`));

// Maakt met de rekenhulp zelf een ingevulde rekentool, als Buffer.
async function maakBestand(opts) {
  const { run } = laad({ vve: { naam: 'VvE Test', kvk: '12345678', adres: 'Teststraat 1', ...opts } });
  const blob = await run('makeXlsx({download:false})');
  return Buffer.from(await blob.arrayBuffer());
}
// Leest een bestand in een lege rekenhulp in, zoals de knop op de startpagina doet.
async function leesIn(buf, naam = '20261019_VvE Voorbeeld_Rekentool.xlsx') {
  const ctx = laad();
  ctx.window.__buf = new Uint8Array(buf);
  await ctx.run(`leesRekentool(__buf).then(d=>{ S=vanRekentool(d,${JSON.stringify(naam)}); uid=Math.max(0,...S.woningen.map(w=>w.id))+1; syncVerdeling(); })`);
  return ctx;
}
// Past cellen in een werkblad van het bestand aan (alleen <v>-waarden).
async function pas(buf, sheet, cellen, JSZip) {
  const zip = await JSZip.loadAsync(buf);
  const p = `xl/worksheets/${sheet}.xml`;
  let xml = await zip.file(p).async('string');
  for (const [ref, v] of Object.entries(cellen)) {
    xml = xml.replace(new RegExp(`<c r="${ref}"([^>]*?)(?:/>|>[\\s\\S]*?</c>)`), (m, a) => `<c r="${ref}"${a.replace(/\st="[^"]*"/, '')}><v>${v}</v></c>`);
  }
  zip.file(p, xml);
  return zip.generateAsync({ type: 'nodebuffer' });
}

test('rondje: wat de rekenhulp uitvoert, leest hij identiek weer in', async () => {
  const buf = await maakBestand({
    aantalWoningenGebouw: 6,
    woningen: woningen(5, i => ({ wozWaarde: i === 4 ? 800000 : 300000, toevoeging: i === 1 ? 'A' : '', energielabel: i === 2 ? 'onbekend' : 'E', slechteBouwdelen: ['Dak', 'Gevel / muren', 'Schuur'] })),
    maatregelen: { dak: '100', hrglas: '20', ventilatie: '1' },
  });
  const { run } = await leesIn(buf);
  assert.equal(run('S.vve'), 'VvE Voorbeeld');
  assert.equal(run('A()'), 6);
  assert.equal(run('B()'), 4);
  assert.deepEqual(json(run, 'S.woningen.map(w=>[w.straat,w.nr,w.toev,w.plaats,w.woz,w.eig,w.label])'), [
    ['Teststraat', '1', '', 'Haarlem', 'Onder', 'eigenaar-bewoner', 'E'],
    ['Teststraat', '2', 'A', 'Haarlem', 'Onder', 'eigenaar-verhuurder', 'E'],
    ['Teststraat', '3', '', 'Haarlem', 'Onder', 'eigenaar-bewoner', 'Onbekend'],
    ['Teststraat', '4', '', 'Haarlem', 'Onder', 'eigenaar-verhuurder', 'E'],
  ]);
  assert.deepEqual(json(run, '[S.woningen[2].bd, S.woningen[2].bdAnders]'), [['Dak', 'Gevel / muren'], 'Schuur']);
  // Dak: 100 × 4/6 = 66,67 m², gelijk verdeeld; die verdeling blijft staan.
  assert.deepEqual(json(run, 'WS().map(w=>vdGet(w,"J"))'), [16.67, 16.67, 16.67, 16.66]);
  assert.equal(run('S.mt.J.offerte'), '66,67');
  assert.equal(run('S.offerteGebouw'), 'nee');
  assert.deepEqual(json(run, 'WS().map(w=>vdGet(w,"T"))'), [1, 1, 1, 1]);
  assert.equal(run('r2(totaal())'), r2(66.67 * 30 + 13.33 * 60 + 4000));
  assert.deepEqual(json(run, 'importChecks()'), []);
  // Na het inlezen moet de gebruiker nog de VvE-gegevens en de prestatie-eisen aanvullen.
  const err = json(run, 'checks().err.map(e=>e.t)').join('\n');
  assert.match(err, /KvK-nummer/);
  assert.match(err, /bevestig dat de offerte voldoet/);
  assert.doesNotMatch(err, /niet volledig ingevuld/);
});
function r2(n) { return Math.round(n * 100) / 100; }

test('controle meldt verschillen tussen rekenblad, invulblad en regeling', async () => {
  const buf = await maakBestand({ woningen: woningen(3), maatregelen: { dak: '90' } });
  const { JSZip } = laad();
  let aangepast = await pas(buf, 'sheet1', { E20: 4, F31: 120, E31: 35 }, JSZip);
  aangepast = await pas(aangepast, 'sheet2', { P32: 40, I26: 1234 }, JSZip);
  const { run } = await leesIn(aangepast);
  const v = json(run, 'importChecks().map(x=>x.t)').join('\n');
  assert.match(v, /Rekenblad B .* zegt 4, maar op het invulblad staan er 3/);
  assert.match(v, /Dakisolatie: op het rekenblad staat 120 m², op het invulblad samen 100\./);
  assert.match(v, /bedrag van €\s35,00, volgens de regeling is het €\s30,00/);
  assert.match(v, /totaal van €\s1\.234,00; opnieuw berekend is het €\s3\.000,00/);
  // De berekening gebruikt de m² van het invulblad (40 + 30 + 30) en de tarieven van de regeling.
  assert.deepEqual(json(run, 'WS().map(w=>vdGet(w,"J"))'), [40, 30, 30]);
  assert.equal(run("totaal()"), 3000);
  assert.match(json(run, 'checks().warn.map(x=>x.t)').join('\n'), /Ingelezen bestand: /);
});

test('leest gedeelde teksten (sharedStrings), zoals Excel ze opslaat', async () => {
  const buf = await maakBestand({ woningen: woningen(2), maatregelen: { spouwmuur: '30' } });
  const { JSZip } = laad();
  const zip = await JSZip.loadAsync(buf);
  const p = 'xl/worksheets/sheet2.xml';
  let xml = await zip.file(p).async('string');
  let ssXml = await zip.file('xl/sharedStrings.xml').async('string');
  let n = (ssXml.match(/<si>/g) || []).length;
  xml = xml.replace(/<c r="([A-Z]+\d+)"([^>]*?) t="inlineStr"><is><t xml:space="preserve">([\s\S]*?)<\/t><\/is><\/c>/g, (m, ref, a, t) => {
    ssXml = ssXml.replace('</sst>', `<si><t>${t}</t></si></sst>`);
    return `<c r="${ref}"${a} t="s"><v>${n++}</v></c>`;
  });
  assert.doesNotMatch(xml, /inlineStr/);
  zip.file(p, xml); zip.file('xl/sharedStrings.xml', ssXml);
  const { run } = await leesIn(await zip.generateAsync({ type: 'nodebuffer' }), 'rekentool.xlsx');
  assert.equal(run('S.vve'), '');
  assert.deepEqual(json(run, 'S.woningen.map(w=>[w.straat,w.woz,w.eig,w.label])'), [
    ['Teststraat', 'Onder', 'eigenaar-bewoner', 'D'], ['Teststraat', 'Onder', 'eigenaar-verhuurder', 'D'],
  ]);
  assert.deepEqual(json(run, 'WS().map(w=>vdGet(w,"G"))'), [15, 15]);
});

test('waarden uit de keuzelijsten met spaties en hoofdletters worden herkend', () => {
  const { run } = laad();
  const d = { A: 2, B: 2, C: 1, D: 1, m2: {}, tarief: {}, totaal: null, woningen: [
    { rij: 32, straat: 'X', nr: '1', toev: '', plaats: 'Haarlem', woz: ' Onder', eig: ' eigenaar-bewoner', label: 'onbekend', bouwdelen: 'dak; ramen en voordeur', m: { G: 12 } },
    { rij: 33, straat: 'X', nr: '2', toev: '', plaats: 'Haarlem', woz: 'Onbekend', eig: 'Eigenaar-Verhuurder', label: '', bouwdelen: 'Geen (goed geïsoleerd)', m: {} },
  ] };
  run(`S=vanRekentool(${JSON.stringify(d)},"x.xlsx")`);
  assert.deepEqual(json(run, 'S.woningen.map(w=>[w.woz,w.eig,w.label,w.bd,!!w.bdGeen])'), [
    ['Onder', 'eigenaar-bewoner', 'Onbekend', ['Dak', 'Glas', 'Deuren'], false],
    ['', 'eigenaar-verhuurder', '', [], true],
  ]);
  // WOZ "Onbekend" moet nog worden ingevuld.
  assert.equal(run('woningKlaar(S.woningen[1])'), false);
});

test('een ander bestand geeft een duidelijke fout', async () => {
  const { JSZip } = laad();
  const zip = new JSZip(); zip.file('xl/workbook.xml', '<workbook><sheets><sheet name="Blad1" r:id="rId1"/></sheets></workbook>');
  const ctx = laad();
  ctx.window.__buf = new Uint8Array(await zip.generateAsync({ type: 'nodebuffer' }));
  await assert.rejects(() => ctx.run('leesRekentool(__buf)'), /tabbladen "1_Rekenblad" en "2_invulblad" ontbreken/);
  ctx.window.__buf = new Uint8Array([1, 2, 3]);
  await assert.rejects(() => ctx.run('leesRekentool(__buf)'), /geen Excel-bestand/);
});
