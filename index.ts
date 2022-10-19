import type { Loader, Plugin as ESBuildPlugin } from "esbuild";
import { readFile } from "fs/promises";
import { parse } from "path";
import {
  GlobalConstructorsWithStatic,
  globalConstructorWithStatics,
  globalVars,
  GlobalVars,
  isGlobalCtor,
  isGlobalVar,
  NormalNode,
  ProxyHandleRule,
} from "./global-definitions";
const die = (msg?: string): never => {
  throw new Error(msg);
};
type ProxyNamespaceRuleConfig = {
  code?: string;
  rule: ProxyHandleRule;
  /**
   * @default "(path) => !path.includes('node_modules')"
   */
  applyTo?: (path: string) => boolean;
};
type ProxyNamespaceRule = Required<ProxyNamespaceRuleConfig>;

export const defaultApplyTo: NonNullable<ProxyNamespaceRuleConfig["applyTo"]> = (path: string) =>
  !path.includes("node_modules");

const defaultProxyNamespaceRule = (name: string): ProxyNamespaceRule => ({
  code: "",
  applyTo: defaultApplyTo,
  rule: isGlobalCtor(name)
    ? globalConstructorWithStatics[name]
    : isGlobalVar(name)
    ? globalVars[name]
    : die(`Unknown global name ${name}`),
});
const patchProxyNamespaceRuleConfig = (config: ProxyNamespaceRuleConfig): ProxyNamespaceRule => ({
  applyTo: config.applyTo ?? defaultApplyTo,
  code: config.code ?? "",
  rule: config.rule,
});
type ApplyMappingConfig<S extends string> = {
  [K in S]: ProxyNamespaceRuleConfig;
};

type ApplyMapping = Record<string, ProxyNamespaceRule>;

type ApplyRulesConfig<S extends string> = S[] | ApplyMappingConfig<S>;

export type PluginOptions = {
  /**
   * The global constructor with static APIs you want to simplify, such as `Object`, `Array`, `URL`.
   *
   * @default ["Object"]
   *
   * **BE CAREFUL**, this option can break your code in some cases.
   */
  constructors?: ApplyRulesConfig<GlobalConstructorsWithStatic>;
  /**
   * Similar to {@link constructors}, but for variables of object type.
   *
   * @default ['console']
   */
  vars?: ApplyRulesConfig<GlobalVars>;
  /**
   * @example
   *
   * {"React": { code: "import * as React from 'react';", members: { createElement: 'func-bind' } } }
   *
   */
  lib?: {
    [namespace: string]: ProxyNamespaceRule;
  };
};
export const defaultOptions: Required<PluginOptions> = {
  constructors: ["Object"],
  vars: ["console", "JSON", "Math", "Reflect"],
  lib: {},
};
const pureComment = `/* @__PURE__ */`;

/**
 * This plugin may break your code since it has a tricky implementation.
 * Be careful to use this plugin!
 * @param options plugin options
 * @returns plugin instance
 */
