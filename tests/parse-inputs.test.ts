import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseActionInputs, readRawInput } from '../src/index.js';
import { writeStepSummary } from '../src/summary.js';

describe('readRawInput', () => {
  it('reads hyphenated and underscored INPUT_ keys, trimmed', () => {
    expect(readRawInput('doit-api-key', { 'INPUT_DOIT-API-KEY': '  a  ' })).toBe('a');
    expect(readRawInput('doit-api-key', { INPUT_DOIT_API_KEY: ' b ' })).toBe('b');
  });

  it('prefers the hyphenated key and skips empty values', () => {
    expect(
      readRawInput('doit-api-key', { 'INPUT_DOIT-API-KEY': 'a', INPUT_DOIT_API_KEY: 'b' })
    ).toBe('a');
    expect(
      readRawInput('doit-api-key', { 'INPUT_DOIT-API-KEY': '', INPUT_DOIT_API_KEY: 'b' })
    ).toBe('b');
  });

  it('returns an empty string when nothing is set in a custom env', () => {
    expect(readRawInput('operation', {})).toBe('');
  });
});

describe('parseActionInputs defaults', () => {
  it('applies defaults for an empty environment', () => {
    expect(parseActionInputs({})).toEqual({
      doitApiKey: '',
      operation: 'create',
      annotationId: undefined,
      releaseId: undefined,
      content: undefined,
      template: undefined,
      timestamp: undefined,
      reports: [],
      labels: [],
      createMissingLabels: false,
      labelColor: 'blue',
      tenantId: undefined,
      apiUrl: 'https://api.doit.com',
      dryRun: false,
      failOnError: true,
      filter: undefined,
      maxResults: undefined,
      requireTag: undefined,
      requireCommitTag: [],
      requirePrLabel: [],
    });
  });
});

describe('parseActionInputs environment fallbacks', () => {
  it('falls back to DOIT_* environment variables, trimmed', () => {
    const inputs = parseActionInputs({
      DOIT_API_KEY: ' env_key ',
      DOIT_TENANT_ID: ' env_tenant ',
      DOIT_API_URL: ' https://eu.api.doit.com ',
    });
    expect(inputs.doitApiKey).toBe('env_key');
    expect(inputs.tenantId).toBe('env_tenant');
    expect(inputs.apiUrl).toBe('https://eu.api.doit.com');
  });

  it('prefers explicit inputs over DOIT_* environment variables', () => {
    const inputs = parseActionInputs({
      'INPUT_DOIT-API-KEY': 'input_key',
      'INPUT_TENANT-ID': 'input_tenant',
      'INPUT_API-URL': 'https://input.api.doit.com',
      DOIT_API_KEY: 'env_key',
      DOIT_TENANT_ID: 'env_tenant',
      DOIT_API_URL: 'https://env.api.doit.com',
    });
    expect(inputs.doitApiKey).toBe('input_key');
    expect(inputs.tenantId).toBe('input_tenant');
    expect(inputs.apiUrl).toBe('https://input.api.doit.com');
  });

  it('treats blank environment fallbacks as unset', () => {
    const inputs = parseActionInputs({ DOIT_API_URL: '   ', DOIT_API_KEY: '' });
    expect(inputs.apiUrl).toBe('https://api.doit.com');
    expect(inputs.doitApiKey).toBe('');
  });
});

describe('parseActionInputs optional text inputs', () => {
  it('reads and trims each optional input', () => {
    const inputs = parseActionInputs({
      'INPUT_ANNOTATION-ID': ' ann_1 ',
      'INPUT_RELEASE-ID': ' v1 ',
      INPUT_CONTENT: ' hello ',
      INPUT_TEMPLATE: ' {tag} ',
      INPUT_TIMESTAMP: ' 2026-10-21T10:00:00Z ',
      INPUT_FILTER: ' foo ',
      'INPUT_REQUIRE-TAG': ' v* ',
    });
    expect(inputs).toMatchObject({
      annotationId: 'ann_1',
      releaseId: 'v1',
      content: 'hello',
      template: '{tag}',
      timestamp: '2026-10-21T10:00:00Z',
      filter: 'foo',
      requireTag: 'v*',
    });
  });

  it('parses comma and newline separated list inputs', () => {
    const inputs = parseActionInputs({
      INPUT_REPORTS: 'r1, r2\nr1',
      INPUT_LABELS: 'a,b',
      'INPUT_REQUIRE-COMMIT-TAG': '[annotate]\n#finops',
      'INPUT_REQUIRE-PR-LABEL': 'release, finops',
    });
    expect(inputs.reports).toEqual(['r1', 'r2']);
    expect(inputs.labels).toEqual(['a', 'b']);
    expect(inputs.requireCommitTag).toEqual(['[annotate]', '#finops']);
    expect(inputs.requirePrLabel).toEqual(['release', 'finops']);
  });
});

