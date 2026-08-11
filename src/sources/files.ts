import { readdir } from "node:fs/promises";
import { join } from "node:path";

export async function walkFiles(root: string, extension: string): Promise<string[]> {
  const output: string[] = [];
  const visit = async (directory: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }
    await Promise.all(
      entries.map(async (entry) => {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) await visit(path);
        else if (entry.isFile() && entry.name.endsWith(extension)) output.push(path);
      }),
    );
  };
  await visit(root);
  return output;
}
