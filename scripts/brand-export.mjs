import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Resvg } from "@resvg/resvg-js";
import Ajv from "ajv/dist/2020.js";
import { optimize } from "svgo";

const root = fileURLToPath(new URL("../", import.meta.url));
const check = process.argv.includes("--check");
const load = (path) => readFile(resolve(root, path), "utf8");
const tokens = JSON.parse(await load("brand/tokens.json"));
const schema = JSON.parse(await load("brand/tokens.schema.json"));
const validate = new Ajv({ allErrors: true }).compile(schema);
assert(validate(tokens), JSON.stringify(validate.errors, null, 2));

function luminance(hex) {
  const channels = hex.match(/[\da-f]{2}/gi).map((channel) => {
    const value = Number.parseInt(channel, 16) / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
}

let pairCount = 0;
for (const [theme, colors] of Object.entries(tokens.color)) {
  const pairs = [["accent-contrast", "accent", 4.5]];
  for (const background of ["background", "surface", "surface-raised"]) {
    for (const foreground of ["text", "text-muted", "accent", "success", "danger"]) {
      pairs.push([foreground, background, 4.5]);
    }
    for (const foreground of ["border", "focus-ring", "accent"]) {
      pairs.push([foreground, background, 3]);
    }
  }
  for (const [foreground, background, minimum] of pairs) {
    const a = luminance(colors[foreground]);
    const b = luminance(colors[background]);
    const ratio = (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
    assert(
      ratio >= minimum,
      `${theme} ${foreground}/${background}: ${ratio.toFixed(2)} < ${minimum}`,
    );
    pairCount++;
  }
}

const sourceSvgs = [
  "brand/mark.svg",
  "brand/mark-small.svg",
  "brand/wordmark.svg",
  "brand/lockup.svg",
  "brand/android/foreground.svg",
  "brand/android/background.svg",
  "brand/android/monochrome.svg",
];
const required = [
  "brand/DESIGN.md",
  ...sourceSvgs,
  ...["foreground", "background", "monochrome"].map(
    (layer) => `brand/android/ic_launcher_${layer}.xml`,
  ),
  "brand/android/ic_notification.xml",
  "apps/web/src/assets/fonts/chivo-600.woff2",
  "apps/web/src/assets/fonts/public-sans-400.woff2",
  "apps/web/src/assets/fonts/Chivo-OFL.txt",
  "apps/web/src/assets/fonts/PublicSans-OFL.txt",
];
for (const path of required) await access(resolve(root, path));

const outputs = new Map();
for (const path of sourceSvgs) {
  outputs.set(
    path,
    `${
      optimize(await load(path), {
        // Preserve accessible names and viewBoxes; never depend on installed fonts.
        plugins: [{ name: "preset-default", params: { overrides: { cleanupIds: false } } }],
      }).data
    }\n`,
  );
}
const inner = (svg) =>
  svg
    .replace(/^<svg[^>]*>/, "")
    .replace(/<\/svg>\s*$/, "")
    .replace(/<title[^>]*>[\s\S]*?<\/title>/g, "");
const mark = inner(outputs.get("brand/mark.svg"));
const small = inner(outputs.get("brand/mark-small.svg"));
const wordmark = inner(outputs.get("brand/wordmark.svg"));
const { accent, "accent-contrast": onAccent, background, text } = tokens.color.light;
const svg = (size, body) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}"><title>Pneumo</title>${body}</svg>`;
const png = (source, width) =>
  new Resvg(source, {
    fitTo: { mode: "width", value: width },
    font: { loadSystemFonts: false },
  })
    .render()
    .asPng();
const icon = (size, fraction, radius = 0) => {
  const inset = (size * (1 - fraction)) / 2;
  return svg(
    size,
    `<rect width="${size}" height="${size}" rx="${radius}" fill="${accent}"/><svg x="${inset}" y="${inset}" width="${size * fraction}" height="${size * fraction}" viewBox="0 0 64 64" fill="${onAccent}">${mark.replaceAll("currentColor", onAccent)}</svg>`,
  );
};
const favicon = svg(
  16,
  `<rect width="16" height="16" rx="2" fill="${accent}"/><g fill="${onAccent}">${small.replaceAll("currentColor", onAccent)}</g>`,
);

// ICO directory entries point to PNG payloads: no platform image tools or timestamps.
function ico(images) {
  const header = Buffer.alloc(6 + images.length * 16);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);
  let offset = header.length;
  images.forEach(({ size, bytes }, index) => {
    const entry = 6 + index * 16;
    header[entry] = size === 256 ? 0 : size;
    header[entry + 1] = size === 256 ? 0 : size;
    header.writeUInt16LE(1, entry + 4);
    header.writeUInt16LE(32, entry + 6);
    header.writeUInt32LE(bytes.length, entry + 8);
    header.writeUInt32LE(offset, entry + 12);
    offset += bytes.length;
  });
  return Buffer.concat([header, ...images.map(({ bytes }) => bytes)]);
}

const webIcons = new Map([
  ["icon-192.png", png(icon(192, 0.72), 192)],
  ["icon-512.png", png(icon(512, 0.72), 512)],
  ["icon-maskable-512.png", png(icon(512, 0.56), 512)],
  ["apple-touch-icon.png", png(icon(180, 0.72), 180)],
]);
const og = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630"><rect width="1200" height="630" fill="${background}"/><svg x="72" y="162" width="300" height="300" viewBox="0 0 64 64" fill="${accent}">${mark.replaceAll("currentColor", accent)}</svg><svg x="424" y="252" width="680" height="126.21" viewBox="0 0 3890 722" fill="${text}">${wordmark.replaceAll("currentColor", text)}</svg></svg>`;
webIcons.set("og-image.png", png(og, 1200));
for (const [filename, bytes] of webIcons) {
  outputs.set(`brand/${filename}`, bytes);
  outputs.set(`apps/web/public/icons/${filename}`, bytes);
}
const faviconIco = ico(
  [16, 32, 48].map((size) => ({ size, bytes: png(size < 48 ? favicon : icon(size, 0.84), size) })),
);
for (const base of ["brand", "apps/web/public"]) {
  outputs.set(`${base}/favicon.svg`, `${optimize(favicon).data}\n`);
  outputs.set(`${base}/favicon.ico`, faviconIco);
}

function themeCss(colors) {
  return Object.entries(colors).map(
    ([name, value]) => `  --color-${name}: ${value.toLowerCase()};`,
  );
}
const css = ["/* Generated by mise run brand:export; edit brand/tokens.json. */"];
for (const role of ["display", "ui"]) {
  const face = tokens.typography[role];
  css.push(
    `@font-face {\n  font-family: "${face.family}";\n  font-style: normal;\n  font-weight: ${face.weight};\n  font-display: swap;\n  src: url("../assets/fonts/${face.file}") format("woff2");\n}`,
    "",
  );
}
css.push(":root {", "  color-scheme: light;", ...themeCss(tokens.color.light));
for (const role of ["display", "ui"]) {
  const face = tokens.typography[role];
  css.push(
    `  --font-${role}: "${face.family}", ${face.fallback};`,
    `  --font-weight-${role}: ${face.weight};`,
  );
}
for (const [name, value] of Object.entries(tokens.typography.scale)) {
  css.push(
    `  --font-size-${name}: ${value.fontSize / 16}rem;`,
    `  --line-height-${name}: ${value.lineHeight / value.fontSize};`,
  );
}
for (const [group, prefix, unit] of [
  ["spacing", "space", "px"],
  ["radii", "radius", "px"],
  ["motion", "motion", "ms"],
]) {
  for (const [name, value] of Object.entries(tokens[group]))
    css.push(`  --${prefix}-${name}: ${value}${unit};`);
}
css.push(
  `  --shadow-raised: ${tokens.shadow.light};`,
  "}",
  "",
  "@media (prefers-color-scheme: dark) {",
  "  :root {",
  "    color-scheme: dark;",
  ...themeCss(tokens.color.dark).map((line) => `  ${line}`),
  `    --shadow-raised: ${tokens.shadow.dark};`,
  "  }",
  "}",
  "",
  "@media (prefers-reduced-motion: reduce) {",
  "  :root {",
);
for (const name of Object.keys(tokens.motion)) css.push(`    --motion-${name}: 0ms;`);
css.push("  }", "}", "");
outputs.set("apps/web/src/styles/tokens.css", css.join("\n"));

const pascal = (name) =>
  name
    .split("-")
    .map((part) => part[0].toUpperCase() + part.slice(1))
    .join("");
const kotlin = [
  "// Generated by mise run brand:export; edit brand/tokens.json.",
  "package dev.pneumo.app.ui.theme",
  "",
  "import androidx.compose.ui.graphics.Color",
  "",
  '@Suppress("MagicNumber")',
  "object BrandColors {",
];
for (const [theme, colors] of Object.entries(tokens.color)) {
  if (theme !== "light") kotlin.push("");
  kotlin.push(`    object ${pascal(theme)} {`);
  for (const [name, hex] of Object.entries(colors))
    kotlin.push(`        val ${pascal(name)} = Color(0xFF${hex.slice(1)})`);
  kotlin.push("    }");
}
kotlin.push("}", "");
outputs.set(
  "apps/android/app/src/main/java/dev/pneumo/app/ui/theme/BrandColors.kt",
  kotlin.join("\n"),
);

const res = "apps/android/app/src/main/res";
for (const layer of ["foreground", "background", "monochrome"]) {
  outputs.set(
    `${res}/drawable/ic_launcher_${layer}.xml`,
    await load(`brand/android/ic_launcher_${layer}.xml`),
  );
}
outputs.set(`${res}/drawable/ic_notification.xml`, await load("brand/android/ic_notification.xml"));
outputs.set(`${res}/raw/brand_keep.xml`, await load("brand/android/keep.xml"));
const adaptive = `<?xml version="1.0" encoding="utf-8"?>\n<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">\n    <background android:drawable="@drawable/ic_launcher_background" />\n    <foreground android:drawable="@drawable/ic_launcher_foreground" />\n    <monochrome android:drawable="@drawable/ic_launcher_monochrome" />\n</adaptive-icon>\n`;
for (const name of ["ic_launcher", "ic_launcher_round"])
  outputs.set(`${res}/mipmap-anydpi/${name}.xml`, adaptive);
for (const [density, size] of [
  ["mdpi", 48],
  ["hdpi", 72],
  ["xhdpi", 96],
  ["xxhdpi", 144],
  ["xxxhdpi", 192],
]) {
  for (const round of [false, true])
    outputs.set(
      `${res}/mipmap-${density}/ic_launcher${round ? "_round" : ""}.png`,
      png(icon(size, 0.72, round ? size / 2 : size * 0.22), size),
    );
}

for (const [path, content] of outputs) {
  await mkdir(dirname(resolve(root, path)), { recursive: true });
  await writeFile(resolve(root, path), content);
}
console.log(
  `brand:export: ${outputs.size} deterministic outputs; schema valid; ${pairCount} AA contrast pairs pass`,
);
if (check) {
  const paths = [...outputs.keys()];
  execFileSync("git", ["diff", "--exit-code", "--", ...paths], { cwd: root, stdio: "inherit" });
  const untracked = execFileSync(
    "git",
    ["ls-files", "--others", "--exclude-standard", "--", ...paths],
    { cwd: root, encoding: "utf8" },
  );
  assert.equal(untracked, "", `Untracked generated assets; add them to git:\n${untracked}`);
  console.log("check:brand: required files exist; generated files match git");
}
