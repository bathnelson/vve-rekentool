import { test } from 'node:test';
import assert from 'node:assert/strict';
import { laad, woningen } from './laad.mjs';

const json = (run, expr) => JSON.parse(run(`JSON.stringify(${expr})`));
const cel = (xml, ref) => (xml.match(new RegExp(`<c r="${ref}"[^>]*?(?:/>|>[\\s\\S]*?</c>)`)) || [null])[0];

test('setCell: getal, tekst, leeg en escaping; opmaak blijft staan', () => {
  const { run } = laad();
  const rij = '<row r="5"><c r="A5" s="3"/><c r="B5" s="4" t="s"><v>7</v></c><c r="C5" s="2"><v>1</v></c></row>';
  const zet = (ref, val) => run(`setCell(${JSON.stringify(rij)}, ${JSON.stringify(ref)}, ${JSON.stringify(val)})`);
  assert.equal(cel(zet('A5', 12.5), 'A5'), '<c r="A5" s="3"><v>12.5</v></c>');
  assert.equal(cel(zet('B5', 'Jan & <Piet>'), 'B5'),
    '<c r="B5" s="4" t="inlineStr"><is><t xml:space="preserve">Jan &amp; &lt;Piet&gt;</t></is></c>');
  assert.equal(cel(zet('C5', null), 'C5'), '<c r="C5" s="2"/>');
  // Overige cellen in de rij blijven ongemoeid.
  assert.equal(cel(zet('A5', 1), 'B5'), '<c r="B5" s="4" t="s"><v>7</v></c>');
});

test('setCell: formule blijft behouden, alleen de berekende waarde verandert', () => {
  const { run } = laad();
  const rij = '<row r="9"><c r="G9" s="1"><f>F9*30</f><v>0</v></c><c r="H9" t="str"><f>IF(1,"a","b")</f><v>a</v></c></row>';
  const uit = run(`setCell(${JSON.stringify(rij)}, "G9", 1/3)`);
  assert.equal(cel(uit, 'G9'), '<c r="G9" s="1"><f>F9*30</f><v>0.333333</v></c>');
  const uit2 = run(`setCell(${JSON.stringify(rij)}, "H9", "VOLDOET")`);
  assert.equal(cel(uit2, 'H9'), '<c r="H9" t="str"><f>IF(1,"a","b")</f><v>VOLDOET</v></c>');
});

test('setCell: ontbrekende cel geeft een fout, behalve bij een lege waarde', () => {
  const { run } = laad();
  const rij = '<row r="1"><c r="A1"/></row>';
  assert.equal(run(`setCell(${JSON.stringify(rij)}, "Z1", null)`), rij);
  assert.throws(() => run(`setCell(${JSON.stringify(rij)}, "Z1", 5)`), /Z1 ontbreekt/);
});

test('patchSheet past alleen de genoemde rijen aan', () => {
  const { run } = laad();
  const xml = '<sheetData><row r="1"><c r="A1"/></row><row r="10"><c r="A10"/></row><row r="11"><c r="A11"/></row></sheetData>';
  const uit = run(`patchSheet(${JSON.stringify(xml)}, {A1:1, A11:"x"})`);
  assert.equal(uit, '<sheetData><row r="1"><c r="A1"><v>1</v></c></row><row r="10"><c r="A10"/></row>'
    + '<row r="11"><c r="A11" t="inlineStr"><is><t xml:space="preserve">x</t></is></c></row></sheetData>');
});

function vve(opts) {
  return laad({ vve: { naam: 'VvE Test', kvk: '12345678', adres: 'Teststraat 1', ...opts } });
}

