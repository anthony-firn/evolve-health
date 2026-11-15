// FHIR R4 export: required elements, internal references and a lossless round trip.
// (The HL7 validator is the stronger check; see README "Checks". This test needs no Java.)
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { buildSample } from '../web/src/ui/sample.mjs';
import { toBundle, resourcesFrom, fromResources } from '../web/src/health/fhir.mjs';
import { recordTitle } from '../web/src/health/model.mjs';

let vault;
before(async () => { vault = await buildSample(); });
after(() => vault.lock());

const REQUIRED = {
  Condition: ['subject'], MedicationStatement: ['status', 'medicationCodeableConcept', 'subject'], AllergyIntolerance: ['patient'],
  Immunization: ['status', 'vaccineCode', 'patient'], Observation: ['status', 'code'], Encounter: ['status', 'class'],
  Procedure: ['status', 'subject'], VisionPrescription: ['status', 'created', 'patient', 'dateWritten', 'prescriber', 'lensSpecification'],
  DocumentReference: ['status', 'content'], Coverage: ['status', 'beneficiary', 'payor'], FamilyMemberHistory: ['status', 'patient', 'relationship'],
  RelatedPerson: ['patient'], Flag: ['status', 'code', 'subject'], Provenance: ['target', 'recorded', 'agent'], Patient: [], Practitioner: [], PractitionerRole: [],
};
const DATE = /^\d{4}(-\d{2}(-\d{2})?)?$/;
const DATETIME = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2}))?$/;
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

function bundles() {
  return vault.profiles().map((p) => {
    const records = p.space.list().filter((r) => !['profile', 'share'].includes(r.kind));
    const files = new Map();
    for (const r of records) if (r.kind === 'visit' && r.data.transcript) files.set(`${r.rid}#transcript`, { text: 'hello' });
    return { p, records, bundle: toBundle({ profile: p.space.profile, kind: p.kind, records, files, share: { id: 'test', recipient: 'Dr. Test' } }) };
  });
}

test('every resource has its R4 required elements and valid dates', () => {
  for (const { bundle } of bundles()) {
    assert.equal(bundle.resourceType, 'Bundle');
    assert.equal(bundle.type, 'collection');
    assert.ok(bundle.meta.security.some((s) => s.code === 'TREAT'));
    for (const { fullUrl, resource } of bundle.entry) {
      assert.match(fullUrl, /^urn:uuid:[0-9a-f-]{36}$/);
      assert.ok(resource.resourceType in REQUIRED, `unexpected ${resource.resourceType}`);
      for (const k of REQUIRED[resource.resourceType]) assert.ok(resource[k] !== undefined && resource[k] !== '', `${resource.resourceType}.${k} missing`);
      for (const [k, v] of Object.entries(resource)) {
        if (k === 'birthDate') assert.match(v, DATE);
        if (/DateTime$/.test(k) || ['created', 'dateWritten', 'recordedDate'].includes(k)) assert.match(v, DATETIME, `${resource.resourceType}.${k}=${v}`);
        if (resource.resourceType === 'DocumentReference' && k === 'date') assert.match(v, INSTANT);
        if (resource.resourceType === 'Provenance' && k === 'recorded') assert.match(v, INSTANT);
      }
      if (resource.resourceType === 'VisionPrescription') for (const l of resource.lensSpecification) { assert.ok(l.product && l.eye); }
      if (resource.resourceType === 'Immunization') assert.ok(resource.occurrenceDateTime || resource.occurrenceString);
      for (const tag of resource.meta?.tag || []) assert.ok(tag.system && tag.code);
    }
  }
});

test('every reference points at an entry in the same bundle', () => {
  for (const { bundle } of bundles()) {
    const urls = new Set(bundle.entry.map((e) => e.fullUrl));
    const walk = (v) => {
      if (Array.isArray(v)) v.forEach(walk);
      else if (v && typeof v === 'object') { if (typeof v.reference === 'string') assert.ok(urls.has(v.reference), `dangling ${v.reference}`); Object.values(v).forEach(walk); }
    };
    walk(bundle.entry);
  }
});

test('appointment times keep their local time through export and import', () => {
  const b = toBundle({ profile: { name: 'X' }, kind: 'person', records: [{ rid: 'v', kind: 'visit', data: { date: '2026-01-02T10:00', type: 'Dentist', summary: 'Cavity', followUp: '2026-06-01' } }], files: new Map() });
  const enc = b.entry.find((e) => e.resource.resourceType === 'Encounter').resource;
  assert.match(enc.period.start, /^2026-01-02T10:00:00[+-]\d{2}:\d{2}$/);
  const back = fromResources(resourcesFrom(JSON.stringify(b)), { type: 'fhir' });
  assert.equal(back.records[0].data.date, '2026-01-02T10:00');
  assert.equal(back.records[0].data.summary, 'Cavity');
  assert.equal(back.records[0].data.followUp, '2026-06-01');
});

test('pets use the patient-animal extension', () => {
  const pet = bundles().find((b) => b.p.kind === 'pet').bundle;
  const patient = pet.entry[0].resource;
  const ext = patient.extension.find((e) => e.url === 'http://hl7.org/fhir/StructureDefinition/patient-animal');
  assert.equal(ext.extension.find((e) => e.url === 'species').valueCodeableConcept.text, 'Dog');
  assert.equal(patient.identifier[0].type.text, 'Microchip');
});

test('export then import keeps every record and its title', () => {
  for (const { records, bundle } of bundles()) {
    const back = fromResources(resourcesFrom(JSON.stringify(bundle)), { type: 'fhir' });
    const want = records.map((r) => `${r.kind}|${recordTitle(r)}`).sort();
    const got = back.records.map((r) => `${r.kind}|${recordTitle(r)}`).sort();
    assert.deepEqual(got, want);
    assert.deepEqual(back.skipped, {});
  }
});
