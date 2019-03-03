const configFactory = require('./webpack.config.js');
const paths = require('./paths');
const path = require('path');
const HtmlWebpackPlugin = require('html-webpack-plugin');
const fs = require('fs');
const MemoryFS = require('memory-fs');
const webpack = require('webpack');
const MiniCssExtractPlugin = require('mini-css-extract-plugin');
const vm = require('vm');

module.exports = function (webpackEnv) {

    console.log('Creating preload server for ' + webpackEnv);
    createPreloadServer(webpackEnv);

    const config = configFactory(webpackEnv);

    // Save assets to disk
    config.plugins.push(
        new SaveAssetsToDisk({
            pathRoot: path.dirname(paths.appBuild),
            name: 'assets.json'
        })
    )

    // Call the preload server on compilation
    config.plugins.push(
        new PreloadServer({
            webpackEnv: webpackEnv
        })
    )

    // In production, output path is specific to Timber/Twig
    if (webpackEnv === 'production') {
        config.output.publicPath = '';
    }

    // In Wordpress, we always have jQuery available
    config.externals = {
        jquery: 'jQuery'
    }

    return config
}

class SaveAssetsToDisk {

    constructor(options) {
        this.options = options
    }

    apply(compiler) {
        const options = this.options
        compiler.hooks.compilation.tap('SaveAssetsToDisk', (compilation, callback) => {
            var hooks = HtmlWebpackPlugin.getHooks(compilation);
            hooks.beforeAssetTagGeneration.tapAsync('MyPlugin', onBeforeHtmlGeneration);
            function onBeforeHtmlGeneration(htmlPluginData, callback) {
                const assetsManifestPath = options.pathRoot + '/' + options.name;
                console.log('[SaveAssetsToDisk] ' + htmlPluginData.assets.js);
                fs.writeFileSync(
                    assetsManifestPath,
                    JSON.stringify({
                        js: htmlPluginData.assets.js,
                        css: htmlPluginData.assets.css,
                    })
                );
                console.log(`[React-Timber] Wrote ${assetsManifestPath}`);
                callback();
            }
        })
    }
}

class PreloadServer {

    constructor(options) {
        this.options = options
    }

    apply(compiler) {
        compiler.hooks.done.tap('PreloadServer', (compilation, callback) => {
            try {
                createPreloadServer(this.options.webpackEnv);
            } catch (e) {
                console.error(e);
            }
        })
    }
}

function createPreloadServer(webpackEnv) {

    const preloadConfig = configFactory(webpackEnv, true);

    preloadConfig.entry = { preload: [paths.appPreloadJs] }

    // Limit to a single chunk
    preloadConfig.plugins.concat(
        new webpack.optimize.LimitChunkCountPlugin({
            maxChunks: 1,
        })
    );

    preloadConfig.optimization.minimize = false;
    preloadConfig.optimization.splitChunks = false;
    preloadConfig.optimization.runtimeChunk = false;

    // Remove our assetsToJson plugin
    preloadConfig.plugins.forEach(function (each, i) {
        if (each.assetsToJson) {
            preloadConfig.plugins.splice(i, 1);
        }
        if (each instanceof HtmlWebpackPlugin) {
            preloadConfig.plugins.splice(i, 1);
        }
    });

    preloadConfig.plugins.push(
        new webpack.IgnorePlugin(/jquery$/)
    );

    preloadConfig.output = {
        library: 'preloader',
        libraryTarget: 'umd',
        filename: 'preloader.js',
        publicPath: preloadConfig.output.publicPath
    };

    preloadConfig.target = 'node'
    preloadConfig.devtool = false

    // In Wordpress, we always have jQuery available
    preloadConfig.externals = {
        jquery: 'jQuery'
    }

    let preloadServer;

    try {
        preloadServer = webpack(preloadConfig);
    } catch (e) {
        console.error(e);
        return;
    }

    const mfs = new MemoryFS();
    preloadServer.outputFileSystem = mfs;

    preloadServer.run(function (err, stats) {

        if (err) {
            console.error(err);
            return;
        }

        const data = stats.toJson({
            assets: true
        });

        try {
            const src = stats.compilation.assets['preloader.js'].source()
            const mod = requireFromString(src, 'preloader.js');
            mod.default(console.error, function success(path) {
                console.log(`[React-Timber] Preloaded ${path}`);
            });

        } catch (e) {
            console.error(e);
        }
        if (err) {
            console.error(err);
        }
    });
}

function requireFromString(src, filename) {
    var Module = module.constructor;
    var m = new Module();
    m._compile(src, filename);
    return m.exports;
}