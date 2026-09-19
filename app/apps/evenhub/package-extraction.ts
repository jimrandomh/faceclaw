import { deletePathRecursively, readBinaryFile, writeBinaryFile } from '../../native/file-access';
import { openEhpk, parseManifest, utf8Decode, type EvenHubManifest } from './ehpk';

/** Called on a worker on iOS. Hold only one expanded asset at a time. */
export function extractPackage(path: string, directory: string): EvenHubManifest {
  try {
    const bytes = readBinaryFile(path);
    if (!bytes) throw new Error('Could not read the EHPK file.');
    const archive = openEhpk(bytes);
    const json = archive.files.get('app.json');
    if (!json) throw new Error('The EHPK package has no app.json.');
    const manifest = parseManifest(utf8Decode(json));
    if (!archive.files.has(`dist/${manifest.entrypoint}`)) throw new Error('The EHPK entrypoint is missing from dist/.');
    deletePathRecursively(directory);
    for (const name of archive.files.keys()) {
      if (!writeBinaryFile(`${directory}/${name}`, archive.files.get(name)!)) throw new Error(`Could not unpack ${name}.`);
    }
    return manifest;
  } catch (error) { deletePathRecursively(directory); throw error; }
}