test('buildCells: rekenblad en invulblad', () => {
  const { run } = vve({
    aantalWoningenGebouw: 5,
    woningen: woningen(5, i => ({ wozWaarde: i === 4 ? 800000 : 300000, toevoeging: i === 1 ? 'A' : '', energielabel: i === 2 ? 'onbekend' : 'C', slechteBouwdelen: ['Dak', 'Vloer'] })),
    maatregelen: { dak: '100', ventilatie: '1' },
  });
  run('syncVerdeling()');
  const { s1, s2 } = json(run, 'buildCells()');
  // Rekenblad: aantallen (A–F)
  assert.equal(s1.E19, 5);
  assert.equal(s1.E20, 4);
  assert.equal(s1.E21, 2); // eigenaar-bewoners in de aanvraag
  assert.equal(s1.E22, 2);
  assert.equal(s1.E23, 0.8);
  assert.equal(s1.E24, 16000);
  // Dak (rij 31): 100 × 4/5 = 80 m² × € 30; ventilatie (rij 41): 4 × € 1.000
  assert.equal(s1.F31, 80);
  assert.equal(s1.G31, 2400);
  assert.equal(s1.F41, 4);
  assert.equal(s1.G41, 4000);
  assert.equal(s1.F28, null);
  assert.equal(s1.G28, 0);
  assert.equal(s1.G43, 6400);
  assert.equal(s1.G44, 1600);
  assert.equal(s1.G45, 'VOLDOET');
  assert.equal(s1.G46, 16000);
  // Invulblad: eerste woning op rij 32, dak in kolom P/Q, ventilatie in AJ/AK
  assert.equal(s2.A32, 'Teststraat');
  assert.equal(s2.B32, 1);
  assert.equal(s2.C32, null);
  assert.equal(s2.C33, 'A');
  assert.equal(s2.D32, 'Haarlem');
  assert.equal(s2.E32, 'Onder');
  assert.equal(s2.F32, 'eigenaar-bewoner');
  assert.equal(s2.G32, 'C');
  assert.equal(s2.H32, null);
  assert.equal(s2.G34, 'Onbekend');
  assert.equal(s2.H34, 'Dak, Vloer');
  assert.equal(s2.P32, 20);
  assert.equal(s2.Q32, 600);
  assert.equal(s2.AJ32, 1);
  assert.equal(s2.AK32, 1000);
  assert.equal(s2.I32, 1600);
  // Woning boven de WOZ-grens staat niet op het invulblad; rij 36 is leeg.
  assert.equal(s2.A36, undefined);
  assert.equal(s2.I36, 0);
  assert.equal(s2.I26, 6400);
  assert.equal(s2.I25, 16000);
});

test('buildCells: boven € 4.000 gemiddeld per woning voldoet niet', () => {
  const { run } = vve({ woningen: woningen(2), maatregelen: { tripleglas: '50' } });
  run('syncVerdeling()');
  const { s1 } = json(run, 'buildCells()');
  assert.equal(s1.G43, 10000);
  assert.equal(s1.G44, 5000);
  assert.equal(s1.G45, 'VOLDOET NIET');
});

test('makeXlsx vult het ingebedde template; alle cellen bestaan bij 126 woningen en alle maatregelen', async () => {
  const { run, JSZip } = vve({
    woningen: woningen(126),
    maatregelen: Object.fromEntries('GHIJKLMNOPQRST'.split('').map(k => [k, '500'])),
  });
  const blob = await run('makeXlsx({download:false})');
  const zip = await JSZip.loadAsync(await blob.arrayBuffer());
  const s1 = await zip.file('xl/worksheets/sheet1.xml').async('string');
  const s2 = await zip.file('xl/worksheets/sheet2.xml').async('string');
  const wb = await zip.file('xl/workbook.xml').async('string');
  const { s1: c1, s2: c2 } = json(run, 'buildCells()');
  assert.match(cel(s1, 'E19'), /<v>126<\/v>/);
  assert.match(cel(s1, 'G43'), new RegExp(`<v>${c1.G43}</v>`));
  assert.match(cel(s2, 'A157'), /Teststraat/);
  assert.match(cel(s2, 'B157'), /<v>126<\/v>/);
  // Formulecellen krijgen hun waarde afgerond op 6 decimalen (zwevendekommarest valt weg).
  assert.match(cel(s2, 'I26'), new RegExp(`<f>[^<]*</f><v>${Math.round(c2.I26 * 1e6) / 1e6}</v>`));
  assert.equal(Math.round(c2.I26 * 100) / 100, c1.G43);
  assert.match(wb, /<calcPr[^>]*fullCalcOnLoad="1"/);
});

test('makeXlsx zonder woningen geeft een geldig, leeg ingevuld bestand', async () => {
  const { run, JSZip } = laad();
  const blob = await run('makeXlsx({download:false})');
  const zip = await JSZip.loadAsync(await blob.arrayBuffer());
  const s2 = await zip.file('xl/worksheets/sheet2.xml').async('string');
  assert.match(cel(s2, 'I26'), /<v>0<\/v>/);
});
