export default async function globalTeardown(): Promise<void> {
  await globalThis.__CARDTONIC_INFRA_STOP__?.();
}
