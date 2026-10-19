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
  // De offerte wordt terugherleid naar het hele gebouw (66,67 m² voor 4 van de 6 woningen).
  assert.equal(run('S.mt.J.offerte'), '100');
  assert.equal(run('S.offerteGebouw'), 'ja');
  assert.deepEqual(json(run, 'WS().map(w=>vdGet(w,"T"))'), [1, 1, 1, 1]);
  assert.equal(run('r2(totaal())'), r2(66.67 * 30 + 13.33 * 60 + 4000));
  assert.deepEqual(json(run, 'importChecks()'), []);
  // Na het inlezen moet de gebruiker nog de VvE-gegevens en de prestatie-eisen aanvullen.
  const err = json(run, 'checks().err.map(e=>e.t)').join('\n');
  assert.doesNotMatch(err, /KvK-nummer/);
  assert.match(json(run, 'checks().warn.map(e=>e.t)').join('\n'), /KvK-nummer van de VvE is niet ingevuld/);
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

test('70%-eis na inlezen: met het dakoppervlak uit 3D BAG hoeft niets meer bevestigd te worden', async () => {
  const buf = await maakBestand({ aantalWoningenGebouw: 4, woningen: woningen(4, i => ({ wozWaarde: i === 3 ? 800000 : 300000 })), maatregelen: { dak: '80' } });
  const { run } = await leesIn(buf);
  // 60 m² voor 3 van de 4 woningen → offerte voor het hele gebouw 80 m².
  assert.equal(run('S.mt.J.offerte'), '80');
  assert.match(json(run, 'checks().err.map(e=>e.t)').join('\n'), /Dakisolatie: bevestig dat het om minimaal 70%/);
  run('S.opp3d={J:100}');
  assert.equal(run('Math.round(oppPct("J"))'), 80);
  assert.doesNotMatch(json(run, 'checks().err.map(e=>e.t)').join('\n'), /Dakisolatie: .*70%/);
  run('S.opp3d={J:150}');
  assert.match(json(run, 'checks().err.map(e=>e.t)').join('\n'), /Dakisolatie: 80 m² is 53% van het hele dak \(150 m²\); minimaal 70% is vereist/);
});

test('oppervlaktecheck: 10% marge op 3D BAG, aan beide kanten', async () => {
  const buf = await maakBestand({ aantalWoningenGebouw: 4, woningen: woningen(4, i => ({ wozWaarde: i === 3 ? 800000 : 300000 })), maatregelen: { dak: '80' } });
  const { run } = await leesIn(buf);
  const fout = () => json(run, 'checks().err.map(e=>e.t)').join('\n'), waarsch = () => json(run, 'checks().warn.map(e=>e.t)').join('\n');
  run('S.opp3d={J:125}'); // 64%: onder 70, binnen de marge
  assert.doesNotMatch(fout(), /Dakisolatie: .*70%/);
  assert.equal(run('oppKlasse("J")'), 'ok');
  assert.match(run('oppPctHtml("J")'), /binnen de marge van 10%/);
  run('S.opp3d={J:130}'); // 62%: ook met marge te weinig
  assert.match(fout(), /62% van het hele dak .*met 10% marge op 3D BAG: 63%/);
  run('S.opp3d={J:75}'); // 107%: MJOP groter dan 3D BAG, geen waarschuwing
  assert.doesNotMatch(waarsch(), /Dakisolatie: .*meer dan/);
  assert.equal(run('oppKlasse("J")'), 'ok');
  run('S.opp3d={J:70}'); // 114%
  assert.match(waarsch(), /Dakisolatie: 80 m² is meer dan het hele dak .*ook met 10% marge/);
});

test('adres kiezen na inlezen: woningen blijven, koppeling met de BAG en WOZ-controle', async () => {
  const buf = await maakBestand({ woningen: woningen(2, i => ({ toevoeging: i ? 'A' : '' })), maatregelen: { dak: '40' } });
  const { run } = await leesIn(buf);
  const vbos = [
    { openbare_ruimte_naam: 'Teststraat', huisnummer: 1, hoofdadres_identificatie: '0392200000000001', oppervlakte: 70 },
    { openbare_ruimte_naam: 'Teststraat', huisnummer: 2, huisletter: 'A', hoofdadres_identificatie: '0392200000000002', oppervlakte: 55 },
    { openbare_ruimte_naam: 'Teststraat', huisnummer: 3, hoofdadres_identificatie: '0392200000000003', oppervlakte: 60 },
  ];
  run(`vulBijImport(++vulToken, ${JSON.stringify(vbos)}, ['p1'], {bouwjaar:1930}, true, '')`);
  run('vulToken++'); // ophaalacties op de achtergrond stoppen
  assert.equal(run('S.woningen.length'), 2);
  assert.deepEqual(json(run, 'S.woningen.map(w=>[w.nummeraanduiding,w.opp])'), [['0392200000000001', 70], ['0392200000000002', 55]]);
  assert.equal(run('S.autoA'), 3);
  assert.equal(run('S.bouwjaar'), 1930);
  assert.deepEqual(json(run, 'WS().map(w=>vdGet(w,"J"))'), [20, 20]);
  // WOZ uit het Kadaster wijkt af van het bestand: dat wordt gemeld.
  run('const w=S.woningen[1]; w.wozWaarde=650000; w.woz=wozUit(650000)');
  assert.match(json(run, 'importChecks().map(x=>x.t)').join('\n'), /Teststraat 2 A: in het bestand staat WOZ "onder", maar de WOZ-waarde op 1-1-2023 is €\s650\.000 \(boven de grens\)/);
});

