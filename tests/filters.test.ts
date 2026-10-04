import { runInNewContext } from 'node:vm';
import { audioErrorMessage } from '../src/shared/audio-engine';
import { describe, expect, it } from 'vitest';
import { defaultFilters, filterSettingsSchema, radioParameters } from '../src/shared/filters';
import { emptyLibrary, validateLibrary } from '../src/library/model';
import { userCommandSchema } from '../src/shared/protocol';

describe('sound filter preferences', () => {
  it('adds prototype defaults to existing libraries without resetting volume', () => {
    const data = emptyLibrary();
    const { filters: _filters, ...settings } = data.settings;
    const restored = validateLibrary({ ...data, settings: { ...settings, volume: 42 } });
    expect(restored.settings).toMatchObject({ volume: 42, filters: defaultFilters() });
  });
  it('keeps the verified radio endpoints and fixed volume compensation', () => {
    expect(radioParameters(50)).toMatchObject({ high: 400, low: 3800, presence: 5 });
    expect(radioParameters(100)).toMatchObject({ high: 550, low: 2600, presence: 8 });
    expect(radioParameters(150)).toMatchObject({ high: 700, low: 1400, presence: 11 });
    expect(radioParameters(50).gain).toBeCloseTo(3.9810717);
    expect(radioParameters(150).gain).toBe(radioParameters(50).gain);
  });
  it('validates all toggle combinations and rejects invalid slider input at IPC', () => {
    for (let bits = 0; bits < 8; bits++) {
      const settings = defaultFilters();
      settings.radio.enabled = Boolean(bits & 1); settings.noise.enabled = Boolean(bits & 2); settings.position.enabled = Boolean(bits & 4);
      expect(userCommandSchema.parse({ type: 'filters', filters: settings })).toEqual({ type: 'filters', filters: settings });
    }
    expect(filterSettingsSchema.safeParse({ ...defaultFilters(), noise: { enabled: true, attenuation: 41 } }).success).toBe(false);
    expect(filterSettingsSchema.safeParse({ ...defaultFilters(), position: { enabled: true, pan: NaN } }).success).toBe(false);
  });
});

it('preserves renderer error messages across Electron serialization', () => {
  expect(audioErrorMessage({ name: 'InvalidStateError', message: 'Cannot close a closed AudioContext.' })).toBe('Cannot close a closed AudioContext.');
  expect(audioErrorMessage(runInNewContext('new Error("Audio output failed")'))).toBe('Audio output failed');
  expect(audioErrorMessage('Audio preparation failed')).toBe('Audio preparation failed');
});
