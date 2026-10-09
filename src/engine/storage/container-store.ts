import { CONTAINER_COLORS, CookieJar, type Container, type ContainerColor, type ContainerId } from '../../core';
import type { StorageAreaLike } from './storage-area';

export const CONTAINERS_KEY = 'containers';
export const jarKey = (id: ContainerId): string => `jar:${id}`;

const MAX_NAME_LENGTH = 64;

export class ContainerError extends Error {}

/** Container IDs end up in storage prefixes and DNR data URLs: keep them short, lowercase alphanumerics. */
export function generateContainerId(random: () => number = Math.random): ContainerId {
  let id = '';
  for (let i = 0; i < 10; i++) id += Math.floor(random() * 36).toString(36);
  return id;
}

export function normalizeName(name: unknown): string {
  if (typeof name !== 'string') throw new ContainerError('container name must be a string');
  const trimmed = name.trim().replace(/\s+/g, ' ');
  if (trimmed === '') throw new ContainerError('container name must not be empty');
  if (trimmed.length > MAX_NAME_LENGTH) throw new ContainerError(`container name longer than ${MAX_NAME_LENGTH} characters`);
  return trimmed;
}

function isContainer(x: unknown): x is Container {
  if (typeof x !== 'object' || x === null) return false;
  const c = x as Record<string, unknown>;
  return (
    typeof c.id === 'string' &&
    /^[a-z0-9]{1,32}$/.test(c.id) &&
    typeof c.name === 'string' &&
    typeof c.color === 'string' &&
    (CONTAINER_COLORS as readonly string[]).includes(c.color) &&
    typeof c.createdAt === 'number'
  );
}

export interface ContainerStoreOptions {
  /** Jar writes are debounced by this many ms (default 150). */
  debounceMs?: number;
  now?: () => number;
  random?: () => number;
}

/**
 * Containers (`containers` key) and their cookie jars (`jar:<id>` keys) in `chrome.storage.local`.
 * Memory is the source of truth while the worker lives; jar writes are debounced and `flush()`ed on suspend.
 */
export class ContainerStore {
  private containers: Container[] = [];
  private readonly jars = new Map<ContainerId, CookieJar>();
  private readonly dirtyJars = new Set<ContainerId>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private writing: Promise<void> = Promise.resolve();
  private readonly debounceMs: number;
  private readonly now: () => number;
  private readonly random: () => number;

  constructor(
    private readonly area: StorageAreaLike,
    options: ContainerStoreOptions = {},
  ) {
    this.debounceMs = options.debounceMs ?? 150;
    this.now = options.now ?? Date.now;
    this.random = options.random ?? Math.random;
  }

  async load(): Promise<void> {
    const stored = await this.area.get(CONTAINERS_KEY);
    const list = stored[CONTAINERS_KEY];
    this.containers = Array.isArray(list) ? list.filter(isContainer) : [];
    this.jars.clear();
    if (this.containers.length === 0) return;
    const jarData = await this.area.get(this.containers.map((c) => jarKey(c.id)));
    for (const c of this.containers) this.jars.set(c.id, CookieJar.fromJSON(jarData[jarKey(c.id)]));
  }

  list(): Container[] {
    return this.containers.map((c) => ({ ...c }));
  }

  get(id: ContainerId): Container | undefined {
    const found = this.containers.find((c) => c.id === id);
    return found ? { ...found } : undefined;
  }

  findByName(name: string): Container | undefined {
    const wanted = name.trim().toLowerCase();
    const found = this.containers.find((c) => c.name.toLowerCase() === wanted);
    return found ? { ...found } : undefined;
  }

  /** By exact ID first, then by case-insensitive name. */
  resolve(ref: string): Container | undefined {
    return this.get(ref) ?? this.findByName(ref);
  }

  async create(input: { name: string; color?: ContainerColor }): Promise<Container> {
    const name = normalizeName(input.name);
    if (this.findByName(name)) throw new ContainerError(`a container named "${name}" already exists`);
    if (input.color !== undefined && !(CONTAINER_COLORS as readonly string[]).includes(input.color)) {
      throw new ContainerError(`unknown color "${String(input.color)}"`);
    }
    let id = generateContainerId(this.random);
    while (this.get(id)) id = generateContainerId(this.random);
    const color = input.color ?? CONTAINER_COLORS[this.containers.length % CONTAINER_COLORS.length]!;
    const container: Container = { id, name, color, createdAt: this.now() };
    this.containers.push(container);
    this.jars.set(id, new CookieJar());
    await this.area.set({ [CONTAINERS_KEY]: this.containers, [jarKey(id)]: this.jars.get(id)!.toJSON() });
    return { ...container };
  }

  async update(id: ContainerId, patch: { name?: string; color?: ContainerColor }): Promise<Container> {
    const container = this.containers.find((c) => c.id === id);
    if (!container) throw new ContainerError(`no container "${id}"`);
    if (patch.name !== undefined) {
      const name = normalizeName(patch.name);
      const clash = this.findByName(name);
      if (clash && clash.id !== id) throw new ContainerError(`a container named "${name}" already exists`);
      container.name = name;
    }
    if (patch.color !== undefined) {
      if (!(CONTAINER_COLORS as readonly string[]).includes(patch.color)) throw new ContainerError(`unknown color "${String(patch.color)}"`);
      container.color = patch.color;
    }
    await this.area.set({ [CONTAINERS_KEY]: this.containers });
    return { ...container };
  }

  async delete(id: ContainerId): Promise<boolean> {
    const index = this.containers.findIndex((c) => c.id === id);
    if (index === -1) return false;
    this.containers.splice(index, 1);
    this.jars.delete(id);
    this.dirtyJars.delete(id);
    await this.area.set({ [CONTAINERS_KEY]: this.containers });
    await this.area.remove(jarKey(id));
    return true;
  }

  /** The live jar of a container; mutate it, then call `touchJar`. */
  jar(id: ContainerId): CookieJar {
    let jar = this.jars.get(id);
    if (!jar) {
      jar = new CookieJar();
      if (this.get(id)) this.jars.set(id, jar);
    }
    return jar;
  }

  touchJar(id: ContainerId): void {
    if (!this.get(id)) return;
    this.dirtyJars.add(id);
    if (this.timer === null) this.timer = setTimeout(() => void this.flush(), this.debounceMs);
  }

  /** Writes every dirty jar now. */
  flush(): Promise<void> {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    const ids = [...this.dirtyJars];
    this.dirtyJars.clear();
    if (ids.length === 0) return this.writing;
    const items: Record<string, unknown> = {};
    for (const id of ids) {
      const jar = this.jars.get(id);
      if (jar) items[jarKey(id)] = jar.toJSON();
    }
    this.writing = this.writing.then(() => this.area.set(items)).catch(() => {
      for (const id of ids) this.dirtyJars.add(id);
    });
    return this.writing;
  }
}
