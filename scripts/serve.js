// Minimal static server for local development, no dependencies.
// localhost is a secure context, which the built-in AI APIs require.
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { extname, join, normalize, sep } from "node:path";

const root = fileURLToPath( new URL( "..", import.meta.url ) );
const port = Number( process.env.PORT ) || 8080;

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon"
};

createServer( async ( req, res ) => {
  const pathname = decodeURIComponent( new URL( req.url, "http://localhost" ).pathname );
  let file = normalize( join( root, pathname ) );
  if ( file !== root && !file.startsWith( root.endsWith( sep ) ? root : root + sep ) ) {
    res.writeHead( 403 ).end( "Forbidden" );
    return;
  }
  try {
    if ( ( await stat( file ) ).isDirectory() ) {
      file = join( file, "index.html" );
    }
    const body = await readFile( file );
    res.writeHead( 200, {
      "Content-Type": TYPES[ extname( file ) ] ?? "application/octet-stream",
      "Cache-Control": "no-store"
    }).end( body );
  } catch {
    res.writeHead( 404 ).end( "Not found" );
  }
}).listen( port, () => {
  console.info( `Acme Support running at http://localhost:${ port }` );
});
