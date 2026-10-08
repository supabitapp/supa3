export function createConcurrencyLimiter(concurrency: number) {
  let active = 0;
  const waiting: Array<() => void> = [];
  return async <A>(operation: () => Promise<A>): Promise<A> => {
    if (active >= concurrency) await new Promise<void>((resolve) => waiting.push(resolve));
    else active += 1;
    try {
      return await operation();
    } finally {
      const next = waiting.shift();
      if (next) next();
      else active -= 1;
    }
  };
}
