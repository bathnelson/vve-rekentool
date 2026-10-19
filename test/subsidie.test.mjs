import { test } from 'node:test';
import assert from 'node:assert/strict';
import { laad, woningen } from './laad.mjs';

// VvE met standaardgegevens; maatregelen als {code: offerte-m²}.
function vve(opts = {}) {
  return laad({ vve: { naam: 'VvE Test', kvk: '12345678', adres: 'Teststraat 1', woningen: woningen(4), ...opts } });
}
const json = (run, expr) => JSON.parse(run(`JSON.stringify(${expr})`));

test('num() leest Nederlandse notatie, eenheden en rommel', () => {
  const { run } = laad();
  assert.equal(run('num("1.234,5")'), 1234.5);
  assert.equal(run('num("12 m²")'), 12);
  assert.equal(run('num("€ 3,5")'), 3.5);
  assert.equal(run('num("40m2")'), 40);
  assert.equal(run('num("12.5")'), 12.5);
  assert.equal(run('num("")'), 0);
  assert.equal(run('num("abc")'), 0);
  assert.equal(run('num(null)'), 0);
  assert.equal(run('num(Infinity)'), 0);
});

test('tarieven en maximum per woning zoals in de rekentool', () => {
  const { run } = laad();
  assert.equal(run('MAX_PER_WONING'), 4000);
  assert.equal(run('WOZ_GRENS'), 596000);
  assert.deepEqual(json(run, 'Object.fromEntries(M.map(m=>[m.k,m.tarief]))'), {
    G: 6, H: 40, I: 60, J: 30, K: 8, L: 16, M: 12, N: 60, O: 20, P: 60, Q: 200, R: 90, S: 200, T: 1000,
  });
});

test('WOZ-grens: onder € 596.000 doet mee, vanaf € 596.000 niet', () => {
  const { run } = vve({
    woningen: woningen(3, i => ({ wozWaarde: [595999, 596000, 700000][i] })),
  });
  assert.deepEqual(json(run, 'S.woningen.map(w=>w.woz)'), ['Onder', 'Boven', 'Boven']);
  assert.equal(run('A()'), 3);
  assert.equal(run('B()'), 1);
  assert.equal(run('wozUit(595999)'), 'Onder');
  assert.equal(run('wozUit(596000)'), 'Boven');
});

test('offerte voor het hele gebouw telt naar rato van de woningen in de aanvraag', () => {
  const { run } = vve({
    woningen: woningen(6, i => ({ wozWaarde: i < 4 ? 300000 : 800000 })),
    maatregelen: { dak: '120' },
  });
  run('syncVerdeling()');
  assert.equal(run('B()'), 4);
  assert.equal(run('deelM2(MK.J)'), 80); // 120 m² × 4/6
  assert.equal(run('totaal()'), 80 * 30);
  run('S.offerteGebouw="nee"; syncVerdeling()');
  assert.equal(run('deelM2(MK.J)'), 120);
  assert.equal(run('totaal()'), 120 * 30);
});

test('gelijke verdeling: afrondingsrest naar de laatste woning, totaal klopt', () => {
  const { run } = vve({ woningen: woningen(3), maatregelen: { spouwmuur: '100' } });
  run('syncVerdeling()');
  assert.deepEqual(json(run, 'WS().map(w=>vdGet(w,"G"))'), [33.33, 33.33, 33.34]);
  assert.equal(run('r2(m2Totaal(MK.G))'), 100);
  assert.equal(run('totaal()'), 600);
});

test('zelf ingevulde m² blijven staan, de rest wordt herverdeeld', () => {
  const { run } = vve({ woningen: woningen(4), maatregelen: { gevelbuiten: '100' } });
  run('syncVerdeling(); const w0=WS()[0]; vdSet(w0,"I",40); S.vast={I:[w0.id]}; syncVerdeling()');
  assert.deepEqual(json(run, 'WS().map(w=>vdGet(w,"I"))'), [40, 20, 20, 20]);
  assert.equal(run('totaal()'), 100 * 60);
});

