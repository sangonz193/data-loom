declare module "bun:test" {
  export const test: {
    (name: string, fn: () => void | Promise<void>): void
    skip(name: string, fn: () => void | Promise<void>): void
  }

  export function expect(value: unknown): {
    toBe(expected: unknown): void
    toEqual(expected: unknown): void
    toBeNull(): void
    rejects: {
      toMatchObject(expected: Record<string, unknown>): Promise<void>
    }
  }
}
