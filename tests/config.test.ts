import { describe, expect, it } from 'vitest';
import { enableReplayConfig, inspectReplayConfig } from '../src/platform/config';

describe('Replay API configuration edits', () => {
  it('changes only the intended value, preserving formatting and other sections', () => {
    const original = '; keep this\r\n[General]\r\n  EnableReplayApi = 0  ; user note\r\nWidth=1920\r\n[Other]\r\nEnableReplayApi=0\r\n';
    const result = enableReplayConfig(Buffer.from(original));
    expect(result.toString()).toBe(original.replace('= 0  ;', '= 1  ;'));
    expect(inspectReplayConfig(result)).toEqual({ state: 'enabled' });
  });

  it('preserves UTF-16LE BOM and non-ASCII comments', () => {
    const original = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('[General]\r\n; žaidimas\r\nEnableReplayApi=0', 'utf16le')]);
    const expected = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('[General]\r\n; žaidimas\r\nEnableReplayApi=1', 'utf16le')]);
    expect(enableReplayConfig(original)).toEqual(expected);
  });

  it('adds a missing key inside General rather than a later section', () => {
    const source = '[General]\nWidth=1920\n[Audio]\nVolume=50\n';
    expect(inspectReplayConfig(Buffer.from(source))).toEqual({ state: 'disabled', missing: 'key' });
    expect(enableReplayConfig(Buffer.from(source)).toString()).toBe('[General]\nWidth=1920\nEnableReplayApi=1\n[Audio]\nVolume=50\n');
  });

  it('handles missing final newline and a missing section without changing previous bytes', () => {
    const original = Buffer.from('[Audio]\nVolume=50');
    expect(enableReplayConfig(original).toString()).toBe('[Audio]\nVolume=50\n[General]\nEnableReplayApi=1\n');
    expect(enableReplayConfig(Buffer.from('[General]')).toString()).toBe('[General]\r\nEnableReplayApi=1\r\n');
  });

  it.each([
    '[General]\nEnableReplayApi=0\nEnableReplayApi=1',
    '[General]\nEnableReplayApi=1\n[General]\nWidth=10',
    '[General]\nEnableReplayApi=true',
    '[General\nEnableReplayApi=0',
    '[General]\nEnableReplayApi 0',
  ])('refuses ambiguous/malformed input without modifying it: %s', input => {
    const original = Buffer.from(input);
    expect(inspectReplayConfig(original).state).toBe('ambiguous');
    expect(() => enableReplayConfig(original)).toThrow();
    expect(original.toString()).toBe(input);
  });

  it('does not treat unrelated or commented keys as enabled and is idempotent', () => {
    const input = Buffer.from('\ufeff[General]\n; EnableReplayApi=1\n[Other]\nEnableReplayApi=1\n');
    expect(inspectReplayConfig(input).state).toBe('disabled');
    const enabled = enableReplayConfig(input);
    expect(enabled.subarray(0, 3)).toEqual(Buffer.from([0xef, 0xbb, 0xbf]));
    expect(enableReplayConfig(enabled)).toEqual(enabled);
  });
});
