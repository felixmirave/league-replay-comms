import { useId, useRef, useState } from 'react';
import { defaultFilters, type FilterSettings } from '../shared/filters';
import type { DesktopInterface } from '../shared/protocol';

export function useFilters(saved: FilterSettings | undefined, send: DesktopInterface['command'], reportError: (message: string) => void) {
  const [draft, setDraft] = useState<FilterSettings>();
  const current = useRef(saved ?? defaultFilters());
  const revision = useRef(0);
  if (!draft) current.current = saved ?? defaultFilters();
  const change = async (update: (settings: FilterSettings) => FilterSettings) => {
    const edit = ++revision.current;
    const filters = update(current.current);
    current.current = filters;
    setDraft(filters);
    reportError('');
    try { await send({ type: 'filters', filters }); }
    catch (error) { if (edit === revision.current) reportError(error instanceof Error ? error.message : String(error)); }
    finally { if (edit === revision.current) setDraft(undefined); }
  };
  return [draft ?? saved ?? defaultFilters(), change] as const;
}

type Props = { error?: string; filters: FilterSettings; onChange: (update: (settings: FilterSettings) => FilterSettings) => Promise<void> };
export function SoundFilters({ filters, onChange, error }: Props) {
  const id = useId();
  const controls = [
    { key: 'radio' as const, title: 'Radio voice', hint: 'Gives comms a focused radio sound.', min: 50, max: 150, value: filters.radio.strength, accessible: `Strength ${filters.radio.strength - 49} of 101`, ends: ['Lighter', 'Stronger'], slider: 'Radio voice strength', update: (settings: FilterSettings, value: number) => ({ ...settings.radio, strength: value }) },
    { key: 'noise' as const, title: 'Noise suppression', hint: 'Reduces background noise around voices.', min: 10, max: 40, value: filters.noise.attenuation, accessible: `Amount ${filters.noise.attenuation - 9} of 31`, ends: ['Less', 'More'], slider: 'Noise suppression amount', update: (settings: FilterSettings, value: number) => ({ ...settings.noise, attenuation: value }) },
    { key: 'position' as const, title: 'Sound position', hint: 'Moves comms left or right.', min: -100, max: 100, value: filters.position.pan, accessible: filters.position.pan === 0 ? 'Center' : `${Math.abs(filters.position.pan)} steps ${filters.position.pan < 0 ? 'left' : 'right'} of center`, ends: ['Left', 'Right'], slider: 'Sound position', update: (settings: FilterSettings, value: number) => ({ ...settings.position, pan: value }) },
  ];
  return <fieldset className="sound-filters"><legend className="sr-only">Sound filters</legend>{controls.map(control => <div className="sound-filter" key={control.key}>
    <div className="filter-heading"><label className="checkbox"><input type="checkbox" role="switch" checked={filters[control.key].enabled} aria-describedby={`${id}-${control.key}-hint`} onChange={event => { const enabled = event.target.checked; void onChange(settings => ({ ...settings, [control.key]: { ...settings[control.key], enabled } })); }} />{control.title}</label>{control.key === 'position' && filters.position.pan === 0 && <output className="filter-value" htmlFor={`${id}-${control.key}`}>Center</output>}</div>
    <p id={`${id}-${control.key}-hint`} className="filter-hint">{control.hint}</p>
    <input id={`${id}-${control.key}`} type="range" aria-label={control.slider} aria-describedby={`${id}-${control.key}-hint`} aria-valuetext={control.accessible} min={control.min} max={control.max} step="1" value={control.value} disabled={!filters[control.key].enabled} onChange={event => { const value = Number(event.target.value); void onChange(settings => ({ ...settings, [control.key]: control.update(settings, value) })); }} />
    <div className="filter-endpoints" aria-hidden="true"><span>{control.ends[0]}</span><span>{control.ends[1]}</span></div>
  </div>)}{error && <p className="error" role="alert">{error}</p>}</fieldset>;
}
