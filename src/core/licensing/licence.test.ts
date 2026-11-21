// #1722 — the licence vocabulary. Unknown never reads as allowed; a recorded verdict reads as the
// director's licence with the credit the manifest records, verbatim.

import { describe, expect, it } from 'vitest';
import { MODEL_RECORDS } from './allowedModels';
import { aBlockedRecord } from './blockedModelForTests';
import {
  commercialAllowed,
  licenceOfModel,
  licenceOfProvider,
  MODEL_PROVIDERS,
  UNKNOWN_IMPORT_LICENCE,
} from './licence';
import { StubModelGenerationCapability } from '../modelgen/StubModelGenerationCapability';

describe('licence vocabulary', () => {
  it('only a recorded yes is allowed', () => {
    expect(commercialAllowed({ ...UNKNOWN_IMPORT_LICENCE, commercial: 'yes' })).toBe(true);
    expect(commercialAllowed({ ...UNKNOWN_IMPORT_LICENCE, commercial: 'no' })).toBe(false);
    expect(commercialAllowed(UNKNOWN_IMPORT_LICENCE)).toBe(false);
  });

  it('a blocked checkpoint is non-commercial', () => {
    const blocked = aBlockedRecord();
    const licence = licenceOfModel(blocked.name.split(',')[0]!.trim());
    expect(licence.kind).toBe('non-commercial');
    expect(licence.commercial).toBe('no');
  });

  it('a conditional grant owes its attribution, verbatim from the manifest', () => {
    const conditional = MODEL_RECORDS.find((r) => r.verdict === 'ALLOWED_WITH_CONDITIONS')!;
    const licence = licenceOfModel(conditional.id);
    expect(licence.kind).toBe('credit-required');
    expect(licence.commercial).toBe('yes');
    expect(licence.credit).toBe(conditional.attribution);
  });

  it('a weights file name resolves without its extension, and an unknown one stays unknown', () => {
    const allowed = MODEL_RECORDS.find((r) => r.verdict === 'ALLOWED' && !r.id.includes('api'))!;
    expect(licenceOfModel(`${allowed.id}.safetensors`).commercial).toBe('yes');
    const unknown = licenceOfModel('no-such-model.safetensors');
    expect(unknown.kind).toBe('unknown');
    expect(commercialAllowed(unknown)).toBe(false);
  });

  it('every registered provider is keyed by a real capability id', () => {
    // The stub's own id, read off the capability, so a renamed id reds here.
    expect(Object.keys(MODEL_PROVIDERS)).toContain(new StubModelGenerationCapability().id);
  });

  it('a hosted service is never a green tick, and an unregistered provider is unknown', () => {
    expect(licenceOfProvider('tripo-model-generation').commercial).toBe('unknown');
    expect(licenceOfProvider('nobody-knows').commercial).toBe('unknown');
    expect(licenceOfProvider('stub-modelgen').commercial).toBe('yes');
  });
});
