/* CJS Loader */

import vm from 'vm';
import fs from 'fs';
import {readFile, stat} from 'fs/promises';
import path from 'path';
import Module from "module";
import babelParser from '@babel/parser';
import traverse from '@babel/traverse';
import babelGenerator from '@babel/generator';
import babelCore from '@babel/core';
import * as babelTypes from '@babel/types';

/* require is only to load internal modules */
const require = Module.createRequire(import.meta.url);

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
 * Whether a path refers to a Node.js module
 * @param {String} modulePath 
 */
function isNodeJSModule(modulePath) {
    let p = path.resolve(modulePath);
    if (fs.existsSync(path.join(p, 'package.json'))) {
        return true;
    }
    return false;
}

function getModuleType(modulePath) {
    if (!isNodeJSModule(modulePath)) {
        return null;
    }

    let content = fs.readFileSync(path.join(p, 'package.json'), { encoding: 'utf-8' });
    let packageJson = JSON.parse(content);
    if (packageJson.type === 'module') {
        return 'module';
    } else {
        return 'commonjs';
    }
}

/**
 * Transform `import.meta` structure in the source code into `__importmeta`
 * 
 */
function transformImportMeta(ast) {
    traverse.default(ast, {
        MetaProperty: {
            exit(path) {
                path.replaceWith(babelTypes.identifier('__importmeta'));
                path.skip();
            }
        },
        Import: {
            exit(path) {
                path.replaceWith(babelTypes.identifier('__import'));
                path.skip();
            }
        }
    });
    return ast;
}

/**
 * 
 * @param {String} subPathSpec `exports` spec of the subpath
 * @param {String} modulePath path of the Node.js module (containing a package.json file)
 * @returns null or the real subpath
 */
function getRealSubPath(subPathSpec, modulePath) {
    let realSubPath = null;
    if (Array.isArray(subPathSpec)) {
        for (let spec of subPathSpec) {
            if (typeof spec === 'object') {
                if (spec.require) {
                    if (typeof spec.require === 'string') {
                        realSubPath = spec.require;
                    }
                    else if (typeof spec.require === 'object' && typeof spec.require.default === 'string') {
                        realSubPath = spec.require.default;
                    }
                }
                else if (spec.default) {
                    if (typeof spec.default === 'string') {
                        realSubPath = spec.default;
                    }
                }
                else if (spec.import) {
                    if (typeof spec.import === 'string') {
                        realSubPath = spec.import;
                    }
                    else if (typeof spec.import === 'object' && typeof spec.import.default === 'string') {
                        realSubPath = spec.import.default;
                    }
                }

                if (fs.existsSync(path.join(modulePath, realSubPath.replace('/', path.sep)))) {
                    break;
                }
            }
            else if (typeof spec === 'string') {
                realSubPath = spec;
                if (fs.existsSync(path.join(modulePath, realSubPath.replace('/', path.sep)))) {
                    break;
                }
            }
        }
    }

    else if (typeof subPathSpec === 'string') {
        return subPathSpec;
    }

    else if (typeof subPathSpec === 'object') {
        if (typeof subPathSpec.require === 'string') {
            realSubPath = subPathSpec.require;
        }
        else if (typeof subPathSpec.default === 'string') {
            realSubPath = subPathSpec.default;
        }
        else if (typeof subPathSpec.import === 'string') {
            realSubPath = subPathSpec.import;
        }
    }
    return realSubPath;
}

/**
 * Load a Node.js library.
 * 
 * @param {String} modulePath Absolute or relative path, which is regarded as relative
 *  or absolute path in the filesystem. 
 * @param {String} subPath The subpath of the module
 * @param {Object} options Additional options
 */

