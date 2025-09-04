/* CJS Loader */
'use strict';

const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const babelParser = require('@babel/parser');
const babelTraverse = require('@babel/traverse').default;
const babelGenerator = require('@babel/generator').default;
const { instrumentCodeForForcedExecution, instrumentCodeWithTaints } = require('./instrumentation');

const internalModules = ['module', 'buffer', 'fs',
    'path', 'vm', 'process', 'child_process', 'net',
    'http', 'https', 'tls', 'events', 'crypto',
    'stream', 'os', 'url', 'dns', 'util', 'zlib',
    'assert', 'tty'
];

/**
 * Mocked `Module` object
 * @private
 */
function MockedModule(id, filename) {
    this.exports = {};
    this.id = id;
    this.filename = filename;
}


/**
 * Load an Node.js library.
 * 
 * @param {String} modulePath Absolute or relative path, which is regarded as relative
 *  or absolute path in the filesystem. 
 * @param {Object | undefined} taintInfo tainted information for instrumentation (optional)
 */

function loadNodeJSModule(modulePath, instrumentFunc, recordFunc) {
    let moduleCache = {};
    let sourceFiles = new Set();
    /* `loadingModule` is used to resolve circular references */
    function _loadNodeJSModule(modulePath, instrumented, loadingModules) {
        if (modulePath.endsWith('.json')) {
            try {
                let jsonContent = fs.readFileSync(modulePath, { encoding: 'utf-8' });
                return JSON.parse(jsonContent);
            } catch (e) {
                throw new Error(`Error in loading module ${modulePath}`);
            }
        }
        if (modulePath.endsWith('.js') || modulePath.endsWith('.cjs')) {
            if (loadingModules && loadingModules[path.resolve(modulePath)]) {
                return loadingModules[path.resolve(modulePath)].exports;
            }
            if (moduleCache[path.resolve(modulePath)]) {
                return moduleCache[path.resolve(modulePath)];
            }
            try {
                let rawCode = fs.readFileSync(modulePath, { encoding: 'utf-8' });
                let instrumentedCode;
                if (instrumentFunc !== undefined) {
                    instrumentedCode = instrumentFunc(rawCode, path.resolve(modulePath));
                } else {
                    instrumentedCode = rawCode;
                }

                let ast = babelParser.parse(instrumentedCode, { sourceFilename: path.resolve(modulePath) });

                babelTraverse(ast, {
                    Program: {
                        exit(path) {
                            let funcExpr = babelTypes.functionExpression(
                                null,
                                [
                                    babelTypes.identifier('module'),
                                    babelTypes.identifier('exports'),
                                    babelTypes.identifier('require'),
                                    babelTypes.identifier('__filename'),
                                    babelTypes.identifier('__dirname')
                                ],
                                babelTypes.blockStatement(
                                    path.node.body,
                                    path.node.directives
                                )
                            );

                            path.node.body = [babelTypes.parenthesizedExpression(funcExpr)];
                            path.node.directives = [];
                            path.skip();
                        }
                    }
                });

                instrumentedCode = babelGenerator(ast).code;

                let compiledFunction = vm.runInThisContext(instrumentedCode, {
                    filename: path.resolve(modulePath)
                });

                let m = new MockedModule();
                if (loadingModules) {
                    loadingModules[path.resolve(modulePath)] = m;
                }


                compiledFunction.call(
                    m.exports,
                    m,
                    m.exports,
                    mockedRequire.bind(undefined, path.resolve(modulePath), loadingModules),
                    path.resolve(modulePath), 
                    path.dirname(path.resolve(modulePath))
                );

                sourceFiles.add(path.resolve(modulePath));
                moduleCache[path.resolve(modulePath)] = m.exports;
                if (loadingModules) {
                    delete loadingModules[path.resolve(modulePath)];
                }
                return m.exports;

            } catch (e) {
                throw new Error(`Error occurs in loading module ${modulePath}: ${e.message}`);
            }
        }
        else if (fs.existsSync(modulePath) && fs.statSync(modulePath).isDirectory()) {

            let entryFile = 'index.js';
            let packageJsonPath = path.resolve(path.join(modulePath, 'package.json'));
            if (fs.existsSync(packageJsonPath) && fs.statSync(packageJsonPath).isFile()) {
                let jsonContent = fs.readFileSync(packageJsonPath, { encoding: 'utf-8' });
                let packageJsonObject = JSON.parse(jsonContent);
                if (packageJsonObject.main) {
                    entryFile = packageJsonObject.main;
                }
            }

            if (!entryFile.endsWith('.js') && !entryFile.endsWith('.cjs')) {
                if (fs.existsSync(path.join(modulePath, entryFile + '.js'))) {
                    entryFile += '.js'
                }
                else if (fs.existsSync(path.join(modulePath, entryFile + '.cjs'))) {
                    entryFile += '.cjs'
                }
            }
            return _loadNodeJSModule(
                path.resolve(path.join(modulePath, entryFile)),
                true,
                loadingModules
            );
        }
        else {
            throw new Error(`Cannot find module: ${modulePath}`);
        }

    }

    function mockedRequire(currentModulePath, loadingModules, moduleName) {
        if (internalModules.indexOf(moduleName) >= 0) {
            return require(moduleName);
        }
        if (moduleName.startsWith('node:')) {
            return require(moduleName);
        }
        if (moduleName.startsWith('./') || moduleName.startsWith('../')) {
            if (moduleName.endsWith('.js') || moduleName.endsWith('.cjs')) {
                return _loadNodeJSModule(
                    path.join(path.dirname(currentModulePath), moduleName),
                    true,
                    loadingModules
                );
            }

            let targetModulePath = path.join(path.dirname(currentModulePath), moduleName + '.js');

            if (fs.existsSync(targetModulePath)) {
                return _loadNodeJSModule(targetModulePath, true, loadingModules);
            }

            targetModulePath = path.join(path.dirname(currentModulePath), moduleName + '.cjs');

            if (fs.existsSync(targetModulePath)) {
                return _loadNodeJSModule(targetModulePath, true, loadingModules);
            }

            targetModulePath = path.join(path.dirname(currentModulePath), moduleName);
            if (fs.existsSync(targetModulePath)) {
                return _loadNodeJSModule(targetModulePath, true, loadingModules);
            }

            throw new Error('Cannot find module.');
        }
        else {
            let additionalPath = null;
            if (moduleName.indexOf('/') >= 0) {
                let idx = moduleName.indexOf('/');
                moduleName = moduleName.substring(0, idx);
                additionalPath = moduleName.substring(idx + 1);
            }
            let d = path.resolve(path.dirname(currentModulePath));
            while (!fs.existsSync(path.join(d, 'node_modules', moduleName))) {
                if (d === path.join(d, '..')) {
                    break;
                }
                d = path.join(d, '..');
            }

            if (additionalPath) {
                if (additionalPath.endsWith('.js') || additionalPath.endsWith('.cjs')) {
                    let modulePath = path.join(d, 'node_modules', moduleName, additionalPath);
                    return _loadNodeJSModule(modulePath, true, loadingModules);
                }

                let targetModulePath = path.join(d, 'node_modules', moduleName, additionalPath + '.js');

                if (fs.existsSync(targetModulePath)) {
                    return _loadNodeJSModule(targetModulePath, true, loadingModules);
                }

                targetModulePath = path.join(d, 'node_modules', moduleName, additionalPath + '.cjs');

                if (fs.existsSync(targetModulePath)) {
                    return _loadNodeJSModule(targetModulePath, true, loadingModules);
                }

                targetModulePath = path.join(d, 'node_modules', moduleName, additionalPath);
                if (fs.existsSync(targetModulePath)) {
                    return _loadNodeJSModule(targetModulePath, true, loadingModules);
                }

                throw new Error('Cannot find module.');

            }
            let modulePath = path.join(d, 'node_modules', moduleName);
            return _loadNodeJSModule(modulePath, true, loadingModules);
        }
    }

    return [_loadNodeJSModule(modulePath, true, {}), Array.from(sourceFiles)];

}


module.exports = loadNodeJSModule;
