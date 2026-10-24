export function createAdapterRegistry(adapters) {
  return {
    getAdapter(sourceUrl) {
      return adapters.find((adapter) => adapter.supports(sourceUrl)) ?? null;
    }
  };
}