export default function loadNodeJSModule(modulePath, options) {
    let moduleCache = {};
    let sourceFiles = new Set();
    /* `loadingModule` is used to resolve circular references */
    function _loadNodeJSModule(modulePath, loadingModules, subPath) {
        if (modulePath.endsWith('.json')) {
            try {
                let jsonContent = fs.readFileSync(modulePath, { encoding: 'utf-8' });
                return JSON.parse(jsonContent);
            } catch (e) {
                throw new Error(`Error in loading module ${modulePath}`);
            }
        }

        if (modulePath.endsWith('.js') || modulePath.endsWith('.cjs') || modulePath.endsWith('.mjs')) {
            if (loadingModules && loadingModules[path.resolve(modulePath)]) {
                return loadingModules[path.resolve(modulePath)].exports;
            }
            if (moduleCache[path.resolve(modulePath)]) {
                return moduleCache[path.resolve(modulePath)];
            }
            try {
                let rawCode = fs.readFileSync(modulePath, { encoding: 'utf-8' });
                if (modulePath.endsWith('.mjs') || modulePath.endsWith('.js')) {
                    rawCode = babelCore.transformSync(rawCode, {
                        plugins: ['@babel/plugin-transform-modules-commonjs'] // might be re-implemented later
                    }).code;
                }

                rawCode = babelGenerator.default(transformImportMeta(babelParser.parse(rawCode, { sourceType: 'module' }))).code;

                let instrumentedCode;
                if (options && options.instrumentFunc !== undefined) {
                    instrumentedCode = instrumentFunc(rawCode, path.resolve(modulePath));
                } else {
                    instrumentedCode = rawCode;
                }

                let ast = babelParser.parse(instrumentedCode, { sourceFilename: path.resolve(modulePath) });

                traverse.default(ast, {
                    Program: {
                        exit(path) {
                            let funcExpr = babelTypes.functionExpression(
                                null,
                                [
                                    babelTypes.identifier('module'),
                                    babelTypes.identifier('exports'),
                                    babelTypes.identifier('require'),
                                    babelTypes.identifier('__filename'),
                                    babelTypes.identifier('__dirname'),
                                    babelTypes.identifier('__import'),
                                    babelTypes.identifier('__importmeta')
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

                instrumentedCode = babelGenerator.default(ast).code;

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
            let packageJsonPath = path.resolve(path.join(modulePath, 'package.json'));
            let jsonContent = fs.readFileSync(packageJsonPath, { encoding: 'utf-8' });
            let packageJsonObject = JSON.parse(jsonContent);
            if (!fs.existsSync(packageJsonPath) || !fs.statSync(packageJsonPath).isFile()) {
                throw new Error(`Not a moudle: ${modulePath}`);
            }

            if (!subPath) {
                let entryFile = 'index.js';

                if (!packageJsonObject.exports || typeof packageJsonObject.exports === 'string') {
                    if (packageJsonObject.exports) {
                        entryFile = packageJsonObject.exports;
                    }
                    else if (packageJsonObject.main) {
                        entryFile = packageJsonObject.main;
                    }

                    if (!entryFile.endsWith('.js') && !entryFile.endsWith('.cjs') && !entryFile.endsWith('.mjs')) {
                        if (fs.existsSync(path.join(modulePath, entryFile + '.js'))) {
                            entryFile += '.js'
                        }
                        else if (fs.existsSync(path.join(modulePath, entryFile + '.cjs'))) {
                            entryFile += '.cjs'
                        }
                        else if (fs.existsSync(path.join(modulePath, entryFile + '.mjs'))) {
                            entryFile += '.mjs'
                        }
                    }
                    return _loadNodeJSModule(
                        path.resolve(path.join(modulePath, entryFile)),
                        loadingModules
                    );
                } else {
                    let entryFile = 'index.js';
                    if (packageJsonObject.exports['.']) {
                        if (typeof packageJsonObject.exports['.'] === 'string') {
                            entryFile = packageJsonObject.exports['.'].replace('/', path.sep);
                        } else if (typeof packageJsonObject.exports['.'] === 'object') {
                            if (packageJsonObject.exports['.'].require === 'string') {
                                entryFile = packageJsonObject.exports['.'].require;
                            }
                            else if (packageJsonObject.exports['.'].default === 'string') {
                                entryFile = packageJsonObject.exports['.'].default;
                            }
                            else if (packageJsonObject.exports['.'].import === 'string') {
                                entryFile = packageJsonObject.exports['.'].import;
                            }
                        }
                    }
                    return _loadNodeJSModule(
                        path.resolve(path.join(modulePath, entryFile)),
                        loadingModules
                    );
                }

            }
            else {
                if (!packageJsonObject.exports) {
                    let moduleFilePath = path.resolve(path.join(modulePath, subPath.replace('/', path.sep)));
                    if (!moduleFilePath.endsWith('.js') && !moduleFilePath.endsWith('.cjs')) {
                        if (fs.existsSync(path.join(moduleFilePath, 'index.js')) && fs.statSync(path.join(moduleFilePath, 'index.js')).isFile()) {
                            moduleFilePath = path.join(moduleFilePath, 'index.js');
                        }
                        else if (fs.existsSync(moduleFilePath + '.js')) {
                            moduleFilePath += '.js';
                        }
                        else if (fs.existsSync(moduleFilePath + '.cjs')) {
                            moduleFilePath += '.cjs';
                        }
                        else if (fs.existsSync(moduleFilePath + '.mjs')) {
                            moduleFilePath += '.mjs';
                        }
                    }
                    return _loadNodeJSModule(moduleFilePath, loadingModules);
                } else {
                    if (!subPath.startsWith('./')) {
                        subPath = './' + subPath;
                    }

                    let realSubPath = getRealSubPath(packageJsonObject.exports[subPath], modulePath);

                    if (!realSubPath) {
                        throw new Error(`Cannot import the module ${modulePath} with subpath ${subPath}`);
                    }
                    return _loadNodeJSModule(
                        path.resolve(path.join(modulePath, realSubPath.replace('/', path.sep))),
                        loadingModules
                    );
                }

            }

        }
        else {
            throw new Error(`Cannot find module: ${modulePath}`);
        }
    }

    async function _loadNodeJSModuleAsync(modulePath, loadingModules, subPath) {
        if (modulePath.endsWith('.json')) {
            try {
                let jsonContent = await readFile(modulePath, { encoding: 'utf-8' });
                return JSON.parse(jsonContent);
            } catch (e) {
                throw new Error(`Error in loading module ${modulePath}`);
            }
        }

        if (modulePath.endsWith('.js') || modulePath.endsWith('.cjs') || modulePath.endsWith('.mjs')) {
            if (loadingModules && loadingModules[path.resolve(modulePath)]) {
                return loadingModules[path.resolve(modulePath)].exports;
            }
            if (moduleCache[path.resolve(modulePath)]) {
                return moduleCache[path.resolve(modulePath)];
            }
            try {
                let rawCode = await readFile(modulePath, { encoding: 'utf-8' });
                if (modulePath.endsWith('.mjs') || modulePath.endsWith('.js')) {
                    rawCode = (await babelCore.transformAsync(rawCode, {
                        plugins: ['@babel/plugin-transform-modules-commonjs']
                    })).code;
                }

                rawCode = babelGenerator.default(transformImportMeta(babelParser.parse(rawCode, { sourceType: 'module' }))).code;

                let instrumentedCode;
                if (options && options.instrumentFunc !== undefined) {
                    instrumentedCode = instrumentFunc(rawCode, path.resolve(modulePath));
                } else {
                    instrumentedCode = rawCode;
                }

                let ast = babelParser.parse(instrumentedCode, { sourceFilename: path.resolve(modulePath), sourceType: 'module' });

                traverse.default(ast, {
                    Program: {
                        exit(path) {
                            let funcExpr = babelTypes.functionExpression(
                                null,
                                [
                                    babelTypes.identifier('module'),
                                    babelTypes.identifier('exports'),
                                    babelTypes.identifier('require'),
                                    babelTypes.identifier('__filename'),
                                    babelTypes.identifier('__dirname'),
                                    babelTypes.identifier('__import'),
                                    babelTypes.identifier('__importmeta')
                                ],
                                babelTypes.blockStatement(
                                    path.node.body,
                                    path.node.directives
                                ),
                                false,
                                true
                            );

                            path.node.body = [babelTypes.parenthesizedExpression(funcExpr)];
                            path.node.directives = [];
                            path.skip();
                        }
                    }
                });

                instrumentedCode = babelGenerator.default(ast).code;

                let compiledFunction = vm.runInThisContext(instrumentedCode, {
                    filename: path.resolve(modulePath)
                });

                let m = new MockedModule();
                if (loadingModules) {
                    loadingModules[path.resolve(modulePath)] = m;
                }

                await compiledFunction.call(
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
        else if (fs.existsSync(modulePath) && (await stat(modulePath)).isDirectory()) {
            let packageJsonPath = path.resolve(path.join(modulePath, 'package.json'));
            let jsonContent = fs.readFileSync(packageJsonPath, { encoding: 'utf-8' });
            let packageJsonObject = JSON.parse(jsonContent);
            if (!fs.existsSync(packageJsonPath) || ! (await stat(packageJsonPath)).isFile()) {
                throw new Error(`Not a moudle: ${modulePath}`);
            }

            if (!subPath) {
                let entryFile = 'index.js';

                if (!packageJsonObject.exports || typeof packageJsonObject.exports === 'string') {
                    if (packageJsonObject.exports) {
                        entryFile = packageJsonObject.exports;
                    }
                    else if (packageJsonObject.main) {
                        entryFile = packageJsonObject.main;
                    }

                    if (!entryFile.endsWith('.js') && !entryFile.endsWith('.cjs') && !entryFile.endsWith('.mjs')) {
                        if (fs.existsSync(path.join(modulePath, entryFile + '.js'))) {
                            entryFile += '.js'
                        }
                        else if (fs.existsSync(path.join(modulePath, entryFile + '.cjs'))) {
                            entryFile += '.cjs'
                        }
                        else if (fs.existsSync(path.join(modulePath, entryFile + '.mjs'))) {
                            entryFile += '.mjs'
                        }
                    }
                    return _loadNodeJSModuleAsync(
                        path.resolve(path.join(modulePath, entryFile)),
                        loadingModules
                    );
                } else {
                    let entryFile = 'index.js';
                    if (packageJsonObject.exports['.']) {
                        if (typeof packageJsonObject.exports['.'] === 'string') {
                            entryFile = packageJsonObject.exports['.'].replace('/', path.sep);
                        } else if (typeof packageJsonObject.exports['.'] === 'object') {
                            if (packageJsonObject.exports['.'].require === 'string') {
                                entryFile = packageJsonObject.exports['.'].require;
                            }
                            else if (packageJsonObject.exports['.'].default === 'string') {
                                entryFile = packageJsonObject.exports['.'].default;
                            }
                            else if (packageJsonObject.exports['.'].import === 'string') {
                                entryFile = packageJsonObject.exports['.'].import;
                            }
                        }
                    }
                    return _loadNodeJSModuleAsync(
                        path.resolve(path.join(modulePath, entryFile)),
                        loadingModules
                    );
                }

            }
            else {
                if (!packageJsonObject.exports) {
                    let moduleFilePath = path.resolve(path.join(modulePath, subPath.replace('/', path.sep)));
                    if (!moduleFilePath.endsWith('.js') && !moduleFilePath.endsWith('.cjs')) {
                        if (fs.existsSync(path.join(moduleFilePath, 'index.js')) && (await stat(path.join(moduleFilePath, 'index.js'))).isFile()) {
                            moduleFilePath = path.join(moduleFilePath, 'index.js');
                        }
                        else if (fs.existsSync(moduleFilePath + '.js')) {
                            moduleFilePath += '.js';
                        }
                        else if (fs.existsSync(moduleFilePath + '.cjs')) {
                            moduleFilePath += '.cjs';
                        }
                        else if (fs.existsSync(moduleFilePath + '.mjs')) {
                            moduleFilePath += '.mjs';
                        }
                    }
                    return _loadNodeJSModuleAsync(moduleFilePath, loadingModules);
                } else {
                    if (!subPath.startsWith('./')) {
                        subPath = './' + subPath;
                    }

                    let realSubPath = getRealSubPath(packageJsonObject.exports[subPath], modulePath);

                    if (!realSubPath) {
                        throw new Error(`Cannot import the module ${modulePath} with subpath ${subPath}`);
                    }
                    return _loadNodeJSModuleAsync(
                        path.resolve(path.join(modulePath, realSubPath.replace('/', path.sep))),
                        loadingModules
                    );
                }

            }

        }
        else {
            throw new Error(`Cannot find module: ${modulePath}`);
        }
    }


    function mockedRequire(currentModulePath, loadingModules, moduleName) {
        /* If the loaded module require a module named 'module', require the mocked Module directly */
        if (moduleName === 'node:module' || moduleName === 'module') {
            return MockedModule;
        }

        /* Directly load the internal modules */
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
                    loadingModules
                );
            }

            let targetModulePath = path.join(path.dirname(currentModulePath), moduleName + '.js');

            if (fs.existsSync(targetModulePath)) {
                return _loadNodeJSModule(targetModulePath, loadingModules);
            }

            targetModulePath = path.join(path.dirname(currentModulePath), moduleName + '.cjs');

            if (fs.existsSync(targetModulePath)) {
                return _loadNodeJSModule(targetModulePath, loadingModules);
            }

            targetModulePath = path.join(path.dirname(currentModulePath), moduleName);
            if (fs.existsSync(targetModulePath)) {
                return _loadNodeJSModule(targetModulePath, loadingModules);
            }

            throw new Error('Cannot find module.');
        }
        else {
            let moduleNameParts = moduleName.split('/');
            let d = path.resolve(path.dirname(currentModulePath));
            while (!fs.existsSync(path.join(d, 'node_modules', moduleNameParts[0]))) {
                if (d === path.join(d, '..')) {
                    break;
                }
                d = path.resolve(path.join(d, '..'));
            }

            let md = d;
            let idx = 0;
            let rest = null;
            while (idx < moduleNameParts.length) {
                if (fs.existsSync(path.join(md, moduleNameParts[idx])) &&
                    fs.statSync(path.join(md, moduleNameParts[idx])).isDirectory()) {
                    md += moduleNameParts[idx];
                }
                else if (fs.existsSync(path.join(md, moduleNameParts[idx] + '.js')) &&
                    fs.statSync(path.join(md, moduleNameParts[idx] + '.js')).isFile()) {
                    md += moduleNameParts[idx] + '.js';
                    if (idx !== moduleName.length - 1)
                        throw new Error(`Module not found: ${moduleName}`);
                    break;
                }
                else if (fs.existsSync(path.join(md, moduleNameParts[idx] + '.cjs')) &&
                    fs.statSync(path.join(md, moduleNameParts[idx] + '.cjs')).isFile()) {
                    md += moduleNameParts[idx] + '.cjs';
                    if (idx !== moduleName.length - 1)
                        throw new Error(`Module not found: ${moduleName}`);
                    break;
                }

                idx += 1;
                if (isNodeJSModule(md))
                    break;
            }

            if (idx < moduleNameParts.length) {
                rest = moduleNameParts.slice(idx).join('/');
            }

            if ((md.endsWith('.js') || md.endsWith('.cjs') || md.endsWith('.mjs')) && fs.statSync(md).isFile()) {
                return _loadNodeJSModule(md, loadingModules);
            } else {
                return _loadNodeJSModule(md, loadingModules, rest);
            }
        }
    }

    async function mockedImport(moduleName) {
        // TODO
        if (moduleName === 'node:module' || moduleName === 'module') {
            return MockedModule;
        }
        if (moduleName.startsWith('node:')) {
            return import(moduleName);
        }
        if (internalModules.indexOf(moduleName) >= 0) {
            return import(moduleName);
        }
    }
    if (!options.async) {
        return [_loadNodeJSModule(modulePath, {}, options.subPath), Array.from(sourceFiles)];
    } else {
        return _loadNodeJSModuleAsync(modulePath, {}, options.subPath).then(m => [m, Array.from(sourceFiles)]);
    }
    
}
