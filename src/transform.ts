
/**
 * Transform a ESM source file into CommonJS-style file for require calls
 */
import babelParser, { parse, parseExpression } from '@babel/parser'
import babelTraverse, { NodePath, Node } from '@babel/traverse';
import babelTemplate from '@babel/template';
import { objectPattern, 
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
    exportDefaultSpecifier} from '@babel/types';
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

    return vars;
}

export default function transformESMSyntax(source: string) {
    let ast = babelParser.parse(source, {sourceType: 'module'});
    let exportedMap: NodeJS.Dict<any> = {};

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
            exit(path) {
                path.node.body = [expressionStatement(functionExpression(null, 
                    [
                        identifier('__exports'),
                        identifier('__import'),
                        identifier('__importmeta')
                    ],
                    blockStatement(path.node.body, path.node.directives)
                ))];
                path.skip();

            }
        },
        ExportNamedDeclaration: {
            enter(path) {
                let declaration = path.get('declaration').node;
                let specifiers = path.get('specifiers');
                if (declaration !== undefined && declaration !== null && declaration.type === 'FunctionDeclaration') {

                    path.replaceWith(declaration);
                    path.insertAfter(expressionStatement(
                        assignmentExpression('=',
                            memberExpression(
                                identifier('__exports'),
                                identifier(declaration.id!.name),
                            ),
                            identifier(declaration.id!.name)
                        )
                    ));

                    exportedMap[declaration.id!.name] = declaration.id!.name;
                    path.skip();
                }

                else if (declaration !== null && declaration !== undefined && declaration.type === 'VariableDeclaration') {
                    let exportStatements: Statement[] = [];
                    
                    for (let p of declaration.declarations) {
                        for (let exportedName of getDestructuredVariables(p.id)) {
                            exportStatements.push(expressionStatement(
                                assignmentExpression('=', 
                                    memberExpression(identifier('__exports'), identifier(exportedName)),
                                    identifier(exportedName)
                                )
                            ))
                            exportedMap[exportedName] = exportedName;
                        }
                        
                        path.replaceWith(declaration);
                        path.skip();
                        path.insertAfter(exportStatements);
                    }
                }

                else if (declaration === null && specifiers.length > 0) {
                    for (let s of specifiers) {
                        if (s.node.type === 'ExportSpecifier') {
                            if (s.node.exported.type === 'Identifier') {
                                exportedMap[s.node.exported.name] = s.node.local.name;
                            } else {
                                exportedMap[s.node.exported.value] = s.node.local.name;
                            }
                        }
                    }
                }
            }
        },
        ImportDeclaration: {
            exit(path) {
                let template = babelTemplate.default('const %%structure%% = await __import(%%importname%%)');

                let importMap: { [key: string]: string } = {};
                let defaultImportName: string | null = null;
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
                }
                
                let elements = [];
                if (Object.keys(importMap).length > 0) {
                    let properties: any[] = [];
                    for (let [k, v] of Object.entries(importMap)) {
                        properties.push(objectProperty(
                            stringLiteral(k),
                            identifier(v),
                            false,
                        ));
                    }

                    elements.push(objectPattern(properties));
                }
                else {
                    elements.push(null);
                }
                if (defaultImportName) {
                    elements.push(identifier(defaultImportName));
                }
                let objPattern = arrayPattern(elements);
                let transformed = template({
                    importname: path.get('source').node,
                    structure: objPattern
                });
                path.replaceWith(transformed as Statement);
                path.skip();
                
            }
        }
    })
    console.log(exportedMap);
    return babelGenerator.default(ast).code;
}
