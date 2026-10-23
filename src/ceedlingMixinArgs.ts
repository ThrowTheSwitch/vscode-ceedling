// Wraps a token in double quotes when it contains whitespace, so a path with spaces - routinely
// true of a Windows install path or the OS temp directory - survives being joined into a single
// shell command string by execCeedling. Every other value here is passed through unquoted, same
// as the literal flags around it. Exported: execCeedling's dumpconfig output path needs the same
// treatment and isn't a --mixin flag itself.
export function quoteIfNeeded(token: string): string {
    return /\s/.test(token) ? `"${token}"` : token;
}

// Builds the --project/--mixin flags common to every Ceedling invocation for a project, in
// Ceedling's own priority order: a later --mixin flag outranks an earlier one, and a mixin's
// lists merge by prepending onto the existing list, not replacing it. Lowest to highest
// priority: the project's own alternate-yml convention (ceedlingExplorer.projects[].path
// pointing at a non-default yml file), the user's configured mixins
// (ceedlingExplorer.mixins/projects[].mixins, already resolved into one ordered list by the
// caller), then the extension's own report-plugin mixin, always last so it always wins.
export function buildProjectArgs(ymlFileName: string, userMixins: readonly string[], bundledMixinPath: string): string[] {
    const args = ['--project', 'project.yml'];
    if (ymlFileName !== 'project.yml') {
        args.push('--mixin', quoteIfNeeded(ymlFileName));
    }
    for (const mixin of userMixins) {
        args.push('--mixin', quoteIfNeeded(mixin));
    }
    args.push('--mixin', quoteIfNeeded(bundledMixinPath));
    return args;
}
