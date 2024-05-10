import crypto from 'crypto'
import esbuild from 'esbuild'
import fs from 'fs'
import path from 'path'
import { JSDOM } from 'jsdom'
import lodashTemplate from 'lodash/template'

export interface Configuration {
    files: HtmlFileConfiguration[],
}

export interface HtmlFileConfiguration {
    /** @param filename The name of the output HTML file (relative to the output directory) */
    filename: string,
    /** @param entryPoints The entry points to include in the HTML file. */
    entryPoints: string[],
    /** @param title The title of the HTML file. */
    title?: string,
    /** @param htmlTemplate A path to a custom HTML template to use. If not set, a default template will be used. */
    htmlTemplate?: string,
    /** @param define A map of variables that will be available in the HTML file. */
    define?: Record<string, string>,
    /** @param scriptLoading How to load the generated script tags: blocking, defer, or module. Defaults to defer. */
    scriptLoading?: 'blocking' | 'defer' | 'module',
    /** @param favicon A path to a favicon to use. */
    favicon?: string,
    /** @param findRelatedCssFiles Whether to find CSS files that are related to the entry points. */
    findRelatedCssFiles?: boolean,
    /**
     * @deprecated Use findRelatedCssFiles instead.
     * @param findRelatedOutputFiles Whether to find output files that are related to the entry points. */
    findRelatedOutputFiles?: boolean,
    /** @param inline Whether to inline the content of the js and css files. */
    inline?: boolean | {
        css?: boolean
        js?: boolean
    } | ((filepath: string) => boolean),
    /** @param extraScripts Extra script tags to include in the HTML file. */
    extraScripts?: (string | {
        src: string,
        attrs?: { [key: string]: string }
    })[],
    hash?: boolean | string,
}

const defaultHtmlTemplate = `
<!DOCTYPE html>
<html>
  <head>
    <meta charset="utf-8" />
  </head>
  <body>
  </body>
</html>
`

const REGEXES = {
    DIR_REGEX: '(?<dir>\\S+\\/?)',
    HASH_REGEX: '(?<hash>[A-Z2-7]{8})',
    NAME_REGEX: '(?<name>[^\\s\\/]+)',
}

// This function joins a path, and in case of windows, it converts backward slashes ('\') forward slashes ('/').
function posixJoin(...paths: string[]): string {
    const joined = path.join(...paths)
    if (path.sep === '/') {
        return joined
    }
    return joined.split(path.sep).join(path.posix.sep)
}

