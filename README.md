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
loadNodeJSModule('/home/test/yargs', 'helpers');
```