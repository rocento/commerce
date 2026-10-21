// Bundle only the pinned viewer files we need; never publish the package demo,
// OAuth redirect handler, sourcemaps, or the gateway's complete private schema.
import { createRequire } from "node:module";
import { copyFile, mkdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const spec = JSON.parse(await readFile(resolve(root, "public/docs/api/openapi.json"), "utf8"));
if (spec.info?.title !== "Rocento Storefront and Customer API") {
  throw new Error("Generate the reviewed public contract with scripts/generate_public_openapi.py before building.");
}
if (Object.keys(spec.paths).some((path) => /admin|assistant|internal|metrics|ready|health/.test(path))) {
  throw new Error("Private operations must not be bundled into the public reference.");
}
const vendor = dirname(require.resolve("swagger-ui-dist/package.json"));
const output = resolve(root, "public/docs/api/reference/vendor");
await mkdir(output, { recursive: true });
for (const name of ["swagger-ui-bundle.js", "swagger-ui.css", "swagger-ui-bundle.js.LICENSE.txt", "LICENSE", "NOTICE"]) {
  await copyFile(resolve(vendor, name), resolve(output, name));
}
console.log(`Prepared self-hosted Swagger UI for ${Object.keys(spec.paths).length} public API paths.`);
