import { Rule, apply, url, move, chain, mergeWith, MergeStrategy, Tree, SchematicContext, externalSchematic } from '@angular-devkit/schematics';
import { updateProject, addDependencyToPackageJson, getAppEntryModule, 
    addImportStatement, getDistFolder, 
    getRelativePath, getNgToolkitInfo, 
    updateNgToolkitInfo, applyAndLog, 
    getMainFilePath,
    getBrowserDistFolder,
    addToNgModule,
    removeFromNgModule,
    getBootStrapComponent, addDependencyInjection,
    createOrOverwriteFile} from '@ng-toolkit/_utils';
import { getFileContent } from '@schematics/angular/utility/test';
import { NodePackageInstallTask } from '@angular-devkit/schematics/tasks';
import * as bugsnag from 'bugsnag';
import * as ts from 'typescript';

export default function index(options: any): Rule {
    bugsnag.register('0b326fddc255310e516875c9874fed91');
    bugsnag.onBeforeNotify((notification) => {
        let metaData = notification.events[0].metaData;
        metaData.subsystem = {
            package: 'universal',
            options: options
        };
    });

    const templateSource = apply(url('files'), [
        move(options.directory),
    ]);

    let rule: Rule = chain([
        tree => {
            const packageJsonSource = JSON.parse(getFileContent(tree, `${options.directory}/package.json`));
            if (packageJsonSource.dependencies['@ng-toolkit/serverless']) {
                tree.delete(`${options.directory}/local.js`);
                tree.delete(`${options.directory}/server.ts`);
                tree.delete(`${options.directory}/webpack.server.config.js`);
            } 
        },

        mergeWith(templateSource, MergeStrategy.Overwrite),
        (tree: Tree, context: SchematicContext) => {
            // update project name
            updateProject(tree, options);
            
            // add dependencies
            addDependencyToPackageJson(tree, options, '@angular/platform-browser', '^6.0.0');
            
            addDependencyToPackageJson(tree, options, '@angular/platform-server', '^6.0.0');
            addDependencyToPackageJson(tree, options, '@nguniversal/module-map-ngfactory-loader', '^6.0.0');
            addDependencyToPackageJson(tree, options, 'webpack-cli', '^2.1.4');
            addDependencyToPackageJson(tree, options, 'ts-loader', '4.2.0');
            addDependencyToPackageJson(tree, options, '@nguniversal/express-engine', '^6.0.0');
            addDependencyToPackageJson(tree, options, 'cors', '~2.8.4');

            // update CLI config
            const distFolder = getDistFolder(tree, options);
            const cliConfig: any = JSON.parse(getFileContent(tree, `${options.directory}/angular.json`));
            cliConfig.projects[options.project].architect.build.options.outputPath = `${distFolder}/browser`
            cliConfig.projects[options.project].architect.server =
            {
              "builder": "@angular-devkit/build-angular:server",
              "options": {
                "outputPath": `${distFolder}/server`,
                "main": `src/main.server.ts`,
                "tsConfig": "src/tsconfig.server.json"
              }
            };
            tree.overwrite(`${options.directory}/angular.json`, JSON.stringify(cliConfig, null, "  "));


            // manipulate entry modules
            // add proper module
            const entryModule = getAppEntryModule(tree, options);
            const serverModulePath = `${options.directory}/src/app/app.server.module.ts`;
            addImportStatement(tree, serverModulePath, entryModule.moduleName, getRelativePath(serverModulePath, entryModule.filePath));
            addToNgModule(tree, serverModulePath, 'imports', entryModule.moduleName);

            const browserModulePath = `${options.directory}/src/app/app.browser.module.ts`;
            
            // add bootstrap component
            const bootstrapComponents = getBootStrapComponent(tree, entryModule.filePath);
            bootstrapComponents.forEach(bootstrapComponent => {
                addImportStatement(tree, serverModulePath, bootstrapComponent.component, getRelativePath(serverModulePath, bootstrapComponent.filePath));
                addToNgModule(tree, serverModulePath, 'bootstrap', bootstrapComponent.component);
                addToNgModule(tree, serverModulePath, 'imports', `BrowserModule.withServerTransition({appId: '${bootstrapComponent.appId}'})`);
                            
                // manipulate browser module
                addImportStatement(tree, browserModulePath, entryModule.moduleName, getRelativePath(browserModulePath, entryModule.filePath));
                
                addToNgModule(tree, browserModulePath, 'imports', entryModule.moduleName);
                addToNgModule(tree, browserModulePath, 'imports', `BrowserModule.withServerTransition({appId: '${bootstrapComponent.appId}'})`);
                addToNgModule(tree, browserModulePath, 'bootstrap', bootstrapComponent.component);
                addImportStatement(tree, browserModulePath, bootstrapComponent.component, getRelativePath(browserModulePath, bootstrapComponent.filePath));
            });

            // manipulate old entry module
            
            addToNgModule(tree, entryModule.filePath, 'imports', 'CommonModule,\nNgtUniversalModule');
            removeFromNgModule(tree, entryModule.filePath, 'imports', 'BrowserModule')
            removeFromNgModule(tree, entryModule.filePath, 'bootstrap');

            addImportStatement(tree, entryModule.filePath, 'CommonModule', '@angular/common');
            addImportStatement(tree, entryModule.filePath, 'NgtUniversalModule', '@ng-toolkit/universal');
            
            // update main file
            const mainFilePath = getMainFilePath(tree, options);
            const entryFileSource: string = getFileContent(tree, `${options.directory}/${mainFilePath}`);

            tree.overwrite(`${options.directory}/${mainFilePath}`, entryFileSource.replace(new RegExp(`bootstrapModule\\(\\s*${entryModule.moduleName}\\s*\\)`), `bootstrapModule(AppBrowserModule)`));
            
            addImportStatement(tree, `${options.directory}/${mainFilePath}`, 'AppBrowserModule', getRelativePath(mainFilePath, browserModulePath));

            
            // upate server.ts and local.js and webpack config with proper dist folder
            tree.overwrite(`${options.directory}/server.ts`, getFileContent(tree, `${options.directory}/server.ts`).replace(/__distFolder__/g, distFolder).replace(/__browserDistFolder__/g, getBrowserDistFolder(tree, options)));
            tree.overwrite(`${options.directory}/local.js`, getFileContent(tree, `${options.directory}/local.js`).replace(/__distFolder__/g, distFolder));
            tree.overwrite(`${options.directory}/webpack.server.config.js`, getFileContent(tree, `${options.directory}/webpack.server.config.js`).replace(/__distFolder__/g, distFolder));

            
            //add scripts
            addOrReplaceScriptInPackageJson(tree, options, "build:server:prod", `ng run ${options.project}:server && webpack --config webpack.server.config.js --progress --colors`);
            addOrReplaceScriptInPackageJson(tree, options, "build:browser:prod", "ng build --prod");
            addOrReplaceScriptInPackageJson(tree, options, "build:prod", "npm run build:server:prod && npm run build:browser:prod");
            addOrReplaceScriptInPackageJson(tree, options, "server", "node local.js");

            // search for 'window' occurences and replace them with injected Window instance

            tree.getDir(cliConfig.projects[options.project].sourceRoot).visit(visitor => {
                if (visitor.endsWith('.ts')) {
                    let fileContent  = getFileContent(tree, visitor);
                    if (fileContent.match(/class.*{[\s\S]*?((?:[()'"`\s])localStorage)/)) {
                        addDependencyInjection(tree, visitor, 'localStorage', 'any', '@ng-toolkit/universal', 'LOCAL_STORAGE');
                        updateCode(tree, visitor, 'localStorage');
                        fileContent  = getFileContent(tree, visitor);
                    }
                    if (fileContent.match(/class.*{[\s\S]*?((?:[()'"`\s])window)/)) {
                        addDependencyInjection(tree, visitor, 'window', 'Window', '@ng-toolkit/universal', 'WINDOW');
                        updateCode(tree, visitor, 'window');
                    }
                    // if (fileContent.match(/class.*{[\s\S]*?((?:[()'"`\s])document)/)) {
                    //     addDependencyInjection(tree, visitor, 'document', 'Document', '@ng-toolkit/universal', 'NGT_DOCUMENT');
                    //     updateCode(tree, visitor, 'document');
                    // }
                }
            });

            // add installation task
            if (!options.skipInstall) {
                context.addTask(new NodePackageInstallTask(options.directory));
            }

            //applying other schematics (if installed)
            const ngToolkitSettings = getNgToolkitInfo(tree, options);
            ngToolkitSettings.universal = options;
            updateNgToolkitInfo(tree, options, ngToolkitSettings);
            let externals: Rule[] = [];
            if (ngToolkitSettings.serverless) {
                ngToolkitSettings.serverless.directory = options.directory;
                ngToolkitSettings.serverless.skipInstall = true;
                externals.push(externalSchematic('@ng-toolkit/serverless', 'ng-add', ngToolkitSettings.serverless));
            } else if(tree.exists(`${options.directory}/.firebaserc`)) {
                ngToolkitSettings.serverless = {};
                ngToolkitSettings.serverless.directory = options.directory;
                ngToolkitSettings.serverless.skipInstall = true;
                ngToolkitSettings.serverless.provider = 'firebase';
                addDependencyToPackageJson(tree, options, '@ng-toolkit/serverless', '1.1.28');
                externals.push(externalSchematic('@ng-toolkit/serverless', 'ng-add', ngToolkitSettings.serverless));
            }

            if (cliConfig.projects[options.project].architect.build.configurations.production.serviceWorker) {
                if (!ngToolkitSettings.pwa) {
                    ngToolkitSettings.pwa = {};
                }
                ngToolkitSettings.pwa.directory = options.directory;
                ngToolkitSettings.pwa.skipInstall = true;
                externals.push(externalSchematic('@ng-toolkit/pwa', 'ng-add', ngToolkitSettings.pwa));
            }

            if (externals.length > 0) {
                return chain(externals)(tree, context);
            }

        return tree;
        }
    ]);

    if (!options.disableBugsnag) {
        return applyAndLog(rule);
    } else {
        return rule;
    }
}

function addOrReplaceScriptInPackageJson(tree: Tree, options: any, name: string, script: string) {
    const packageJsonSource = JSON.parse(getFileContent(tree, `${options.directory}/package.json`));
    packageJsonSource.scripts[name] = script;
    tree.overwrite(`${options.directory}/package.json`, JSON.stringify(packageJsonSource, null, "  "));
}

function findStatements(tree: Tree, node: ts.Node, filePath: string, subject: string, replacement: string, toReplace: any[]){
    let fileContent = getFileContent(tree, filePath);
    node.forEachChild(node => {
        if (ts.isIdentifier(node)) {
            let statement = fileContent.substr(node.pos, node.end - node.pos);
            let index = statement.indexOf(subject);
            if (index >= 0) {
                toReplace.push({key: replacement, start: node.pos + index, end: node.end});
            }
        }
        else {
            findStatements(tree, node, filePath, subject, replacement, toReplace);
        }
    });
}

function updateCode(tree: Tree, filePath: string, varName: string) {
    let fileContent  = getFileContent(tree, filePath);
    let sourceFile: ts.SourceFile = ts.createSourceFile('temp.ts', fileContent, ts.ScriptTarget.Latest);

    sourceFile.forEachChild(node => {
        if (ts.isClassDeclaration(node)) {
            let replacementTable: any[] = [];
            node.members.forEach(node => {
                if (ts.isMethodDeclaration(node)) {
                    (node.body as ts.Block).statements.forEach(statement => {
                        findStatements(tree, statement, filePath, varName, `this.${varName}`, replacementTable);
                    })
                }
            });
            replacementTable.reverse().forEach(element => {
                fileContent = fileContent.substr(0, element.start) + element.key + fileContent.substr(element.end);
            });
            createOrOverwriteFile(tree, filePath, fileContent);
        }
    });
}
