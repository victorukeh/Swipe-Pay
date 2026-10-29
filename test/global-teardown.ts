export default async function globalTeardown(): Promise<void> {
  await globalThis.__BORDERLESS_INFRA_STOP__?.();
}
