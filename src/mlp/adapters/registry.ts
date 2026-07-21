import type { AdapterRegistration, AnyOculoryAdapter } from './types.js';

const ID = /^[a-z][a-z0-9-]{0,63}$/;
const VERSION = /^[a-z0-9][a-z0-9.-]{0,63}$/;

export class AdapterRegistry {
  readonly #registrations = new Map<string, AdapterRegistration>();

  register<Adapter extends AnyOculoryAdapter>(registration: AdapterRegistration<Adapter>): void {
    if (!ID.test(registration.id)) throw new Error(`invalid adapter ID: ${registration.id}`);
    if (!VERSION.test(registration.version)) throw new Error(`invalid adapter version: ${registration.version}`);
    if (this.#registrations.has(registration.id)) throw new Error(`adapter already registered: ${registration.id}`);
    this.#registrations.set(registration.id, registration as AdapterRegistration);
  }

  resolve(id: string): AdapterRegistration {
    const registration = this.#registrations.get(id);
    if (registration === undefined) throw new Error(`unknown adapter: ${id}`);
    return registration;
  }

  list(): ReadonlyArray<{ id: string; version: string }> {
    return [...this.#registrations.values()]
      .map(({ id, version }) => ({ id, version }))
      .sort((left, right) => left.id.localeCompare(right.id));
  }
}

export function createAdapterRegistry(): AdapterRegistry {
  return new AdapterRegistry();
}

export function registerAdapter<Adapter extends AnyOculoryAdapter>(
  registry: AdapterRegistry,
  registration: AdapterRegistration<Adapter>,
): void {
  registry.register(registration);
}

export function resolveAdapter(registry: AdapterRegistry, id: string): AdapterRegistration {
  return registry.resolve(id);
}

export function listAdapters(registry: AdapterRegistry): ReadonlyArray<{ id: string; version: string }> {
  return registry.list();
}
