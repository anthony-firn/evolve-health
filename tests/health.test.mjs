// Importers, share packages, transcripts and presets.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { importFile, dedupe } from '../web/src/health/import.mjs';
import { decodeCard, verifyCard, deflateRaw } from '../web/src/health/shc.mjs';
import { readZip } from '../web/src/health/zip.mjs';
import { parseXml } from '../web/src/health/xml.mjs';
import { parseTranscript, highlights, followUpDate } from '../web/src/health/transcript.mjs';
import { presetById, proposal } from '../web/src/health/presets.mjs';
import { suggestSensitive, recordTitle, recordDate } from '../web/src/health/model.mjs';
import { sealShare, openShare, shareUrl, parseShareUrl, shareCode, parseShareCode, cleanRecord, PinRequired } from '../web/src/share/package.mjs';
import { b64url, utf8, concat } from '../web/src/lib/bytes.mjs';

const subtle = globalThis.crypto.subtle;

async function makeCard(bundle, iss = 'https://issuer.example') {
  const pair = await subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const jwk = await subtle.exportKey('jwk', pair.publicKey);
  const kid = 'test-key';
  const header = b64url(utf8(JSON.stringify({ zip: 'DEF', alg: 'ES256', kid })));
  const payload = b64url(await deflateRaw(utf8(JSON.stringify({ iss, nbf: 1700000000, vc: { type: ['https://smarthealth.cards#health-card'], credentialSubject: { fhirVersion: '4.0.1', fhirBundle: bundle } } }))));
  const sig = b64url(new Uint8Array(await subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, pair.privateKey, utf8(`${header}.${payload}`))));
  const jws = `${header}.${payload}.${sig}`;
  const fetchImpl = async (url) => ({ ok: url === `${iss}/.well-known/jwks.json`, json: async () => ({ keys: [{ ...jwk, kid, use: 'sig', alg: 'ES256' }] }) });
  return { jws, fetchImpl };
}

const shcBundle = {
  resourceType: 'Bundle', type: 'collection', entry: [
    { fullUrl: 'resource:0', resource: { resourceType: 'Patient', name: [{ family: 'Anyperson', given: ['Sam'] }], birthDate: '1980-02-02' } },
    { fullUrl: 'resource:1', resource: { resourceType: 'Immunization', status: 'completed', vaccineCode: { coding: [{ system: 'http://hl7.org/fhir/sid/cvx', code: '208' }] }, patient: { reference: 'resource:0' }, occurrenceDateTime: '2021-04-01', lotNumber: 'EW0182' } },
  ],
};

test('SMART Health Card: file, numeric QR text, signature check and tamper detection', async () => {
  const { jws, fetchImpl } = await makeCard(shcBundle);
  const file = await importFile({ name: 'card.smart-health-card', bytes: utf8(JSON.stringify({ verifiableCredential: [jws] })) });
  assert.equal(file.profile.name, 'Sam Anyperson');
  assert.equal(file.records[0].data.vaccine, 'COVID-19 (Pfizer-BioNTech)');
  assert.equal(file.records[0].data.lot, 'EW0182');
  assert.equal(await verifyCard(file.cards[0], fetchImpl), true);
  const numeric = `shc:/${[...jws].map((c) => String(c.charCodeAt(0) - 45).padStart(2, '0')).join('')}`;
  const qr = await importFile({ name: 'qr.txt', bytes: utf8(numeric) });
  assert.equal(qr.records.length, 1);
  const parts = jws.split('.');
  const forged = await decodeCard(jws);
  forged.jws = `${parts[0]}.${parts[1].slice(0, -3)}AAA.${parts[2]}`;
  assert.equal(await verifyCard(forged, fetchImpl), false);
  assert.equal(await verifyCard({ ...file.cards[0], issuer: 'http://insecure.example' }, fetchImpl), false);
});

