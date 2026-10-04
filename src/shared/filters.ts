import { z } from 'zod';

export const filterSettingsSchema = z.object({
  radio: z.object({ enabled: z.boolean(), strength: z.number().finite().min(50).max(150) }),
  noise: z.object({ enabled: z.boolean(), attenuation: z.number().finite().min(10).max(40) }),
  position: z.object({ enabled: z.boolean(), pan: z.number().finite().min(-100).max(100) }),
});
export type FilterSettings = z.infer<typeof filterSettingsSchema>;
export const defaultFilters = (): FilterSettings => ({
  radio: { enabled: true, strength: 100 },
  noise: { enabled: true, attenuation: 25 },
  position: { enabled: false, pan: -60 },
});
export const radioParameters = (strength: number) => ({ high: 250 + strength * 3, low: 5000 - strength * 24, presence: 2 + strength * 0.06, gain: 10 ** (12 / 20) });
