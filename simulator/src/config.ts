const args = process.argv.slice(2);

function getFlag(name: string, fallback: string): string {
  const idx = args.indexOf(`--${name}`);
  if (idx === -1 || idx + 1 >= args.length) return fallback;
  return args[idx + 1];
}

function hasFlag(name: string): boolean {
  return args.includes(`--${name}`);
}

export const config = {
  apiUrl: getFlag("api", "http://localhost:3001"),
  routers: parseInt(getFlag("routers", "10")),
  rounds: parseInt(getFlag("rounds", "5")),
  delayMs: parseInt(getFlag("delay", "200")),
  attacks: hasFlag("attacks"),
  concurrency: parseInt(getFlag("concurrency", "20")),
};

export type Config = typeof config;
