
import { parse, ParseResult } from '@babel/parser';
import babelTraverse from '@babel/traverse';
import { builtinModules } from 'module';
import { join, sep, resolve, dirname, relative } from 'path';
import { existsSync, statSync, readFileSync } from 'fs';

// export function loadModuleAsync(modulePath: string, options?: {}): Promise<any> {

// }

function findExportKeyForSubpath(exportSpec: { [k: string]: { import?: string, default?: string, require?: string, node?: string } }, subpath: string, packagePath: string) {
    let s = `./${subpath}`;
    if (exportSpec.hasOwnProperty(s)) {
        return s;
    }
    throw new Error(`Cannot resolve the subpath ${subpath} for package.`);
}


function resolveDirectExport(relativeFilePath: string, packagePath: string) {
    if (!relativeFilePath.startsWith('./')) {
        throw new Error('Invalid entry path.');
    }
    let e = join(packagePath, relativeFilePath.replace('/', sep));
    if (!existsSync(e)) {
        throw new Error('Inexistent ESM package entry.');
    }
    return e;
}

function resolveMainExport(entryFile: string, packagePath: string) {
    if (!entryFile)
        entryFile = 'index.js';
    if (typeof entryFile !== 'string')
        throw new Error(`Invalid package entry: ${packagePath}`);
    let mainJSFile = join(packagePath, entryFile.replace('/', sep));
    if (!existsSync(mainJSFile)) {
        throw new Error('Inexistent package entry.');
    }
    return mainJSFile;
}

function resolveConditionalExport(exportSpec: { import?: string, default?: string, require?: string, node?: string }, packagePath: string) {
    let conditionalEntry;
    if (exportSpec.hasOwnProperty('import')) {
        conditionalEntry = exportSpec.import;
    } else if (exportSpec.hasOwnProperty('node')) {
        conditionalEntry = exportSpec.node;
    } else if (exportSpec.hasOwnProperty('default')) {
        conditionalEntry = exportSpec.default;
    } else {
        conditionalEntry = null;
    }
    if (!conditionalEntry || !conditionalEntry.startsWith('./')) {
        throw new Error('Invalid ESM package entry.');
    }
    let entryJSFile = join(packagePath, conditionalEntry);
    if (!existsSync(entryJSFile)) {
        throw new Error('Inexistent ESM package entry.');
    }
    return entryJSFile;
}

function locateNodeModulesDirectory(filePath: string): string | undefined {
    let currentDirectory = resolve(dirname(filePath));
    while (true) {
        let nodeModulesDir = join(currentDirectory, 'node_modules');
        if (existsSync(nodeModulesDir)) {
            return nodeModulesDir;
        }
        let parentDir = resolve(join(currentDirectory, '..'));
        if (parentDir === currentDirectory) {
            return undefined;
        }
        currentDirectory = parentDir;
    }
}

function resolveSubpath(subpath: string | undefined, packagePath: string) {
    let packageJsonPath = join(packagePath, 'package.json');
    let packageJsonContent = readFileSync(packageJsonPath, { encoding: 'utf-8' });
    try {
        let packageJson = JSON.parse(packageJsonContent);
        let packageType;
        if (!packageJson.type || packageJson.type === 'commonjs') {
            packageType = 'commonjs';
        } else if (packageJson.type === 'module' || packageJson.exports !== undefined) {
            packageType = 'esm';
        }
        else {
            throw new Error('Invalid package type in package.json.');
        }
        if (subpath === undefined) {
            if (!packageJson.exports && packageJson.main !== null && packageJson.main !== undefined) {
                return resolveMainExport(packageJson.main, packagePath);
            } else {
                if (typeof packageJson.exports === 'string') {
                    return resolveDirectExport(packageJson.exports, packagePath);
                }
                else if (typeof packageJson.exports === 'object' && packageJson.exports.hasOwnProperty('.')) {
                    let e = packageJson.exports['.'];
                    if (typeof e === 'string') {
                        return resolveDirectExport(e, packagePath);
                    }
                    else if (typeof e === 'object') {
                        return resolveConditionalExport(e as any, packagePath);
                    } else {
                        throw new Error('Invalid exports format');
                    }
                }
                else if (typeof packageJson.exports === 'object') {
                    return resolveConditionalExport(packageJson.exports as any, packagePath);
                } else {
                    throw new Error('Invalid exports format.');
                }
            }
        } else {
            let key = findExportKeyForSubpath(packageJson.exports as any, subpath, packagePath);
            if (typeof packageJson.exports[key] === 'string') {
                return resolveDirectExport(packageJson.exports[key], packagePath);
            }
            else if (typeof packageJson.exports[key] === 'object') {
                return resolveConditionalExport(packageJson.exports[key] as any, packagePath);
            } else {
                throw new Error('Invalid exports format.');
            }
        }
    } catch (err) {
        throw new Error('package.json format error.');
    }
}

