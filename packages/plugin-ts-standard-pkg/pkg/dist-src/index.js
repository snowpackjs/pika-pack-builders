import path from 'path';
import fs from 'fs';
import execa from 'execa';
import { MessageError } from '@pika/types';
import { Lint } from 'standard-pkg';
import * as tsc from 'typescript';
function formatTscParserErrors(errors) {
    return errors.map(s => JSON.stringify(s, null, 4)).join('\n');
}
function readCompilerOptions(configPath) {
    // First step: Let tsc pick up the config.
    const loaded = tsc.readConfigFile(configPath, file => {
        const read = tsc.sys.readFile(file);
        // See https://github.com/Microsoft/TypeScript/blob/a757e8428410c2196886776785c16f8f0c2a62d9/src/compiler/sys.ts#L203 :
        // `readFile` returns `undefined` in case the file does not exist!
        if (!read) {
            throw new Error(`ENOENT: no such file or directory, open '${configPath}'`);
        }
        return read;
    });
    // In case of an error, we cannot go further - the config is malformed.
    if (loaded.error) {
        throw new Error(JSON.stringify(loaded.error, null, 4));
    }
    // Second step: Parse the config, resolving all potential references.
    const basePath = path.dirname(configPath); // equal to "getDirectoryPath" from ts, at least in our case.
    const parsedConfig = tsc.parseJsonConfigFileContent(loaded.config, tsc.sys, basePath);
    // In case the config is present, it already contains possibly merged entries from following the
    // 'extends' entry, thus it is not required to follow it manually.
    // This procedure does NOT throw, but generates a list of errors that can/should be evaluated.
    if (parsedConfig.errors.length > 0) {
        const formattedErrors = formatTscParserErrors(parsedConfig.errors);
        throw new Error(`Some errors occurred while attempting to read from ${configPath}: ${formattedErrors}`);
    }
    return parsedConfig.options;
}
function getTsConfigPath(options, cwd) {
    return path.resolve(cwd, options.tsconfig || 'tsconfig.json');
}
function getTscBin(cwd) {
    try {
        return require.resolve('typescript/bin/tsc', { paths: [cwd] });
    }
    catch (err) {
        // ignore err
        return null;
    }
}
export async function beforeBuild({ cwd, options, reporter }) {
    if (!getTscBin(cwd)) {
        throw new MessageError('"tsc" executable not found. Make sure "typescript" is installed as a project dependency.');
    }
    const tsConfigPath = getTsConfigPath(options, cwd);
    if (!fs.existsSync(tsConfigPath)) {
        throw new MessageError('"tsconfig.json" manifest not found.');
    }
    const tsConfig = readCompilerOptions(tsConfigPath);
    const { target, module: mod } = tsConfig;
    if (target !== tsc.ScriptTarget.ES2019) {
        const _target = tsc.ScriptTarget[target] || '';
        reporter.warning(`tsconfig.json [compilerOptions.target] should be "es2019", but found "${_target ? _target.toLowerCase() : target}". You may encounter problems building.`);
    }
    if (mod !== tsc.ModuleKind.ESNext) {
        const _mod = tsc.ModuleKind[mod] || '';
        reporter.warning(`tsconfig.json [compilerOptions.module] should be "esnext", but found "${_mod ? _mod.toLowerCase() : mod}". You may encounter problems building.`);
    }
}
export async function beforeJob({ cwd }) {
    const srcDirectory = path.join(cwd, 'src/');
    if (!fs.existsSync(srcDirectory)) {
        throw new MessageError('@pika/pack expects a standard package format, where package source must live in "src/".');
    }
    if (!fs.existsSync(path.join(cwd, 'src/index.ts')) && !fs.existsSync(path.join(cwd, 'src/index.tsx'))) {
        throw new MessageError('@pika/pack expects a standard package format, where the package entrypoint must live at "src/index".');
    }
}
export async function afterJob({ out, reporter }) {
    reporter.info('Linting with standard-pkg...');
    const linter = new Lint(path.join(out, 'dist-src'), { ignoreExtensions: true });
    await linter.init();
    linter.summary();
}
export function manifest(newManifest) {
    newManifest.source = newManifest.source || 'dist-src/index.js';
    newManifest.types = newManifest.types || 'dist-types/index.d.ts';
    return newManifest;
}
export async function build({ cwd, out, options, reporter }) {
    const additionalArgs = options.args || [];
    await execa(getTscBin(cwd), [
        '--outDir',
        path.join(out, 'dist-src/'),
        '-d',
        '--declarationDir',
        path.join(out, 'dist-types/'),
        '--project',
        getTsConfigPath(options, cwd),
        '--target',
        'es2019',
        '--module',
        'esnext',
        '--noEmit',
        'false',
        ...additionalArgs,
    ], { cwd });
    reporter.created(path.join(out, 'dist-src', 'index.js'), 'esnext');
    reporter.created(path.join(out, 'dist-types', 'index.d.ts'), 'types');
}
