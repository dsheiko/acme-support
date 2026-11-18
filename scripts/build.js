// Copies the site into dist/ for deployment. No bundling, the app runs as plain ES modules.
import { cp, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { SITE_FILES } from "./site-files.js";

const root = fileURLToPath( new URL( "..", import.meta.url ) );
const out = join( root, "dist" );

await rm( out, { recursive: true, force: true });
for ( const entry of SITE_FILES ) {
  await cp( join( root, entry ), join( out, entry ), { recursive: true });
}
// GitHub Pages runs Jekyll by default. This turns it off.
await writeFile( join( out, ".nojekyll" ), "" );

console.info( `Built ${ SITE_FILES.join( ", " ) } into dist/` );