function resolveModulePath(moduleSpecifier: string, filePath: string): string {
    if (moduleSpecifier.startsWith('node:')) {
        return moduleSpecifier;
    }
    else if (builtinModules.indexOf(moduleSpecifier) !== -1) {
        return 'node:' + moduleSpecifier;
    }
    else if (moduleSpecifier.startsWith('./') || moduleSpecifier.startsWith('../')) {
        if (moduleSpecifier.endsWith('.js') || moduleSpecifier.endsWith('.mjs') || moduleSpecifier.endsWith('.cjs')) {
            return join(resolve(dirname(filePath)), moduleSpecifier.replace('/', sep));
        }
        else {
            throw new Error(`Cannot locate the file path ${moduleSpecifier}`);
        }
    }
    else {
        let nodeModulesDir = locateNodeModulesDirectory(filePath);
        if (!nodeModulesDir) {
            throw new Error('No node_modules directory found.');
        }
        if (moduleSpecifier.startsWith('.') || moduleSpecifier.indexOf('%') >= 0 || moduleSpecifier.indexOf('\\') >= 0) {
            throw new Error(`Invalid package name: ${moduleSpecifier}`);
        }
        let packageName, subpath;
        if (moduleSpecifier.startsWith('@')) {
            let p = moduleSpecifier.indexOf('/');
            if (p === -1) {
                throw new Error(`Invalid package name: ${moduleSpecifier}`);
            }
            let q = moduleSpecifier.indexOf('/', p + 1);
            packageName = moduleSpecifier.substring(0, q === -1 ? moduleSpecifier.length : q);
            subpath = q === -1 ? undefined : moduleSpecifier.substring(q + 1);
        } else {
            let p = moduleSpecifier.indexOf('/');
            packageName = p === -1 ? moduleSpecifier : moduleSpecifier.substring(0, p);
            subpath = p === -1 ? undefined : moduleSpecifier.substring(p + 1);
        }
        let packagePath = join(nodeModulesDir, packageName);
        let packageJsonPath = join(packagePath, 'package.json');
        if (!existsSync(packageJsonPath) || !statSync(packageJsonPath).isFile()) {
            throw new Error(`Not a valid package: ${packageName} (without package.json)`);
        }
        return resolveSubpath(subpath, packagePath);
    }

}

function resolveImports(filePath: string) {
    let result: {[f: string]: {[v: string]: { source: string, type: 'default' | 'namespace' | 'named', imported?: string }}} = {};
    let visitedSourceFileSet = new Set();
    let sourceFileList = [resolve(filePath)];
    while (sourceFileList.length > 0) {
        let f = sourceFileList.shift();
        visitedSourceFileSet.add(f);
        if (!result[f!]) {
            result[f!] = {};
        }
        let ast = parseSourceFile(readFileSync(f!, { encoding: 'utf-8' }), { filename: f! });
        babelTraverse.default(ast.ast, {
            exit(path) {
                if (path.isImportDeclaration()) {
                    let source = path.node.source.value;
                    let sourcePath = resolveModulePath(source, filePath);
                    for (let x of path.node.specifiers) {
                        if (x.type === 'ImportDefaultSpecifier') {
                            result[f!]![x.local.name] = { source: sourcePath, type: 'default' };
                        }
                        else if (x.type === 'ImportNamespaceSpecifier') {
                            result[f!]![x.local.name] = { source: sourcePath, type: 'namespace' };
                        }
                        else {
                            result[f!]![x.local.name] = { source: sourcePath, type: 'named', imported: x.imported.type === 'Identifier' ? x.imported.name : x.imported.value };
                        }
                    }
                    if (!sourcePath.startsWith('node:') && !visitedSourceFileSet.has(sourcePath))
                        sourceFileList.push(sourcePath);
                }
            }

        });
    }

    return result;
}

function resolveExports(source: string) {

}

export function parseSourceFile(source: string, options: { filename: string }): { ast: ParseResult, type: 'esmodule' | 'commonjs' } {
    let ast: ParseResult;
    try {
        ast = parse(source, { sourceType: 'module', sourceFilename: options.filename });
        return { ast: ast, type: 'esmodule' };
    } catch (err) {
        try {
            ast = parse(source, { sourceType: 'commonjs', sourceFilename: options.filename });
            return { ast: ast, type: 'commonjs' };
        } catch (err) {
            throw new Error('Cannot parse the JavaScript source file: ' + options.filename);
        }

    }
}

let filename = './temp/mod1.js';

console.log(resolveImports(filename));