export const simplifyGlobalAPI = (options?: PluginOptions): ESBuildPlugin => {
  const pluginName = "esbuild-plugin-global-api";
  const proxyModule = `@${pluginName}/do-not-use-in-your-code`;
  const createProxyUrl = (namespace: string) => `${proxyModule}-${namespace}`;
  return {
    name: pluginName,
    setup(builder) {
      const {
        initialOptions: { platform: _platform },
      } = builder;
      const platform = !_platform || _platform === "neutral" ? "node" : _platform;
      const { constructors: _constructors, vars: _vars, lib: _lib } = Object.assign({}, defaultOptions, options);
      const constructors = Array.isArray(_constructors)
        ? _constructors.reduce<ApplyMapping>((acc, ctor) => {
            const applyRule = defaultProxyNamespaceRule(ctor);
            if (!applyRule) {
              console.warn(`Unknown global constructor "${ctor}", ignored.`);
              return acc;
            }
            acc[ctor] = applyRule;
            return acc;
          }, {})
        : Object.entries(_constructors).reduce<ApplyMapping>((acc, [ctor, config]) => {
            acc[ctor] = patchProxyNamespaceRuleConfig(config);
            return acc;
          }, {});
      const vars = Array.isArray(_vars)
        ? _vars.reduce<ApplyMapping>((acc, variable) => {
            const applyRule = defaultProxyNamespaceRule(variable);
            if (!applyRule) {
              console.warn(`Unknown global variable "${variable}", ignored.`);
              return acc;
            }
            acc[variable] = applyRule;
            return acc;
          }, {})
        : Object.entries(_vars).reduce<ApplyMapping>((acc, [variable, config]) => {
            acc[variable] = patchProxyNamespaceRuleConfig(config);
            return acc;
          }, {});
      // Constructors and vars/functions are configured separately for further `new XXX()` transform rules (currently not implemented).
      const lib = _lib ?? {};
      const mergedNamespaces = Object.assign({}, constructors, vars, lib);
      const namespaceEntries = Object.entries(mergedNamespaces);
      const proxyMapping = namespaceEntries.reduce<
        Record<
          string,
          {
            url: string;
            proxyNamespaceExportsScript: string;
            proxyNamespaceImportsScript: string;
          }
        >
      >((map, [namespace, { rule, code }]) => {
        const url = createProxyUrl(namespace);
        const varOnly = () => {
          map[namespace] = {
            url,
            proxyNamespaceImportsScript: `import {${namespace}}from '${url}';`,
            proxyNamespaceExportsScript: `${code}export const ${namespace}=${namespace};`,
          };
          return map;
        };
        const basic = (node: NormalNode<any>) => {
          switch (node.type) {
            case "constructor":
            case "object":
              const keys = Object.keys(node.members);
              const evalScripts = keys
                .map((member) => {
                  switch (node.members[member]!) {
                    case "constant":
                    case "func":
                      return `const ${member}=${pureComment}${namespace}.${member};`;
                    case "func-bind":
                      return `const ${member}=${pureComment}${namespace}.${member}.bind(${namespace});`;
                    default:
                      // Ignore the property. Property read should be skipped in `applyTo`.
                      return ``;
                  }
                })
                .join("");

              map[namespace] = {
                url,
                proxyNamespaceImportsScript: `import * as ${namespace} from "${url}";`,
                proxyNamespaceExportsScript: `${code}${evalScripts}export {${keys.join(",")}};`,
              };
              break;
            case "func":
              return varOnly();
            default:
              break;
          }
          return map;
        };
        if (rule === "noop" || rule.type === "func") {
          return varOnly();
        }
        if (rule.type === "platform") {
          const detail = rule.diffs[platform];
          if (detail === "noop") {
            return varOnly();
          } else {
            return basic(detail);
          }
        }
        return basic(rule);
      }, {});
      const chars: string[] = [];
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
      builder.onLoad({ filter: anyPattern, namespace: "file" }, async ({ path }) => {
        const matchedNamespaceEntries = namespaceEntries.filter(([, { applyTo }]) => applyTo(path));
        if (!matchedNamespaceEntries.length) {
          return;
        }
        const { ext } = parse(path);
        if ([".js", ".ts", ".jsx", ".tsx", ".cjs", ".cts", ".mjs", ".mts"].includes(ext)) {
          const content = await readFile(path);
          const isTypeScript = ext.includes("t");
          const isReact = ext.includes("x");
          const loader: Loader = isTypeScript ? (isReact ? "tsx" : "ts") : isReact ? "jsx" : "js";
          return {
            contents: `${matchedNamespaceEntries
              .map(([namespace]) => proxyMapping[namespace].proxyNamespaceImportsScript)
              .join("")}
${content}`,
            loader,
          };
        }
        // Refuse load files other than scripts.
        return undefined;
      });
      builder.onLoad({ filter: pattern, namespace: proxyModule }, async ({ path }) => {
        const variableName = path.replace(`${proxyModule}-`, "");
        if (variableName in proxyMapping) {
          return {
            contents: proxyMapping[variableName].proxyNamespaceExportsScript,
            loader: "js",
          };
        }
        return die(`Unexpected matched path: "${path}"`);
      });
    },
  };
};