describe('parseActionInputs enums', () => {
  it('lower-cases the operation', () => {
    expect(parseActionInputs({ INPUT_OPERATION: 'UPDATE' }).operation).toBe('update');
  });

  it('lists valid operations and label colors in errors', () => {
    expect(() => parseActionInputs({ INPUT_OPERATION: 'nope' })).toThrow(
      'Invalid operation "nope". Must be one of: create, update, delete, get, list'
    );
    expect(() => parseActionInputs({ 'INPUT_LABEL-COLOR': 'nope' })).toThrow(
      /Invalid label-color "nope"\. Must be one of: blue, skyBlue/
    );
  });

  it('keeps the label color case-sensitive', () => {
    expect(() => parseActionInputs({ 'INPUT_LABEL-COLOR': 'Blue' })).toThrow(
      'Invalid label-color "Blue"'
    );
  });
});

describe('parseActionInputs max-results', () => {
  it.each([
    ['1', 1],
    ['500', 500],
    ['25', 25],
    ['5.5', 5],
  ])('accepts %s as %i', (raw, expected) => {
    expect(parseActionInputs({ 'INPUT_MAX-RESULTS': raw }).maxResults).toBe(expected);
  });

  it.each(['0', '501', '-3', 'abc'])('rejects %s', (raw) => {
    expect(() => parseActionInputs({ 'INPUT_MAX-RESULTS': raw })).toThrow(
      `Invalid max-results "${raw}". Expected an integer between 1 and 500.`
    );
  });

  it('leaves max-results undefined when blank', () => {
    expect(parseActionInputs({ 'INPUT_MAX-RESULTS': '' }).maxResults).toBeUndefined();
  });
});

describe('parseActionInputs booleans', () => {
  it.each(['true', 'TRUE', '1', 'yes', 'Y', ' true '])('reads %j as true', (raw) => {
    expect(parseActionInputs({ 'INPUT_DRY-RUN': raw }).dryRun).toBe(true);
  });

  it.each(['false', 'FALSE', '0', 'no', 'N'])('reads %j as false', (raw) => {
    expect(parseActionInputs({ 'INPUT_FAIL-ON-ERROR': raw }).failOnError).toBe(false);
  });

  it('uses each flag default for unrecognized or empty values', () => {
    const inputs = parseActionInputs({
      'INPUT_DRY-RUN': 'maybe',
      'INPUT_FAIL-ON-ERROR': 'maybe',
      'INPUT_CREATE-MISSING-LABELS': '',
    });
    expect(inputs.dryRun).toBe(false);
    expect(inputs.failOnError).toBe(true);
    expect(inputs.createMissingLabels).toBe(false);
  });
});

describe('writeStepSummary', () => {
  it('returns false and writes nothing when GITHUB_STEP_SUMMARY is unset or blank', () => {
    expect(writeStepSummary('x', {})).toBe(false);
    expect(writeStepSummary('x', { GITHUB_STEP_SUMMARY: '   ' })).toBe(false);
  });

  it('appends the markdown with a trailing newline', () => {
    const file = path.join(os.tmpdir(), `annotato-summary-${Date.now()}-${Math.random()}.md`);
    fs.writeFileSync(file, 'existing\n');
    try {
      expect(writeStepSummary('hello', { GITHUB_STEP_SUMMARY: file })).toBe(true);
      expect(fs.readFileSync(file, 'utf8')).toBe('existing\nhello\n');
    } finally {
      fs.unlinkSync(file);
    }
  });
});
