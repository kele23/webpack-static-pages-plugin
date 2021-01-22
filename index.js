const { validate } = require('schema-utils');
const pLimit = require('p-limit');
const schema = require('./options.json');
const glob = require('glob');
const Handlebars = require('handlebars');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { sources, Compilation } = require('webpack');
const Module = require('module');

class StaticPagesPlugin {
    constructor(options = {}) {
        validate(schema, options, {
            name: 'Static Pages Plugin',
            baseDataPath: 'options',
        });

        this.componentsDir = options.componentsDir;
        this.pagesDir = options.pagesDir;
        this.destDir = options.destDir;
        this.options = options.options || {};
    }

    apply(compiler) {
        const pluginName = this.constructor.name;
        const limit = pLimit(this.options.concurrency || 100);

        compiler.hooks.thisCompilation.tap(pluginName, (compilation) => {
            const logger = compilation.getLogger('static-pages-plugin');
            const cache = compilation.getCache('StaticPagesPlugin');

            compilation.hooks.processAssets.tapAsync(
                {
                    name: 'static-pages-plugin',
                    stage: compiler.webpack.Compilation.PROCESS_ASSETS_STAGE_ADDITIONS,
                },
                async (unusedAssets, callback) => {
                    logger.log('Starting creating static pages....');

                    //read components
                    glob.sync('**/*.hbs', { cwd: this.componentsDir }).map((file) => {
                        const content = fs.readFileSync(path.resolve(this.componentsDir, file), 'utf8');
                        if (!content) return null;

                        const match = file.match(/^[^/]+/);
                        Handlebars.registerPartial(match[0], content);
                        logger.log(`Loaded component: ${match[0]}`);
                    });

                    //read pages
                    const pages = glob.sync('**/*.js', { cwd: this.pagesDir }).map((file) => {
                        if (file.startsWith('_')) return;
                        try {
                            const fileAbs = path.resolve(this.pagesDir, file);
                            const fn = this.evaluateCompilationResult(fileAbs);
                            const match = file.match(/^[^.]+/);
                            return {
                                name: match[0],
                                fn: fn,
                            };
                        } catch (e) {
                            logger.error(e);
                        }
                        return null;
                    });

                    //create page HTML
                    const pagesRend = pages.map((page) => {
                        if (page == null) return;
                        const pageData = page.fn();
                        const build = Handlebars.compile(`{{> ${pageData.component}}}`);
                        return {
                            filename: page.name + '.html',
                            absoluteFilename: path.resolve(this.destDir, page.name) + '.html',
                            html: build(pageData),
                        };
                    });

                    //write down html
                    pagesRend.forEach((page) => {
                        if (page == null) return;
                        const existingAsset = compilation.getAsset(page.filename);
                        if (existingAsset) return;

                        const info = { created: true };
                        compilation.emitAsset(page.filename, new sources.RawSource(page.html, true), {
                            ...info,
                        });
                    });

                    logger.log('Finished creating pages');

                    callback();
                }
            );

            if (compilation.hooks.statsPrinter) {
                compilation.hooks.statsPrinter.tap(pluginName, (stats) => {
                    stats.hooks.print
                        .for('asset.info.created')
                        .tap('static-pages-plugin', (created, { green, formatFlag }) =>
                            // eslint-disable-next-line no-undefined
                            created ? green(formatFlag('created')) : undefined
                        );
                });
            }

            compiler.hooks.afterCompile.tap('after-compile', (compilation) => {
                glob.sync('**/*.js', { cwd: this.pagesDir }).map((file) => {
                    compilation.fileDependencies.add(path.resolve(this.pagesDir, file));
                });
                glob.sync('**/*.hbs', { cwd: this.componentsDir }).map((file) => {
                    compilation.fileDependencies.add(path.resolve(this.componentsDir, file));
                });
            });
        });
    }

    /**
     * Evaluates the child compilation result
     * @param {string} file
     * @returns {() => Object}
     */
    evaluateCompilationResult(file) {
        if (!file) {
            throw new Error('The file is empty');
        }

        const source = fs.readFileSync(file, { encoding: 'utf-8' });
        const mod = new Module(file);
        const dirname = path.dirname(file);

        const vmContext = vm.createContext(
            {
                SPP: true,
                module: mod,
                exports,
                require: function (path) {
                    // convert relative paths to absolute
                    if (path.match(/^\.\.?\//)) {
                        return mod.require(dirname + '/' + path);
                    } else {
                        return mod.require(path);
                    }
                },
                __filename: file,
                __dirname: dirname,
            },
            global
        );

        const vmScript = new vm.Script(source, { filename: file });
        let newSource = vmScript.runInContext(vmContext);
        if (typeof newSource === 'object' && newSource.__esModule && newSource.default) {
            newSource = newSource.default;
        }
        if (typeof newSource === 'function') return newSource;
        throw new Error('Source not produce an HTML');
    }
}

module.exports = StaticPagesPlugin;
