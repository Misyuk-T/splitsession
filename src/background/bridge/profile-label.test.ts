import { describe, expect, it } from 'vitest';
import { MemoryStorageArea } from '../../engine/storage/storage-area';
import { cleanProfileLabel, PROFILE_LABEL_MAX, readProfileLabel, writeProfileLabel } from './profile-label';

describe('profile label', () => {
  it('is one short line without control characters', () => {
    expect(cleanProfileLabel('  Work\n\tprofile  ')).toBe('Work profile');
    expect(cleanProfileLabel('x'.repeat(100))).toHaveLength(PROFILE_LABEL_MAX);
    expect(cleanProfileLabel(42)).toBe('');
    expect(cleanProfileLabel('😀'.repeat(50))).toBe('😀'.repeat(PROFILE_LABEL_MAX));
  });

  it('is empty by default, stored when set and forgotten when cleared', async () => {
    const area = new MemoryStorageArea();
    expect(await readProfileLabel(area)).toBe('');
    expect(await writeProfileLabel(area, ' Personal ')).toBe('Personal');
    expect(await readProfileLabel(area)).toBe('Personal');
    expect(await writeProfileLabel(area, '   ')).toBe('');
    expect(area.data.size).toBe(0);
  });
});
