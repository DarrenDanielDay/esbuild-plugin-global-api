// @ts-check
import esbuild from "esbuild";
import { simplifyGlobalAPI } from "../index.js";
/** @type {esbuild.BuildOptions} */
const sharedConfig = {
  treeShaking: true,
  format: "iife",
  bundle: true,
  minify: true,
  outdir: "./tests",
};
await esbuild.build({
  ...sharedConfig,
  entryPoints: ["./tests/test-node.ts"],
  plugins: [simplifyGlobalAPI()],
});
await esbuild.build({
  ...sharedConfig,
  entryPoints: ["./tests/test-browser.ts"],
  platform: "browser",
  plugins: [
    simplifyGlobalAPI({
      bind: ["Object.keys"],
      pure: false,
      constructors: ["Object"],
    }),
  ],
});