function escapeRegExp(text: string): string {
    return text.replace(/[-[\]{}()*+?.,\\^$|#\s]/g, '\\$&')
}


export const htmlPlugin = (configuration: Configuration = { files: [], }): esbuild.Plugin => {
    configuration.files = configuration.files.map((htmlFileConfiguration: HtmlFileConfiguration) => {
        return Object.assign({}, { findRelatedOutputFiles: false, findRelatedCssFiles: true }, htmlFileConfiguration) // Set default values
    })

    let logInfo = false

    function collectEntrypoints(htmlFileConfiguration: HtmlFileConfiguration, metafile?: esbuild.Metafile) {
        const entryPoints = Object.entries(metafile?.outputs || {}).filter(([, value]) => {
            if (!value.entryPoint) {
                return false
            }
            return htmlFileConfiguration.entryPoints.includes(value.entryPoint)
        }).map(outputData => {
            // Flatten the output, instead of returning an array, let's return an object that contains the path of the output file as path
            return { path: outputData[0], ...outputData[1] }
        })
        return entryPoints
    }

    function findNameRelatedOutputFiles(entrypoint: { path: string }, metafile?: esbuild.Metafile, entryNames?: string) {
        const pathOfMatchedOutput = path.parse(entrypoint.path)

        // Search for all files that are "related" to the output (.css and map files, for example files, as assets are dealt with otherwise).
        if (entryNames) {
            // If entryNames is set, the related output files are more difficult to find, as the filename can also contain a hash.
            // The hash could also be part of the path, which could make it even more difficult
            // We therefore try to extract the dir, name and hash from the "main"-output, and try to find all files with
            // the same [name] and [dir].
            // This should always include the "main"-output, as well as all relatedOutputs
            const joinedPathOfMatch = posixJoin(pathOfMatchedOutput.dir, pathOfMatchedOutput.name)
            const findVariablesRegexString = escapeRegExp(entryNames)
                .replace('\\[hash\\]', REGEXES.HASH_REGEX)
                .replace('\\[name\\]', REGEXES.NAME_REGEX)
                .replace('\\[dir\\]', REGEXES.DIR_REGEX)
            const findVariablesRegex = new RegExp(findVariablesRegexString)
            const match = findVariablesRegex.exec(joinedPathOfMatch)

            const name = match?.groups?.['name']
            const dir = match?.groups?.['dir']

            return Object.entries(metafile?.outputs || {}).filter(([pathOfCurrentOutput,]) => {
                if (entryNames) {
                    // if a entryName is set, we need to parse the output filename, get the name and dir,
                    // and find files that match the same criteria
                    const findFilesWithSameVariablesRegexString = escapeRegExp(entryNames.replace('[name]', name ?? '').replace('[dir]', dir ?? ''))
                        .replace('\\[hash\\]', REGEXES.HASH_REGEX)
                    const findFilesWithSameVariablesRegex = new RegExp(findFilesWithSameVariablesRegexString)
                    return findFilesWithSameVariablesRegex.test(pathOfCurrentOutput)
                }
            }).map(outputData => {
                // Flatten the output, instead of returning an array, let's return an object that contains the path of the output file as path
                return { path: outputData[0], ...outputData[1] }
            })
        } else {
            // If entryNames is not set, the related files are always next to the "main" output, and have the same filename, but the extension differs
            return Object.entries(metafile?.outputs || {}).filter(([key,]) => {
                return path.parse(key).name === pathOfMatchedOutput.name && path.parse(key).dir === pathOfMatchedOutput.dir
            }).map(outputData => {
                // Flatten the output, instead of returning an array, let's return an object that contains the path of the output file as path
                return { path: outputData[0], ...outputData[1] }
            })
        }
    }

    async function renderTemplate({ htmlTemplate, define }: HtmlFileConfiguration) {
        const customHtmlTemplate = (htmlTemplate && fs.existsSync(htmlTemplate)
            ? await fs.promises.readFile(htmlTemplate)
            : htmlTemplate || '').toString()

        const template = customHtmlTemplate || defaultHtmlTemplate

        if (define === undefined) {
            return template
        } else {
            const compiledTemplateFn = lodashTemplate(template)
            return compiledTemplateFn({ define })
        }
    }

    // use the same joinWithPublicPath function as esbuild:
    //  https://github.com/evanw/esbuild/blob/a1ff9d144cdb8d50ea2fa79a1d11f43d5bd5e2d8/internal/bundler/bundler.go#L533
    function joinWithPublicPath(publicPath: string, relPath: string) {
        relPath = path.normalize(relPath)

        if (!publicPath) {
            publicPath = '.'
        }

        let slash = '/'
        if (publicPath.endsWith('/')) {
            slash = ''
        }
        return `${publicPath}${slash}${relPath}`
    }

    async function injectFiles(dom: JSDOM, assets: { path: string }[], outDir: string, publicPath: string | undefined, htmlFileConfiguration: HtmlFileConfiguration) {
        const document = dom.window.document
        for (const script of htmlFileConfiguration?.extraScripts || []) {
            const scriptTag = document.createElement('script')
            if (typeof script === 'string') {
                scriptTag.setAttribute('src', script)
            } else {
                scriptTag.setAttribute('src', script.src)
                Object.entries(script.attrs || {}).forEach(([key, value]) => {
                    scriptTag.setAttribute(key, value)
                })
            }
            document.body.append(scriptTag)
        }
        for (const outputFile of assets) {
            const filepath = outputFile.path

            let targetPath: string
            if (publicPath) {
                targetPath = joinWithPublicPath(publicPath, path.relative(outDir, filepath))
            } else {
                const htmlFileDirectory = posixJoin(outDir, htmlFileConfiguration.filename)
                targetPath = path.relative(path.dirname(htmlFileDirectory), filepath)
            }
            if (htmlFileConfiguration.hash) {
                const hashableContents = htmlFileConfiguration.hash === true ? `${Date.now()}` : htmlFileConfiguration.hash
                targetPath = `${targetPath}?${crypto.createHash('md5').update(hashableContents).digest('hex')}`
            }
            const ext = path.parse(filepath).ext

            // Inline the JavaScript and CSS files if the option is set.
            const { inline } = htmlFileConfiguration

            const isInline = () => {
                if (!inline) {
                    return false
                }
                const extension = ext.replace('.', '') as 'css' | 'js'
                return (
                    (typeof inline === 'boolean' && inline === true) ||
                    (typeof inline === 'object' && inline[extension] === true) ||
                    (typeof inline === 'function' && inline(filepath))
                )
            }

            if (ext === '.js') {
                const scriptTag = document.createElement('script')
                // Check if the JavaScript should be inlined.
                if (isInline()) {
                    logInfo && console.log('Inlining script', filepath)
                    // Read the content of the JavaScript file, then append to the script tag
                    const scriptContent = await fs.promises.readFile(
                        filepath,
                        'utf-8'
                    )
                    scriptTag.textContent = scriptContent
                    document.body.append(scriptTag)

                    // no need to set any attributes
                    continue
                }

                // If not inlined, set the 'src' attribute as usual.
                scriptTag.setAttribute('src', targetPath)

                if (htmlFileConfiguration.scriptLoading === 'module') {
                    // If module, add type="module"
                    scriptTag.setAttribute('type', 'module')
                } else if (!htmlFileConfiguration.scriptLoading || htmlFileConfiguration.scriptLoading === 'defer') {
                    // if scriptLoading is unset, or defer, use defer
                    scriptTag.setAttribute('defer', '')
                }

                document.body.append(scriptTag)
            } else if (ext === '.css') {
                // Check if the CSS should be inlined -> if so, use style tags instead of link tags.
                if (isInline()) {
                    const styleTag = document.createElement('style')
                    const styleContent = await fs.promises.readFile(
                        filepath,
                        'utf-8'
                    )
                    styleTag.textContent = styleContent
                    document.head.append(styleTag)

                    // no need to set any attributes
                    continue
                }

                const linkTag = document.createElement('link')
                linkTag.setAttribute('rel', 'stylesheet')
                linkTag.setAttribute('href', targetPath)
                document.head.appendChild(linkTag)
            } else {
                logInfo && console.log(`Warning: found file ${targetPath}, but it was neither .js nor .css`)
            }
        }
    }

    return {
        name: 'esbuild-html-plugin',
        setup(build) {
            build.onStart(() => {
                if (!build.initialOptions.metafile) {
                    throw new Error('metafile is not enabled')
                }
                if (!build.initialOptions.outdir) {
                    throw new Error('outdir must be set')
                }
            })
            build.onEnd(async result => {
                const startTime = Date.now()
                if (build.initialOptions.logLevel == 'debug' || build.initialOptions.logLevel == 'info') {
                    logInfo = true
                }
                logInfo && console.log()


                for (const htmlFileConfiguration of configuration.files) {
                    // First, search for outputs with the configured entryPoints
                    const collectedEntrypoints = collectEntrypoints(htmlFileConfiguration, result.metafile)

                    // All output files relevant for this html file
                    let collectedOutputFiles: (esbuild.Metafile['outputs'][string] & { path: string })[] = []

                    for (const entrypoint of collectedEntrypoints) {
                        if (!entrypoint) {
                            throw new Error(`Found no match for ${htmlFileConfiguration.entryPoints}`)
                        }
                        const relatedOutputFiles = new Map()
                        relatedOutputFiles.set(entrypoint.path, entrypoint)
                        if (htmlFileConfiguration.findRelatedCssFiles) {
                            if (entrypoint?.cssBundle) {
                                relatedOutputFiles.set(entrypoint.cssBundle, { path: entrypoint?.cssBundle })
                            }
                        }
                        if (htmlFileConfiguration.findRelatedOutputFiles) {
                            findNameRelatedOutputFiles(entrypoint, result.metafile, build.initialOptions.entryNames).forEach((item) => {
                                relatedOutputFiles.set(item.path, item)
                            })
                        }

                        collectedOutputFiles = [...collectedOutputFiles, ...relatedOutputFiles.values()]
                    }
                    // Note: we can safely disable this rule here, as we already asserted this in setup.onStart
                    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
                    const outdir = build.initialOptions.outdir!

                    const publicPath = build.initialOptions.publicPath

                    const templatingResult = await renderTemplate(htmlFileConfiguration)

                    // Next, we insert the found files into the htmlTemplate - if no htmlTemplate was specified, we default to a basic one.
                    const dom = new JSDOM(templatingResult)
                    const document = dom.window.document

                    if (htmlFileConfiguration.title) {
                        // If a title was given, we pass the title as well
                        document.title = htmlFileConfiguration.title
                    }

                    if (htmlFileConfiguration.favicon) {
                        // Injects a favicon if present
                        await fs.promises.copyFile(htmlFileConfiguration.favicon, `${outdir}/favicon.ico`)

                        const linkTag = document.createElement('link')
                        linkTag.setAttribute('rel', 'icon')

                        let faviconPublicPath = '/favicon.ico'
                        if (publicPath) {
                            faviconPublicPath = joinWithPublicPath(publicPath, 'favicon.ico')
                        }
                        linkTag.setAttribute('href', faviconPublicPath)
                        document.head.appendChild(linkTag)
                    }

                    await injectFiles(dom, collectedOutputFiles, outdir, publicPath, htmlFileConfiguration)

                    const out = posixJoin(outdir, htmlFileConfiguration.filename)
                    await fs.promises.mkdir(path.dirname(out), {
                        recursive: true,
                    })
                    await fs.promises.writeFile(out, dom.serialize())
                    const stat = await fs.promises.stat(out)
                    logInfo && console.log(`  ${out} - ${stat.size}`)
                }
                logInfo && console.log(`  HTML Plugin Done in ${Date.now() - startTime}ms`)
            })
        }
    }
}
