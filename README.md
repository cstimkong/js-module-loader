# JavaScript Module Loader

The project provide another runtime module loader isolated from the default module loaders (global `require`, `import()` mechanism), easy for instrumenting the code. It is suitable for testing the JavaScript modules in an isolated environment.

## How to Use

### General Usage Patterns

```javascript
function loadNodeJSModule(modulePath: string, async: false, options?: LoadOptions): any;
function loadNodeJSModule(modulePath: string, async: true, options?: LoadOptions): Promise<any>;
```

Parameters are explained as follows:

| Parameter | Explanation |
| --------- | ----------- |
| `modulePath` | Absolute (or relative path to the working directory) to a Node.js module | 
| `async` | Load the module asynchronously (corresponding to [import()](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Statements/import)) or synchronously (corresponding to `require` calls). |
| `options` | Additional options (detailed below) |

Supported options:

| Option name | Type  | Description |
| ----------- | ----- | ----------- |
| `instrumentFunc` | `Function` or `null` | function for instrumentation, accepting 2 arguments (code string and file name) |
| `subPath`  | string  | the subpath of a module to load (e.g., `helpers` in `require('yargs/helpers')`) |
| `globalThis` | object | the mocked globalThis for executing the initialization code in the loading process  |
| `returnSourceFiles` | boolean | whether to return all included source files |


### Example

Suppose that `yargs` module is installed at `/home/test/yargs`. Now you want to load `yargs` via [subpath](https://nodejs.org/api/packages.html#subpath-exports) import, you can use `loadNodeJSModule` as follows:

```javascript
const loadNodeJSModule = require('js-module-loader');
let mod = loadNodeJSModule('/home/test/yargs', {subPath: 'helpers'});
let hideBin = mod.hideBin;
```

This is equivalent to the code  `const { hideBin } = require('yargs/helpers')` (CommonJS) or `import { hideBin } from 'yargs/helpers'` (ESM).


## Contact

For any questions and suggestions, please contact me via [tim.kong@libc.io](mailto:tim.kong@libc.io).