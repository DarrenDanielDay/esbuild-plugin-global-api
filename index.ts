import type { Loader, Plugin as ESBuildPlugin } from "esbuild";
import { readFile } from "fs/promises";
import { parse } from "path";

export type PluginOptions = {
  /**
   * The global constructor with static APIs you want to simplify, such as `Object`, `Array`, `URL`.
   *
   * @default false
   *
   * If set to `false`, all variables will be included.
   *
   * **BE CAREFUL**, this option can break your code in some cases.
   */
  constructors?: string[] | false;
  /**
   * Similar to {@link constructors}, but for variables of object type.
   *
   * @default ['console']
   */
  vars?: string[] | false;
  /**
   * Whether to apply `.bind(<variable>)` for `this` context.
   *
   * @default true
   *
   * Most global JavaScript APIs are not need to explicitly bind `this` context.
   *
   * If set to `true`, all functions will be appended with `.bind(<variable>)`.
   *
   * If set to a string array, such as `['Object.keys']`, only matched functions will be applied with `.bind(<variable>)`.
   */
  bind?: boolean | string[];
  /**
   * Whether to add "@__PURE__" comment in the build steps.
   * 
   * @default true
   */
  pure?: boolean
};

/**
 * This plugin may break your code since it has a tricky implementation.
 * Be careful to use this plugin!
 * @param options plugin options
 * @returns plugin instance
 */
export const simplifyGlobalAPI = (options?: PluginOptions): ESBuildPlugin => {
  const pluginName = "esbuild-plugin-global-api";
  const proxyModule = `@${pluginName}/do-not-use-in-your-code`;
  return {
    name: pluginName,
    setup(builder) {
      const { initialOptions } = builder;
      const { platform } = initialOptions;
      const defaultOptions: Required<PluginOptions> = {
        constructors: false,
        bind: true,
        vars: ["console"],
        pure: true,
      };
      const { constructors, vars, bind, pure } = Object.assign({}, defaultOptions, options);
      const constructorPattern = /^[A-Z]/;
      if (
        !Array.isArray(constructors) ||
        constructors.some((ctor) => typeof ctor !== "string" || !ctor.match(constructorPattern))
      ) {
        console.warn(`"constructors" should be an array of all strings starting with upper cases.`);
      }
      const globalContext = (() => {
        if ((platform ?? "node") === "browser") {
          const jsdom = require("jsdom");
          const { JSDOM } = jsdom;
          const dom = new JSDOM("");
          return dom.window;
        }
        return typeof globalThis !== "undefined"
          ? globalThis
          : typeof global !== "undefined"
          ? global
          : (0, eval)("this");
      })();
      type TargetVariables = {
        variable: string;
        value: any;
      };
      const enumerateNames = (object: any): string[] => {
        const result: string[] = [];
        if (!object) {
          return result;
        }
        const ownProperties = Object.getOwnPropertyDescriptors(object);
        const isFunction = typeof object === "function";
        const functionProps = new Set(["length", "name", "prototype"]);
        for (const key in ownProperties) {
          const descriptor = ownProperties[key];
          if (isFunction && functionProps.has(key)) continue;
          if (descriptor.get || descriptor.set) continue;
          result.push(key);
        }
        return result;
      };
      const exportVariables: TargetVariables[] =
        constructors && constructors.every((v) => typeof v === "string")
          ? constructors.map<TargetVariables>((v) => {
              return { variable: v, value: globalContext[v] };
            })
          : Object.entries(Object.getOwnPropertyDescriptors(globalContext)).reduce<TargetVariables[]>(
              (total, [variable, descriptor]) => {
                const globalVariableValue = descriptor.value;
                if (variable.match(constructorPattern) && typeof globalVariableValue === "function") {
                  total.push({
                    variable,
                    value: globalVariableValue,
                  });
                }
                return total;
              },
              []
            );
      if (Array.isArray(vars)) {
        for (const variable of vars) {
          if (!(variable in globalContext)) {
            console.warn(`Unknown variable: ${variable}`);
            continue;
          }
          exportVariables.push({
            value: globalContext[variable],
            variable,
          });
        }
      }
      const proxyScripts = exportVariables.reduce<Record<string, string>>((map, { variable, value }) => {
        const names = enumerateNames(value);
        if (!names.length) {
          console.info(`Skipped global variable without any enumerable property: ${variable}`);
          return map;
        }
        const content = names
          .map((name) => {
            const isFunc = typeof value[name] === "function";
            const memberExpression = `${variable}.${name}`;
            return `export const ${name} = ${pure ? "/* @__PURE__ */" : ""} ${memberExpression}${
              isFunc && (bind === true || (bind && bind.includes(memberExpression))) ? `.bind(${variable})` : ""
            }`;
          })
          .join(";");
        map[variable] = content;
        return map;
      }, {});
      const proxyImports = exportVariables
        .map((target) => `import * as ${target.variable} from '${proxyModule}${target.variable}'`)
        .join(";");
      const chars = [];
      for (let i = 0; i < proxyModule.length; i++) {
        chars.push(proxyModule[i]);
      }
      const pattern = new RegExp(`^${proxyModule}`);
      const anyPattern = /.*/;
      builder.onResolve({ filter: pattern }, async ({ path }) => {
        return {
          path,
          namespace: proxyModule,
        };
      });
      builder.onLoad({ filter: anyPattern }, async ({ path }) => {
        const { ext } = parse(path);
        if ([".js", ".ts", ".jsx", ".tsx"].includes(ext)) {
          const content = await readFile(path);
          // @ts-expect-error Dynamic Implementation
          const loader: Loader = ext.slice(1);
          return {
            contents: `${proxyImports};
${content}`,
            loader,
          };
        }
        // Refuse load files other than scripts.
        return undefined;
      });
      builder.onLoad({ filter: pattern, namespace: proxyModule }, async ({ path }) => {
        const variableName = path.replace(proxyModule, "");
        if (variableName in proxyScripts) {
          return {
            contents: proxyScripts[variableName],
            loader: "js",
          };
        }
        return undefined;
      });
    },
  };
};
