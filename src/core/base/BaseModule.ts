import type { Logger } from "pino";

import type { ModuleTag } from "../../types";
import { createLogger } from "../logger";

/**
 * Abstract base class for all modules.
 * Provides singleton pattern and a scoped logger instance.
 */
export abstract class BaseModule {
  protected readonly logger: Logger;
  private static instances = new Map<string, BaseModule>();

  /**
   * @param tag - The module tag for logging.
   */
  protected constructor(tag: ModuleTag) {
    this.logger = createLogger(tag);
  }

  /**
   * Get or create a singleton instance of the module.
   * @param this - The constructor of the derived class.
   * @param args - Constructor arguments.
   * @returns The singleton instance.
   */
  protected static getInstance<T extends BaseModule>(
    this: new (...args: unknown[]) => T,
    ...args: unknown[]
  ): T {
    const key = this.name;
    if (!BaseModule.instances.has(key)) {
      BaseModule.instances.set(key, new this(...args));
    }
    return BaseModule.instances.get(key) as T;
  }
}
