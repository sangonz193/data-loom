export function canonicalConnectionIds(first: string, second: string) {
  return first < second ?
      ([first, second] as const)
    : ([second, first] as const)
}