const CCDA = `<?xml version="1.0"?>
<!DOCTYPE ClinicalDocument [ <!ENTITY xxe SYSTEM "file:///etc/passwd"> ]>
<ClinicalDocument xmlns="urn:hl7-org:v3" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
 <recordTarget><patientRole><patient><name><given>Ana</given><family>Lopez</family></name><administrativeGenderCode code="F"/><birthTime value="19700304"/></patient></patientRole></recordTarget>
 <component><structuredBody>
  <component><section><code code="48765-2"/><text><content ID="r1">Hives &amp; itching</content></text>
   <entry><act><entryRelationship><observation><value xsi:type="CD" code="419199007"/><effectiveTime><low value="20100101"/></effectiveTime>
    <participant><participantRole><playingEntity><code code="7980" codeSystem="2.16.840.1.113883.6.88" displayName="Penicillin G"/></playingEntity></participantRole></participant>
    <entryRelationship><observation><templateId root="2.16.840.1.113883.10.20.22.4.9"/><value xsi:type="CD"><originalText><reference value="#r1"/></originalText></value></observation></entryRelationship>
   </observation></entryRelationship></act></entry>
   <entry><act><entryRelationship><observation negationInd="true"><value xsi:type="CD" code="419199007"/>
    <participant><participantRole><playingEntity><code code="105590001" displayName="Substance"/></playingEntity></participantRole></participant></observation></entryRelationship></act></entry>
  </section></component>
  <component><section><code code="10160-0"/>
   <entry><substanceAdministration><effectiveTime xsi:type="IVL_TS"><low value="20200105"/></effectiveTime><doseQuantity value="10" unit="mg"/>
    <consumable><manufacturedProduct><manufacturedMaterial><code code="29046" displayName="lisinopril 10 MG Oral Tablet" codeSystem="2.16.840.1.113883.6.88"/></manufacturedMaterial></manufacturedProduct></consumable></substanceAdministration></entry>
  </section></component>
  <component><section nullFlavor="NI"><code code="11450-4"/></section></component>
  <component><section><code code="30954-2"/>
   <entry><organizer><component><observation><code code="4548-4" displayName="Hemoglobin A1c"/><effectiveTime value="20240301"/><value xsi:type="PQ" value="6.1" unit="%"/><interpretationCode code="H"/></observation></component>
    <component><observation><code code="804-5" displayName="Leukocytes"/><value xsi:type="PQ" nullFlavor="NA"/></observation></component></organizer></entry>
  </section></component>
  <component><section><code code="8716-3"/>
   <entry><organizer><effectiveTime value="20240301"/>
    <component><observation><code code="8480-6"/><value xsi:type="PQ" value="128" unit="mm[Hg]"/></observation></component>
    <component><observation><code code="8462-4"/><value xsi:type="PQ" value="82" unit="mm[Hg]"/></observation></component>
    <component><observation><code code="29463-7"/><value xsi:type="PQ" value="70" unit="kg"/></observation></component></organizer></entry>
  </section></component>
  <component><section><code code="46240-8"/><entry><encounter><code code="99213" displayName="Office or other outpatient visit for the evaluation and management of an established patient"/><effectiveTime><low value="202403011030"/></effectiveTime></encounter></entry></section></component>
 </structuredBody></component>
</ClinicalDocument>`;

test('C-CDA: sections, narrative references, negation, no-value results and no DTD expansion', async () => {
  const r = await importFile({ name: 'summary.xml', bytes: utf8(CCDA) });
  assert.deepEqual(r.profile, { name: 'Ana Lopez', birthDate: '1970-03-04', sex: 'female' });
  const by = (k) => r.records.filter((x) => x.kind === k).map((x) => x.data);
  assert.deepEqual(by('allergy').map((a) => [a.substance, a.reaction, a.category]), [['Penicillin G', 'Hives & itching', 'medication']]);
  assert.equal(by('medication')[0].dose, '10 mg');
  assert.equal(by('condition').length, 0);
  assert.deepEqual(by('result').map((x) => [x.test, x.value, x.flag]), [['Hemoglobin A1c', '6.1', 'high']]);
  assert.deepEqual(by('vital').map((v) => v.type).sort(), ['blood-pressure', 'weight']);
  assert.equal(by('vital').find((v) => v.type === 'blood-pressure').value2, 82);
  assert.deepEqual(by('visit').map((v) => [v.type, v.date]), [['Office visit', '2024-03-01T10:30']]);
  assert.equal(by('document').length, 1, 'the original file is kept');
  assert.ok(!JSON.stringify(r).includes('root:'), 'external entity was not expanded');
  assert.throws(() => parseXml('<a><b></a>'), /Mismatched/);
});

test('ZIP archives (portal downloads) are read entry by entry', async () => {
  const entry = async (name, data) => {
    const comp = await deflateRaw(data);
    const n = utf8(name);
    const local = new Uint8Array(30 + n.length); const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true); lv.setUint16(8, 8, true); lv.setUint32(18, comp.length, true); lv.setUint32(22, data.length, true); lv.setUint16(26, n.length, true); local.set(n, 30);
    return { name: n, local, comp, size: data.length };
  };
  const files = [await entry('IHE_XDM/SUBSET01/DOC0001.XML', utf8(CCDA)), await entry('IHE_XDM/SUBSET01/STYLE.XSL', utf8('<xsl/>'))];
  const parts = []; const central = []; let offset = 0;
  for (const f of files) {
    parts.push(f.local, f.comp);
    const c = new Uint8Array(46 + f.name.length); const cv = new DataView(c.buffer);
    cv.setUint32(0, 0x02014b50, true); cv.setUint16(10, 8, true); cv.setUint32(20, f.comp.length, true); cv.setUint32(24, f.size, true); cv.setUint16(28, f.name.length, true); cv.setUint32(42, offset, true); c.set(f.name, 46);
    central.push(c); offset += f.local.length + f.comp.length;
  }
  const cd = concat(...central);
  const end = new Uint8Array(22); const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true); ev.setUint16(8, files.length, true); ev.setUint16(10, files.length, true); ev.setUint32(12, cd.length, true); ev.setUint32(16, offset, true);
  const zip = concat(...parts, cd, end);
  assert.equal((await readZip(zip)).length, 2);
  const r = await importFile({ name: 'record.zip', bytes: zip });
  assert.equal(r.profile.name, 'Ana Lopez');
  assert.ok(r.records.some((x) => x.kind === 'medication'));
});