test('na inlezen wordt het adres van de eerste woning opgezocht en het gebouw opgehaald', async () => {
  const buf = await maakBestand({ woningen: woningen(2, i => ({ toevoeging: i ? '' : 'Z', wozWaarde: i ? 300000 : 900000 })), maatregelen: { dak: '40' } });
  const ctx = await leesIn(buf);
  const { run, window } = ctx;
  window.__urls = [];
  run(`getJson=async url=>{ __urls.push(url); return {response:{docs:[{id:'adr-1',weergavenaam:'Teststraat 2, 2011AA Haarlem'}]}}; };
       vulVvE=async id=>{ window.__id=id; };`);
  await run('adresNaImport()');
  // De eerste woning in de aanvraag (Teststraat 1 Z zit boven de WOZ-grens).
  assert.match(decodeURIComponent(window.__urls[0]), /q=Teststraat 2 Haarlem&fq=type:adres/);
  assert.equal(window.__id, 'adr-1');
  assert.equal(run('S.vveAdres'), 'Teststraat 2, 2011AA Haarlem');
  run('getJson=async()=>({response:{docs:[]}})');
  await run('adresNaImport()');
  assert.match(run('vveStatus.tekst'), /kon niet automatisch worden opgezocht/);
});

test('naam van de VvE uit de bestandsnaam', () => {
  const { run } = laad();
  const naam = n => run(`vveUitBestandsnaam(${JSON.stringify(n)})`);
  assert.equal(naam('20261019_VvE De Linde_Rekentool.xlsx'), 'VvE De Linde');
  assert.equal(naam('Rekentool SVVE - VvE Kleverlaan 12 (2).xlsx'), 'VvE Kleverlaan 12');
  assert.equal(naam('VvE Zijlweg_definitief_v2.xlsx'), 'VvE Zijlweg');
  assert.equal(naam('2026-05-01 VvE Het Hof rekentool ingevuld.xlsx'), 'VvE Het Hof');
  assert.equal(naam('C:\\fakepath\\VvE_Oranjeboom.xlsx'), 'VvE Oranjeboom');
  assert.equal(naam('rekentool.xlsx'), '');
});

test('slechte bouwdelen worden ruim herkend', () => {
  const { run } = laad();
  const bd = t => json(run, `bdUitTekst(${JSON.stringify(t)})`);
  assert.deepEqual(bd('dak + panelen in kozijn'), { bd: ['Dak', 'Kozijnen'], bdAnders: '', bdGeen: false });
  assert.deepEqual(bd('enkel glas en voordeur').bd, ['Glas', 'Deuren']);
  assert.deepEqual(bd('slechte kozijnpanelen & HR glas').bd, ['Kozijnen', 'Glas']);
  assert.deepEqual(bd('kruipruimte; mechanische ventilatie').bd, ['Vloer', 'Ventilatie']);
  assert.deepEqual(bd('Dak, Gevel / muren').bd, ['Dak', 'Gevel / muren']);
  assert.deepEqual(bd('Schuur'), { bd: [], bdAnders: 'Schuur', bdGeen: false });
  assert.equal(bd('geen (goed geïsoleerd)').bdGeen, true);
});

function rij(i, extra) {
  return { rij: 32 + i, straat: 'Narcisstraat', nr: String(i + 1), toev: '', plaats: 'Haarlem', woz: 'Onder', eig: 'eigenaar-bewoner', label: 'Onbekend', bouwdelen: 'dak + panelen in kozijn', m: { J: 10 }, ...extra };
}
const bestand = (A, rijen) => ({ A, B: rijen.length, C: rijen.length, D: 0, m2: {}, tarief: {}, totaal: null, woningen: rijen });

test('zelfde slechte bouwdelen bij alle woningen zonder label: op gebouwniveau', () => {
  const { run } = laad();
  run(`S=vanRekentool(${JSON.stringify(bestand(2, [rij(0), rij(1, { bouwdelen: 'Dak en kozijnen' })]))},"x.xlsx")`);
  assert.deepEqual(json(run, 'S.bdGebouw'), ['Dak', 'Kozijnen']);
  assert.deepEqual(json(run, 'bdGebouw()'), ['Dak', 'Kozijnen']);
  assert.equal(run('labelOptioneel()'), true);
  assert.deepEqual(json(run, 'S.woningen.map(bouwdelen)'), [['Dak', 'Kozijnen'], ['Dak', 'Kozijnen']]);
  assert.equal(run('S.woningen.every(woningKlaar)'), true);
});

test('alleen wat bij alle woningen terugkomt gaat naar gebouwniveau', () => {
  const { run } = laad();
  run(`S=vanRekentool(${JSON.stringify(bestand(3, [rij(0), rij(1, { bouwdelen: 'dak, glas' }), rij(2, { label: 'E', bouwdelen: '' })]))},"x.xlsx")`);
  assert.deepEqual(json(run, 'S.bdGebouw'), ['Dak']);
  // Vanaf 3 woningen telt het gebouwniveau pas mee als de splitsingsakte zegt dat het dak collectief is.
  assert.deepEqual(json(run, 'bdGebouw()'), []);
  assert.deepEqual(json(run, 'S.woningen.map(bouwdelen)'), [['Dak', 'Kozijnen'], ['Dak', 'Glas'], []]);
  run('S.splitsing={...SPLITS_STD}');
  assert.deepEqual(json(run, 'bdGebouw()'), ['Dak']);
});
