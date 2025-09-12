
/**
 * Transform a ESM source file into CommonJS-style file for require calls
 */
import babelParser, { parse, parseExpression } from '@babel/parser'
import babelTraverse, { Node } from '@babel/traverse';
import babelTemplate from '@babel/template';
import {
    objectPattern,
    arrayPattern,
    identifier,
    Statement,
    objectProperty,
    stringLiteral,
    functionExpression,
    blockStatement,
    expressionStatement,
    assignmentExpression,
    memberExpression,
    variableDeclaration,
    variableDeclarator,
    awaitExpression,
    callExpression,
    ObjectProperty,
    objectExpression,
    numericLiteral,
    Identifier,
    Expression
} from '@babel/types';
import babelGenerator from '@babel/generator'

function getDestructuredVariables(node: Node): string[] {
    if (node.type === 'Identifier') {
        return [node.name];
    }

    if (node.type === 'AssignmentPattern') {
        return getDestructuredVariables(node.left);
    }

    if (node.type === 'ObjectProperty') {
        return getDestructuredVariables(node.value);
    }

    let vars: string[] = [];
    if (node.type === 'ArrayPattern') {
        for (let e of node.elements) {
            if (e !== null) {
                vars = vars.concat(getDestructuredVariables(e));
            }
        }
    }
    if (node.type === 'ObjectPattern') {
        for (let p of node.properties) {
            vars = vars.concat(getDestructuredVariables(p));
        }
    }
    // TODO: Support spread elements
    return vars;
}