test('share packages: link round trip, PIN, wrong PIN, tampering and file codes', async () => {
  const pkg = { v: 1, kind: 'evolve-health-share', id: 'x', records: [{ kind: 'allergy', data: { substance: 'Peanut' } }], files: {} };
  const plain = await sealShare(pkg);
  const link = shareUrl('https://app.example/share/', plain);
  const parsed = parseShareUrl(link);
  assert.equal((await openShare(parsed.bytes, parsed.secret)).records[0].data.substance, 'Peanut');
  const pinned = await sealShare(pkg, { pin: '123456' });
  await assert.rejects(openShare(pinned.bytes, pinned.secret), PinRequired);
  await assert.rejects(openShare(pinned.bytes, pinned.secret, '654321'), /decrypt/i);
  assert.equal((await openShare(pinned.bytes, pinned.secret, '123 456')).id, 'x');
  const bad = plain.bytes.slice(); bad[bad.length - 5] ^= 1;
  await assert.rejects(openShare(bad, plain.secret), /decrypt/i);
  assert.deepEqual(parseShareCode(shareCode(plain.secret)), plain.secret);
  assert.equal(parseShareUrl(shareUrl('https://a/', { secret: plain.secret, node: 'https://n.example', id: 'abcdefghijklmnop' })).node, 'https://n.example');
  const cleaned = cleanRecord({ rid: 'r', kind: 'document', data: { title: 'X', sensitive: ['genetic'], file: { k: 'KEY', h: ['hash'], name: 'a.pdf', size: 3, type: 'application/pdf' } } });
  assert.deepEqual(cleaned.data, { title: 'X', file: { name: 'a.pdf', type: 'application/pdf', size: 3 } });
});

test('transcripts: VTT, SRT, Whisper JSON and plain text; highlights and follow-up dates', () => {
  const vtt = parseTranscript('WEBVTT\n\n00:00:05.000 --> 00:00:09.000\n<v Dr. Lee>Take 500 mg of amoxicillin twice a day.\n\n00:01:10.500 --> 00:01:12.000\nCome back in two weeks.');
  assert.deepEqual(vtt.map((s) => [s.t, s.speaker]), [[5, 'Dr. Lee'], [70.5, undefined]]);
  const srt = parseTranscript('1\n00:00:01,000 --> 00:00:02,000\nHello\n\n2\n00:00:03,000 --> 00:00:04,000\nBye');
  assert.equal(srt.length, 2);
  assert.equal(parseTranscript('{"segments":[{"start":1.5,"text":" Hi"}]}')[0].t, 1.5);
  assert.equal(parseTranscript('[1:02] Doctor: Avoid running until it heals.')[0].speaker, 'Doctor');
  const hl = highlights(vtt);
  assert.deepEqual(hl.map((x) => x.type), ['medication', 'followup']);
  assert.equal(highlights(parseTranscript('If the swelling gets worse, go to the ER.'))[0].type, 'warning');
  assert.equal(followUpDate('see you in 2 weeks', new Date('2026-01-01T12:00:00Z')), '2026-01-15');
  assert.equal(followUpDate('nothing here'), '');
});

test('presets never preselect private records; sensitivity is suggested from wording', () => {
  const records = [
    { rid: '1', kind: 'allergy', data: { substance: 'Latex' } },
    { rid: '2', kind: 'medication', data: { name: 'Sertraline', status: 'active', sensitive: ['mental'] } },
    { rid: '3', kind: 'result', data: { test: 'BRCA1 genetic test', date: '2026-01-01', sensitive: ['genetic'] } },
    { rid: '4', kind: 'medication', data: { name: 'Apixaban', status: 'active' } },
  ];
  const space = { list: () => records };
  for (const id of ['dentist', 'primary', 'urgent', 'specialist']) {
    const chosen = proposal(space, presetById(id)).filter((x) => x.selected).map((x) => x.r.rid);
    assert.ok(!chosen.includes('2') && !chosen.includes('3'), `${id} preselected a private record`);
  }
  assert.deepEqual(proposal(space, presetById('dentist')).filter((x) => x.selected).map((x) => x.r.rid), ['1', '4']);
  assert.deepEqual(proposal(space, presetById('insurer')).filter((x) => x.selected), []);
  assert.deepEqual(suggestSensitive('result', { test: 'BRCA2 gene test' }), ['genetic']);
  assert.deepEqual(suggestSensitive('medication', { name: 'Escitalopram', reason: 'Depression' }), ['mental']);
  assert.deepEqual(suggestSensitive('condition', { name: 'Asthma' }), []);
});

test('imports skip records already in the profile', () => {
  const existing = [{ kind: 'allergy', data: { substance: 'Latex' } }];
  const { fresh, dupes } = dedupe({ list: () => existing }, [{ kind: 'allergy', data: { substance: 'latex' } }, { kind: 'allergy', data: { substance: 'Peanut' } }], recordTitle, recordDate);
  assert.equal(dupes, 1);
  assert.equal(fresh[0].data.substance, 'Peanut');
});