test('slimme verdeling: dak naar bovenste verdieping, vloer naar begane grond', () => {
  const { run } = vve({ woningen: woningen(3), maatregelen: { dak: '90', vloer: '60' } });
  run('WS().forEach((w,i)=>{ w.ligging=[1,2,3][i]; w.opp=60; }); syncVerdeling()');
  assert.deepEqual(json(run, 'WS().map(w=>vdGet(w,"J"))'), [0, 0, 90]);
  assert.deepEqual(json(run, 'WS().map(w=>vdGet(w,"L"))'), [60, 0, 0]);
  run('S.verdeelMethode="gelijk"; syncVerdeling()');
  assert.deepEqual(json(run, 'WS().map(w=>vdGet(w,"J"))'), [30, 30, 30]);
});

test('slimme verdeling naar woonoppervlakte als de verdieping onbekend is', () => {
  const { run } = vve({ woningen: woningen(3), maatregelen: { hrglas: '30' } });
  run('WS().forEach((w,i)=>{ w.opp=[50,100,150][i]; }); syncVerdeling()');
  assert.equal(run('sleutel("N").soort'), 'opp');
  assert.deepEqual(json(run, 'WS().map(w=>vdGet(w,"N"))'), [5, 10, 15]);
});

test('ventilatie: vast bedrag per woning in de aanvraag', () => {
  const { run } = vve({
    woningen: woningen(5, i => ({ wozWaarde: i === 4 ? 900000 : 300000 })),
    maatregelen: { ventilatie: '1' },
  });
  run('syncVerdeling()');
  assert.deepEqual(json(run, 'S.woningen.map(w=>vdGet(w,"T"))'), [1, 1, 1, 1, 0]);
  assert.equal(run('totaal()'), 4 * 1000);
  assert.equal(run('bedragWoning(WS()[0])'), 1000);
});

test('totaal en bedrag per woning over meerdere maatregelen', () => {
  const { run } = vve({ woningen: woningen(2), maatregelen: { G: '20', N: '10', T: '1' } });
  run('syncVerdeling()');
  // G: 20×6=120, N: 10×60=600, T: 2×1000=2000
  assert.equal(run('totaal()'), 2720);
  assert.equal(run('bedragWoning(WS()[0])'), 1360);
  assert.equal(run('WS().reduce((s,w)=>s+bedragWoning(w),0)'), 2720);
});

test('fromPre zet adresverkenner-gegevens om', () => {
  const { run } = vve({
    aantalWoningenGebouw: 10,
    kvk: '1234 5678',
    woningen: [
      { straat: 'A', huisnummer: 1, toevoeging: 'b', energielabel: 'A++', eigenaar: 'Eigenaar-bewoner', wozWaarde: 250000, slechteBouwdelen: ['Ramen / glas', 'Schuur'] },
      { straat: 'A', nr: '2', energielabel: 'geen label', eigenaar: 'verhuur', woz: 'onder' },
      { straat: 'A', nr: '3', doetMee: false },
    ],
    maatregelen: { 'Dak': '55.5', 'HR++ glas': '12', XYZ: '9' },
    offerteGeldtVoorHeleGebouw: false,
  });
  assert.equal(run('S.A'), '10');
  assert.equal(run('S.kvk'), '12345678');
  assert.equal(run('S.offerteGebouw'), 'nee');
  const ws = json(run, 'S.woningen.map(w=>({nr:w.nr,toev:w.toev,label:w.label,eig:w.eig,woz:w.woz,bd:w.bd,bdAnders:w.bdAnders}))');
  assert.deepEqual(ws, [
    { nr: '1', toev: 'b', label: 'A', eig: 'eigenaar-bewoner', woz: 'Onder', bd: ['Glas'], bdAnders: 'Schuur' },
    { nr: '2', toev: '', label: 'Onbekend', eig: 'eigenaar-verhuurder', woz: 'Onder', bd: [], bdAnders: '' },
  ]);
  assert.deepEqual(json(run, 'S.mt'), { J: { on: true, offerte: '55,5' }, N: { on: true, offerte: '12' } });
});
