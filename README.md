# esbuild-plugin-global-api

> This plugin is still experimental, not recommended for production. It may break your code in some cases.

An esbuild plugin for simplifying global API calls.

## Basics

You may have hundreds of thousands of JavaScript global API calls in project, such as `Object.keys`, `Array.isArray`, `console.log` etc.

The main idea of this plugin is to simplify them with such converts:

```js
// Before
console.log(Object.keys({}));
console.log(Object.keys({}));
console.log(Array.isArray([]));
```

```js
// After simplify
var i = Array.isArray; // Or, if you are worried about `this` context, it can be `Array.isArray.bind(Array)`
var l = console.log;
var k = Object.keys;
l(k({}));
l(k({}));
l(i([]));
```

The more calls of global API occur, the more useful conversion of this plugin will be.

## License

```text
 __________________
< The MIT license! >
 ------------------
        \   ^__^
         \  (oo)\_______
            (__)\       )\/\
                ||----w |
                ||     ||
```