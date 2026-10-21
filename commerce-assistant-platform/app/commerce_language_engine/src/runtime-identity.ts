import {createHash} from 'node:crypto';
import {readFile, readdir} from 'node:fs/promises';

/** Identify executable parser sources, its wire schema and locked dependencies.
 * Artifact/corpus content have separate identities; tests and CLI flags do not.
 */
export async function runtimeSha256(root = new URL('../', import.meta.url)): Promise<string> {
  const paths: string[] = ['package-lock.json'];
  async function collect(directory: string): Promise<void> {
    for (const entry of await readdir(new URL(directory, root), {withFileTypes: true})) {
      const path = directory + entry.name;
      if (entry.isDirectory()) await collect(path + '/');
      else if (entry.isFile() && /\.(?:ts|json)$/.test(entry.name)) paths.push(path);
    }
  }
  await collect('src/');
  const hash = createHash('sha256');
  for (const path of paths.sort()) {
    const body = await readFile(new URL(path, root));
    hash.update(path + '\0' + body.length + '\0');
    hash.update(body);
  }
  return hash.digest('hex');
}
