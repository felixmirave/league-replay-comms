import { z } from 'zod';

export const cropSchema = z.object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1), width: z.number().positive().max(1), height: z.number().positive().max(1) }).refine(crop => crop.x + crop.width <= 1.000001 && crop.y + crop.height <= 1.000001, 'Crop extends outside the picture');
export type Crop = z.infer<typeof cropSchema>;
