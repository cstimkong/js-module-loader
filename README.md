# JavaScript Module Loader

The project is for loading Node.js modules, isolated from the built-in module system.
It is suitable for testing the modules.

### How to use

* CommonJS

```javascript
var loader = require('js-module-loader');
loader.loadNodeJSModule('/path/to/a/module', '/optional/subpath', /* { some options } */);
```

* ESM

```javascript
import {loadNodeJSModule} from 'js-module-loader';
loadNodeJSModule('/path/to/a/module', '/optional/subpath', /* { some options } */);
```

For example, if you want to load `yargs` via subpath import using 

```javascript
const { hideBin } = require('yargs/helpers')
```

or 

```javascript
import { hideBin } from 'yargs/helpers'
```

, and the `yargs` module is put in the `/home/test/yargs`, you can use `loadNodeJSModule` as follows:

```javascript
loadNodeJSModule('/home/test/yargs', {subPath: 'helpers'});
```

### Supported Options

Supported options are listed as follows:

| Option name | Type  | Description |
| ----------- | ----- | ----------- |
| `instrumentFunc` | `Function` or `null` | function for instrumentation, accepting 2 arguments (code string and file name) |
| `async`    | boolean | whether to asynchronously load the module (corresponding to `import()` call) |
| `subPath`  | string  | the subpath of a module to load (e.g., `helpers` in `require('yargs/helpers')`) |
| `returnSourceFiles` | boolean | whether to return all included source files |