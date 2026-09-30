import { describe, expect, it } from 'vitest';
import { parseProbe } from '../src/analysis/probe';
import { frameMediaTime, streamRange } from '../src/shared/media';

describe('media timestamp conversion', () => {
  it('preserves stream-relative A/V delay while using the engine origin', () => {
    const probe = parseProbe({ format: { format_name: 'mov,mp4', start_time: '5', duration: '8' }, streams: [
      { index: 0, codec_type: 'video', codec_name: 'h264', start_time: '5', duration: '3', width: 320, height: 180 },
      { index: 1, codec_type: 'audio', codec_name: 'aac', start_time: '5.5', duration: '2', channels: 1, sample_rate: '48000' },
    ] });
    expect(streamRange(probe.streams[1]!, probe, 0)).toEqual({ startSeconds: 5.5, endSeconds: 7.5, evidence: 'stream-duration' });
    expect(streamRange(probe.streams[1]!, probe, 5)).toEqual({ startSeconds: 0.5, endSeconds: 2.5, evidence: 'stream-duration' });
    expect(frameMediaTime(6.125, 5)).toBe(1.125);
  });
  it('interprets the tested Matroska tag as an ending PTS rather than adding the start again', () => {
    const probe = parseProbe({ format: { format_name: 'matroska,webm', start_time: '5', duration: '8' }, streams: [
      { index: 1, codec_type: 'audio', start_time: '5.5', tags: { ENCODER: 'Lavc59.37.100 aac', DURATION: '00:00:07.500000000' } },
    ] });
    expect(streamRange(probe.streams[0]!, probe, 5)?.endSeconds).toBe(2.5);
  });
  it('does not turn unavailable starts/durations into zero or container-wide playable ranges', () => {
    const probe = parseProbe({ format: { format_name: 'matroska', duration: '100' }, streams: [
      { index: 1, codec_type: 'audio', start_time: 'N/A', duration: 'N/A', tags: { DURATION: '00:01:40.000' } },
    ] });
    expect(streamRange(probe.streams[0]!, probe, 0)).toBeUndefined();
    expect(() => frameMediaTime(NaN, 0)).toThrow();
  });
  it('clips negative preroll at the canonical start without resetting the stream duration', () => {
    const probe = parseProbe({ format: { format_name: 'ogg' }, streams: [
      { index: 0, codec_type: 'audio', start_time: '-0.02', duration: '3.02' },
    ] });
    expect(streamRange(probe.streams[0]!, probe, 0)).toEqual({ startSeconds: 0, endSeconds: 3, evidence: 'stream-duration' });
  });
  it('excludes attached artwork from video analysis and refuses recordings without audio', () => {
    const probe = parseProbe({ format: { format_name: 'mp3' }, streams: [
      { index: 0, codec_type: 'audio', duration: '3' },
      { index: 1, codec_type: 'video', width: 500, height: 500, disposition: { attached_pic: 1 } },
    ] });
    expect(probe.streams).toHaveLength(1);
    expect(() => parseProbe({ streams: [{ index: 0, codec_type: 'video' }] })).toThrow('no playable audio');
  });
});
