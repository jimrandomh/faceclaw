import { extractPackage } from './package-extraction';
import type { EvenHubManifest } from './ehpk';
export async function unpackRuntime(path: string, directory: string): Promise<EvenHubManifest> {
  return extractPackage(path, directory);
}
