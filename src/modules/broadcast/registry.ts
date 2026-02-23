import type { Platform } from "@prisma/client";

import type { PlatformAdapter } from "./types";

/** Registry of platform adapters. */
const adapters = new Map<Platform, PlatformAdapter>();

/**
 * Register a platform adapter.
 * @param adapter - The adapter to register.
 */
export function registerAdapter(adapter: PlatformAdapter): void {
  adapters.set(adapter.platform, adapter);
}

/**
 * Get the adapter for a given platform.
 * @param platform - The platform identifier.
 * @returns The registered adapter.
 * @throws Error if no adapter is registered for the platform.
 */
export function getAdapter(platform: Platform): PlatformAdapter {
  const adapter = adapters.get(platform);
  if (!adapter) {
    throw new Error(`No adapter registered for platform: ${platform}`);
  }
  return adapter;
}

/**
 * Get all registered adapters.
 * @returns Array of all registered adapters.
 */
export function getAllAdapters(): PlatformAdapter[] {
  return Array.from(adapters.values());
}
