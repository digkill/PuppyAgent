import type { Effort } from './types.ts';

export const EFFORTS: Effort[] = ['auto', 'low', 'medium', 'high', 'xhigh', 'max'];
export function parseEffort(value: string): Effort {
  if (!EFFORTS.includes(value as Effort)) throw new Error(`Effort: ${EFFORTS.join(', ')}`);
  return value as Effort;
}
export function parseModel(value: string): string {
  if (!value.trim() || value.length > 200 || /[\s\x00-\x1f]/.test(value)) throw new Error('Model ID must be a nonempty identifier without whitespace.');
  return value;
}