export function transformESMForAsyncLoad(source: string) {
    let ast = babelParser.parse(source, { sourceType: 'module' });
    let exportedMap: NodeJS.Dict<any> = {};
    let importedModules: Set<string> = new Set();

    // Collect export and import items
    babelTraverse.default(ast, {
        Program: {
            enter(path) {
                let importStatements: Statement[] = [];
                let otherStatements: Statement[] = [];
                for (let statement of path.node.body) {
                    if (statement.type === 'ImportDeclaration') {
                        importStatements.push(statement);
                    } else {
                        otherStatements.push(statement);
                    }
                }
                path.node.body = importStatements.concat(otherStatements);
            },
        },
        ExportNamedDeclaration: {
            enter(path) {
                if (path.node.source !== null && path.node.source !== undefined) {
                    importedModules.add(path.node.source.value);
                }
                else {
                    let declaration = path.get('declaration').node;
                    let specifiers = path.get('specifiers');
                    if (declaration !== undefined && declaration !== null && (declaration.type === 'FunctionDeclaration' || declaration.type === 'ClassDeclaration')) {

                        path.replaceWith(declaration);

                        exportedMap[declaration.id!.name] = declaration.id!.name;
                        path.skip();
                    }

                    else if (declaration !== null && declaration !== undefined && declaration.type === 'VariableDeclaration') {

                        for (let p of declaration.declarations) {
                            for (let exportedName of getDestructuredVariables(p.id)) {
                                exportedMap[exportedName] = exportedName;
                            }

                            path.replaceWith(declaration);
                            path.skip();
                        }
                    }

                    else if (declaration === null && specifiers.length > 0) {
                        for (let s of specifiers) {
                            if (s.node.type === 'ExportSpecifier') {
                                if (s.node.exported.type === 'Identifier') {
                                    exportedMap[s.node.local.name] = s.node.exported.name;
                                } else {
                                    exportedMap[s.node.local.name] = s.node.exported.value;
                                }
                            }
                        }
                        path.remove();
                    }
                }
            }
        },
        ImportDeclaration: {
            enter(path) {
                importedModules.add(path.node.source.value);
            },
        }
    });

    // Modify the AST: import statements and exported identifiers in program
    babelTraverse.default(ast, {
        Program: {
            exit(p) {
                p.traverse({
                    AssignmentExpression: {
                        exit(path) {
                            if (path.get('left').isIdentifier()) {
                                let varName = (path.get('left').node as Identifier).name;

                                if (path.scope.getBinding(varName) && path.scope.getBinding(varName) === p.scope.getBinding(varName) && exportedMap[varName]) {
                                    path.replaceWith(assignmentExpression('=',
                                        memberExpression(
                                            memberExpression(identifier('__exports'), identifier('0'), true),
                                            identifier(exportedMap[varName]),
                                        ),
                                        assignmentExpression(path.node.operator, identifier(varName), path.node.right)

                                    ));
                                    path.skip();
                                }
                            }
                        }
                    },
                    VariableDeclaration: {
                        exit(path) {
                            let exportedVars: any[] = [];
                            for (let declarator of path.node.declarations) {
                                let vars = getDestructuredVariables(declarator.id);
                                if (path.scope === p.scope) {
                                    for (let v of vars) {
                                        if (exportedMap[v]) {
                                            exportedVars.push([v, exportedMap[v]]);
                                        }
                                    }
                                }
                            }
                            if (exportedVars.length === 0) {
                                return;
                            }
                            let statements: Statement[] = [];
                            for (let [localName, exportedName] of exportedVars) {
                                statements.push(expressionStatement(
                                    assignmentExpression('=',
                                        memberExpression(
                                            memberExpression(identifier('__exports'), identifier('0'), true),
                                            stringLiteral(exportedName),
                                            true
                                        ),
                                        identifier(localName)
                                    )
                                ))
                            }
                            path.insertAfter(statements);

                        }
                    },
                    FunctionDeclaration: {
                        exit(path) {
                            if (path.scope.parent === p.scope && path.node.id && exportedMap[path.node.id.name]) {
                                path.insertAfter(expressionStatement(
                                    assignmentExpression('=',
                                        memberExpression(
                                            memberExpression(identifier('__exports'), identifier('0'), true),
                                            stringLiteral(exportedMap[path.node.id.name]),
                                            true
                                        ),
                                        identifier(path.node.id.name)
                                    )
                                ));
                            }
                        }
                    }

                })
                let properties: ObjectProperty[] = [];

                for (let m of importedModules) {
                    properties.push(
                        objectProperty(
                            stringLiteral(m),
                            awaitExpression(
                                callExpression(identifier('__import'), [stringLiteral(m)])
                            )
                        )
                    )
                }
                let importDecl: Statement = variableDeclaration('const',
                    [
                        variableDeclarator(identifier('__imports'), objectExpression(properties))
                    ]
                )
                objectExpression(properties);
                p.node.body = [expressionStatement(functionExpression(null,
                    [
                        identifier('__exports'),
                        identifier('__import'),
                        identifier('__importmeta')
                    ],
                    blockStatement(([importDecl] as Statement[]).concat(p.node.body), p.node.directives),
                    false, true
                ))];
                p.skip();

            }
        },
        ImportDeclaration: {
            exit(path) {
                let importMap: { [key: string]: string } = {};
                let defaultImportName: string | null = null;
                let namespace: string | null = null;
                for (let spec of path.node.specifiers) {
                    if (spec.type === 'ImportSpecifier' && spec.imported.type === 'Identifier') {
                        importMap[spec.imported.name] = spec.local.name;
                    }
                    else if (spec.type === 'ImportSpecifier' && spec.imported.type === 'StringLiteral') {
                        importMap[spec.imported.value] = spec.local.name;
                    }
                    else if (spec.type === 'ImportDefaultSpecifier') {
                        defaultImportName = spec.local.name;
                    }
                    else if (spec.type === 'ImportNamespaceSpecifier') {
                        namespace = spec.local.name;
                    }
                }

                let statements: Statement[] = [];

                for (let [k, v] of Object.entries(importMap)) {
                    statements.push(variableDeclaration('const', [
                        variableDeclarator(identifier(v), memberExpression(
                            memberExpression(
                                memberExpression(identifier('__imports'), stringLiteral(path.node.source.value), true),
                                identifier("0"), true
                            ), stringLiteral(k), true
                        ))
                    ]))
                }

                if (defaultImportName) {
                    statements.push(variableDeclaration('const', [
                        variableDeclarator(identifier(defaultImportName), memberExpression(memberExpression(identifier('__imports'), stringLiteral(path.node.source.value), true), identifier("1"), true))
                    ]))
                }

                if (namespace) {
                    statements.push(variableDeclaration('const', [
                        variableDeclarator(identifier(namespace), memberExpression(memberExpression(identifier('__imports'), stringLiteral(path.node.source.value), true), identifier("0"), true))
                    ]))
                }

                path.insertAfter(statements);
                path.remove();
            }
        },
    });

    // Modify the AST: special export statements, 
    babelTraverse.default(ast, {
        ExportDefaultDeclaration: {
            exit(path) {
                path.replaceWith(
                    expressionStatement(
                        assignmentExpression('=',
                            memberExpression(
                                identifier('__exports'),
                                identifier('1'),
                                true
                            ),
                            path.node.declaration as Expression
                        )
                    )
                );
                path.skip();
            }
        },
        ExportNamedDeclaration: {
            exit(path) { // the declaration will only be `export {...} from "..."`
                if (path.node.source !== null && path.node.source !== undefined) {
                    let statements: Statement[] = [];
                    for (let spec of path.node.specifiers) {
                        if (spec.type === 'ExportSpecifier') {
                            statements.push(expressionStatement(
                                assignmentExpression('=',
                                    memberExpression(
                                        memberExpression(identifier('__exports'), identifier('0'), true),
                                        stringLiteral(spec.exported.type === 'Identifier' ? spec.exported.name : spec.exported.value),
                                        true
                                    ),
                                    memberExpression(
                                        memberExpression(
                                            memberExpression(identifier('__imports'), stringLiteral(path.node.source.value), true),
                                            identifier('0'), true
                                        ), stringLiteral(spec.local.name), true
                                    )
                                )
                            ))
                        }
                        else if (spec.type === 'ExportNamespaceSpecifier') {
                            statements.push(expressionStatement(
                                assignmentExpression('=',
                                    memberExpression(
                                        memberExpression(identifier('__exports'), identifier('0'), true),
                                        stringLiteral(spec.exported.name),
                                        true
                                    ),
                                    memberExpression(
                                        memberExpression(identifier('__imports'), stringLiteral(path.node.source.value), true),
                                        identifier('0'), true
                                    )
                                )
                            ))
                        }
                    }
                    path.insertAfter(statements);
                    path.remove();
                }
            }
        },
        ExportAllDeclaration: {
            exit(path) {
                let n = babelTemplate.default('for (let _m of Object.getOwnPropertyNames(__imports[%%source%%][0])) { __exports[0][_m] = __imports[%%source%%][0][_m]}')(
                    {
                        source: stringLiteral(path.node.source.value)
                    }
                ) as Statement;
                path.replaceWith(n);
                path.skip();
            }
        }
    })
    return babelGenerator.default(ast).code;
}
