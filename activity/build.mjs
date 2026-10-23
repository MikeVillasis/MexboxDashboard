// Builds the Discord Activity into activity/dist from the shared Windows front end (src/Dashboard.App/WebAssets).
// WebAssets stays the single source; this only re-packages it:
//   app.js           main.js + three.js bundled into one module (no inline import map, fewer proxied requests)
//   discord-host.js  the Discord adapter + SDK, a classic script that must run before bridge.js
//   bridge.js, css/, sounds/ copied as-is; index.html rewritten to load the above.
//
// --dev builds activity/dist-dev with dev/fake-sdk.js in place of the Discord SDK, for tools/activity-dev (local
// multi-user testing in a browser). The production build compiles the dev branches away.
import * as esbuild from "esbuild";
import { cp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";

const here = import.meta.dirname;
const assets = path.join(here, "..", "src", "Dashboard.App", "WebAssets");
const sounds = path.join(here, "..", "src", "Dashboard.App", "Assets", "Sounds");
const dev = process.argv.includes("--dev");
const dist = path.join(here, dev ? "dist-dev" : "dist");

/** Resolves the import-map names ("three", "three/addons/...") to the vendored copies. */
const vendoredThree = {
  name: "vendored-three",
  setup(build) {
    build.onResolve({ filter: /^three(\/addons\/.*)?$/ }, (args) => ({
      path: args.path === "three"
        ? path.join(assets, "vendor", "three", "three.module.min.js")
        : path.join(assets, "vendor", "three", args.path.slice("three/".length)),
    }));
  },
};

/** Every rewrite must match exactly once, so a change to index.html fails the build instead of shipping broken. */
function rewrite(html, find, replace) {
  const count = html.split(find).length - 1;
  if (count !== 1) throw new Error(`index.html: expected 1 match for ${JSON.stringify(find)}, found ${count}`);
  return html.replace(find, replace);
}

await rm(dist, { recursive: true, force: true });
await mkdir(path.join(dist, "sounds"), { recursive: true });

await esbuild.build({
  entryPoints: [path.join(assets, "js", "main.js")],
  outfile: path.join(dist, "app.js"),
  bundle: true, format: "esm", minify: true, sourcemap: true, target: "es2022", plugins: [vendoredThree], logLevel: "warning",
});
await esbuild.build({
  entryPoints: [path.join(here, "src", "discord-host.js")],
  outfile: path.join(dist, "discord-host.js"),
  bundle: true, format: "iife", minify: true, sourcemap: true, target: "es2022", logLevel: "warning",
  define: { DEV_SDK: String(dev) },
  alias: dev ? { "@discord/embedded-app-sdk": path.join(here, "dev", "fake-sdk.js") } : {},
});

await cp(path.join(assets, "js", "bridge.js"), path.join(dist, "bridge.js"));
await cp(path.join(assets, "css"), path.join(dist, "css"), { recursive: true });
await cp(path.join(here, "src", "activity.css"), path.join(dist, "activity.css"));
// The mannequin body (activity/tools/build-mannequin.mjs); its presence switches avatars to the mannequin kit.
await cp(path.join(here, "models"), path.join(dist, "models"), { recursive: true });
for (const file of await readdir(sounds)) {
  if (file.endsWith(".wav")) await cp(path.join(sounds, file), path.join(dist, "sounds", file));
}

let html = await readFile(path.join(assets, "index.html"), "utf8");
html = html.replace(/\s*<script type="importmap">[\s\S]*?<\/script>/, "");
if (html.includes("importmap")) throw new Error("index.html: import map not removed");
html = rewrite(html, '<link rel="stylesheet" href="css/shell.css">', '<link rel="stylesheet" href="css/shell.css">\n  <link rel="stylesheet" href="activity.css">');
html = rewrite(html, '<script src="js/bridge.js"></script>', '<script src="discord-host.js"></script>\n  <script src="bridge.js"></script>');
html = rewrite(html, '<script src="vendor/peerjs/peerjs.min.js"></script>', "");
html = rewrite(html, '<script type="module" src="js/main.js"></script>', '<script type="module" src="app.js"></script>');
html = rewrite(html, "<title>xbox 360 dashboard</title>", "<title>mexbox plaza</title>");
// CC-BY-4.0 credit for the mannequin body, under the avatar customiser.
html = rewrite(html, '<ul id="avatar-options" class="item-list option-list interactive"></ul>',
  '<ul id="avatar-options" class="item-list option-list interactive"></ul>\n            ' +
  '<p class="subtitle model-credit">body model: \u201csculpting a human body\u201d by Animation-class-k (CC BY 4.0)</p>');
await writeFile(path.join(dist, "index.html"), html);

const size = async (f) => ((await readFile(path.join(dist, f))).length / 1024).toFixed(0);
console.log(`activity/${path.basename(dist)} built: app.js ${await size("app.js")} KiB, discord-host.js ${await size("discord-host.js")} KiB`);
